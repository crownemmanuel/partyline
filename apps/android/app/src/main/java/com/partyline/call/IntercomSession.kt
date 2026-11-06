package com.partyline.call

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.ConnectivityManager
import android.net.Network
import android.os.BatteryManager
import android.os.SystemClock
import android.util.Log
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ProcessLifecycleOwner
import com.partyline.BuildConfig
import com.partyline.audio.RoomController
import com.partyline.discovery.NsdDiscovery
import com.partyline.model.Device
import com.partyline.model.Message
import com.partyline.model.MessageAck
import com.partyline.model.MessageSend
import com.partyline.model.ProtocolCodec
import com.partyline.model.RoutingEngine
import com.partyline.model.ServerEvent
import com.partyline.model.SessionRequest
import com.partyline.model.SessionResponse
import com.partyline.model.SignalSend
import com.partyline.model.StateSet
import com.partyline.model.StatusPayload
import com.partyline.model.TalkMode
import com.partyline.model.Targets
import com.partyline.net.ApiException
import com.partyline.net.ControlSocket
import com.partyline.net.Endpoint
import com.partyline.audio.RtcRetry
import com.partyline.audio.VoiceIsolation
import com.partyline.net.PinMismatchException
import com.partyline.net.PinnedHttp
import com.partyline.net.ServerClient
import com.partyline.notify.Cues
import com.partyline.notify.MessageNotifier
import com.partyline.store.SavedServer
import com.partyline.store.SecureStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.util.concurrent.TimeUnit

/**
 * One intercom session: control WebSocket + LiveKit room + routing + status, from `welcome`
 * until leave/kick. Lives inside [IntercomService]; all methods run on the main thread.
 */
class IntercomSession(
    private val context: Context,
    private val scope: CoroutineScope,
    private val store: SecureStore,
    server: SavedServer,
    private val initial: SessionResponse?,
    telecomManagesAudio: Boolean,
    private val onEnded: (EndReason) -> Unit,
) {
    private val pin: String = store.pinnedFingerprint(server.serverId)
        ?: throw IllegalStateException("No pinned certificate for ${server.serverId}")
    private val serverId = server.serverId
    private var endpoint = Endpoint(server.host, server.port)

    // Read timeout 0: the WS liveness check is our own ping/pong; LiveKit signaling has its own.
    private val http = PinnedHttp.client(pin).newBuilder().readTimeout(0, TimeUnit.MILLISECONDS).build()

    private val _state = MutableStateFlow(
        SessionState(serverName = server.name, myId = store.deviceId, usingTelecom = telecomManagesAudio, localTalkMode = store.talkMode ?: TalkMode.PTT),
    )
    val state: StateFlow<SessionState> = _state

    private val socket = ControlSocket(scope, { endpoint to http }, { store.deviceToken }, BuildConfig.VERSION_NAME)
    // Before the room: the mic track's capture options depend on it.
    init { VoiceIsolation.setEnabled(store.voiceIsolation) }

    private val room = RoomController(context, scope, http, telecomManagesAudio, ::onRoomEvent)
    private val cues = Cues(context)
    private val notifier = MessageNotifier(context)

    private var livekitToken: String? = initial?.livekitToken
    private var livekitPath: String = initial?.livekitUrl ?: "/rtc"
    private var welcomeCount = 0
    private var everLive = false

    /** "Reply to producer" override of my talkTargets while held and until the restore is acked. */
    private var localTalkTargets: List<String>? = null
    private var savedTalkTargets: List<String>? = null
    private var restoreTargetsId: String? = null

    private val localMute = mutableMapOf<String, Boolean>()
    private val localVolume = mutableMapOf<String, Double>()
    private var lastSystemMute: Boolean? = null

    private var rediscovery: Job? = null
    private var rtcConnecting = false
    /** Due retries ask for a fresh token; `token.refreshed` then calls connectRoomIfNeeded. */
    private val rtcRetry = RtcRetry(scope) { if (_state.value.phase != Phase.ENDED) sendEmpty("token.refresh") }
    private var lastSeenOnMdns = 0L
    private var disconnectedSince = 0L

    private var battery: Int? = null
    private var charging: Boolean? = null
    private var lastStatus: StatusPayload? = null
    private var lastStatusAt = 0L
    private var pendingStatus: Job? = null

    private val batteryReceiver = object : android.content.BroadcastReceiver() {
        override fun onReceive(c: Context, i: Intent) = onBattery(i)
    }

    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            scope.launch { socket.retryNow() }
        }
    }

    fun start() {
        initial?.let { applySessionResponse(it) }
        context.registerReceiver(batteryReceiver, IntentFilter(Intent.ACTION_BATTERY_CHANGED))?.let { onBattery(it) }
        runCatching {
            context.getSystemService(ConnectivityManager::class.java).registerDefaultNetworkCallback(networkCallback)
        }
        store.sessionActive = true

        scope.launch { socket.events.collect { onServerEvent(it) } }
        scope.launch { socket.state.collect { onSocketState(it) } }
        scope.launch { socket.failures.collect { if (it >= 2) startRediscovery() } }
        scope.launch { room.conn.collect { c -> _state.update { it.copy(rtcConnected = c == RoomController.Conn.CONNECTED) }; reportStatus() } }
        scope.launch { room.localSpeaking.collect { reportStatus() } }
        scope.launch { room.speakers.collect { updateTalking() } }
        // Safety net: re-apply routing every 2 s while audio is up, so a missed or reordered SDK
        // event can never leave a remote track at its initial (silent) state.
        scope.launch {
            while (true) {
                kotlinx.coroutines.delay(ROUTING_RECONCILE_MS)
                if (room.conn.value == RoomController.Conn.CONNECTED) recomputeRouting()
            }
        }
        scope.launch { room.route.collect { r -> if (!_state.value.usingTelecom) setRoute(r) } }
        scope.launch { socket.rttMs.collect { reportStatus() } }
        scope.launch { watchdog() }

        scope.launch {
            if (initial == null) refreshSession()
            socket.start()
        }
    }

    /** POST /api/session on launch (§6.1). Network errors are fine: the WS loop keeps trying. */
    private suspend fun refreshSession() {
        val token = store.deviceToken ?: return end(EndReason.REVOKED)
        try {
            applySessionResponse(ServerClient(endpoint, http).session(token, SessionRequest(BuildConfig.VERSION_NAME)))
        } catch (e: ApiException) {
            if (e.code == "revoked" || e.code == "invalid_token") end(EndReason.REVOKED)
            else _state.update { it.copy(lastError = e.message) }
        } catch (e: Exception) {
            if (generateSequence<Throwable>(e) { it.cause }.any { it is PinMismatchException }) return end(EndReason.CERT_CHANGED)
            Log.w(TAG, "session refresh failed: ${e.message}")
        }
    }

    private fun applySessionResponse(r: SessionResponse) {
        livekitToken = r.livekitToken
        livekitPath = r.livekitUrl
        _state.update { s -> s.copy(myId = r.me.id, roster = s.roster + (r.me.id to r.me), groups = r.groups.ifEmpty { s.groups }) }
    }

    // ---------------------------------------------------------------- server events

    private fun onServerEvent(e: ServerEvent) {
        when (e) {
            is ServerEvent.WelcomeEvent -> onWelcome(e)
            is ServerEvent.DeviceUpsert -> {
                val d = e.device
                val wasAdminMuted = _state.value.adminMuted
                _state.update { it.copy(roster = it.roster + (d.id to d)) }
                if (d.id == _state.value.myId) onMyDeviceChanged(wasAdminMuted)
                recomputeRouting()
            }
            is ServerEvent.DeviceRemovedEvent -> {
                _state.update { it.copy(roster = it.roster - e.deviceId) }
                recomputeRouting()
            }
            is ServerEvent.GroupsUpdatedEvent -> { _state.update { it.copy(groups = e.groups) }; recomputeRouting() }
            is ServerEvent.ServerUpdated -> _state.update { it.copy(server = e.server, serverName = e.server.name.ifEmpty { it.serverName }) }
            is ServerEvent.SettingsUpdated -> { _state.update { it.copy(settings = e.settings) }; recomputeRouting() }
            is ServerEvent.MessageEvent -> onMessage(e.message, notify = true)
            is ServerEvent.Signal -> onSignal(e.from)
            is ServerEvent.TokenRefreshedEvent -> {
                livekitToken = e.livekitToken
                connectRoomIfNeeded()
            }
            is ServerEvent.AdminNoticeEvent -> {
                _state.update { it.copy(notice = e.notice.text) }
                if (!inForeground()) notifier.showNotice(e.notice.text)
                cues.message()
            }
            is ServerEvent.KickedEvent -> end(EndReason.KICKED)
            is ServerEvent.ShutdownEvent -> socket.reconnectAfter(e.reconnectAfterMs)
            is ServerEvent.Ack -> if (e.replyTo == restoreTargetsId) clearTargetOverride()
            is ServerEvent.Error -> {
                if (e.replyTo != null && e.replyTo == restoreTargetsId) clearTargetOverride()
                // Renewal (~26 months) or a SAN/IP change: stop retrying and let the UI ask again (§ proposed 4).
                if (e.code == "pin_mismatch") end(EndReason.CERT_CHANGED)
                else Log.w(TAG, "server error ${e.code}: ${e.message}")
            }
            is ServerEvent.MessageAckedEvent, ServerEvent.Pong, is ServerEvent.Unknown -> Unit
        }
    }

    private fun onWelcome(e: ServerEvent.WelcomeEvent) {
        val w = e.welcome
        welcomeCount++
        val roster = (w.devices + w.me).associateBy { it.id }
        val known = _state.value.messages.map { it.id }.toSet()
        val first = welcomeCount == 1 && _state.value.messages.isEmpty()
        localTalkTargets = null
        _state.update { s ->
            s.copy(
                myId = w.me.id,
                roster = roster,
                groups = w.groups,
                settings = w.settings,
                server = w.server ?: s.server,
                serverName = w.server?.name?.ifEmpty { null } ?: s.serverName,
                messages = w.messages,
                unreadIds = s.unreadIds.filter { id -> w.messages.any { it.id == id } }.toSet(),
                lastError = null,
            )
        }
        // Messages that arrived while we were offline (not on the very first welcome).
        if (!first) w.messages.filter { it.id !in known }.forEach { onMessage(it, notify = true, alreadyListed = true) }

        w.livekitToken?.let { livekitToken = it }
        val s = _state.value
        val mode = s.me?.forcedTalkMode ?: store.talkMode ?: s.myGroup?.defaultTalkMode ?: w.settings.defaultTalkMode
        _state.update { it.copy(localTalkMode = mode) }
        // The server's copy of my live state is reset on reconnect; re-assert ours (§6.2).
        val micLive = s.micLive && s.canTalk
        if (!micLive && s.micLive) setMic(false, send = false)
        send("state.set", StateSet(talkMode = mode, micLive = micLive, speakerMuted = s.speakerMuted))
        recomputeRouting()
        // A fresh welcome carries a fresh token: try at once (failures keep counting).
        rtcRetry.cancel()
        connectRoomIfNeeded()
        // The host starts my live state blank after every (re)connect: always resend status.
        lastStatus = null
        reportStatus(force = true)
    }

    private fun onMyDeviceChanged(wasAdminMuted: Boolean) {
        val s = _state.value
        if (s.adminMuted && s.micLive) setMic(false)
        if (s.adminMuted != wasAdminMuted) cues.message()
        if (s.forcedPtt && s.talkMode == TalkMode.PTT && s.micLive && !s.replyHeld) setMic(false)
        if (localTalkTargets != null && restoreTargetsId == null && !s.replyHeld) localTalkTargets = null
    }

    private fun onMessage(m: Message, notify: Boolean, alreadyListed: Boolean = false) {
        val s = _state.value
        if (!alreadyListed && s.messages.any { it.id == m.id }) return
        val mine = m.from == s.myId
        // Seen at once if the panel is open; otherwise unread and queued as a pop-up card.
        val seen = mine || s.panelOpen
        _state.update {
            it.copy(
                messages = if (alreadyListed) it.messages else (it.messages + m).takeLast(200),
                unreadIds = if (seen) it.unreadIds else it.unreadIds + m.id,
                popupQueue = if (seen || !notify) it.popupQueue else it.popupQueue + m.id,
            )
        }
        if (!mine && s.panelOpen) send("message.ack", MessageAck(m.id))
        if (mine || !notify) return
        cues.message()
        val from = nameOf(m.from)
        if (!inForeground()) notifier.showMessage(m, from, targetLabel(m.to))
        if (store.textToSpeech) notifier.speak("$from: ${m.text}")
    }

    private fun onSignal(from: String) {
        cues.signal()
        _state.update { it.copy(notice = "${nameOf(from)} is calling you") }
        if (!inForeground()) notifier.showSignal(nameOf(from))
    }

    // ---------------------------------------------------------------- connection state

    private fun onSocketState(st: ControlSocket.State) {
        val prev = _state.value.phase
        val phase = when (st) {
            ControlSocket.State.Connected -> Phase.LIVE
            is ControlSocket.State.Connecting, is ControlSocket.State.Waiting -> if (everLive) Phase.RECONNECTING else Phase.CONNECTING
            ControlSocket.State.Idle -> prev
        }
        if (prev == Phase.ENDED) return
        if (phase == Phase.LIVE) {
            disconnectedSince = 0
            if (prev == Phase.RECONNECTING) cues.reconnected()
            everLive = true
            lastStatus = null
            rediscovery?.cancel(); rediscovery = null
        } else if (prev == Phase.LIVE) {
            disconnectedSince = SystemClock.elapsedRealtime()
            cues.disconnected()
        } else if (disconnectedSince == 0L) {
            disconnectedSince = SystemClock.elapsedRealtime()
        }
        val err = (st as? ControlSocket.State.Waiting)?.lastError
        _state.update { it.copy(phase = phase, lastError = if (phase == Phase.LIVE) null else err ?: it.lastError) }
        if (phase == Phase.LIVE) reportStatus(force = true)
    }

    /** NSD lookup of our server id while the WS cannot connect: the host may have a new IP (§6.6). */
    private fun startRediscovery() {
        if (rediscovery?.isActive == true) return
        rediscovery = scope.launch {
            NsdDiscovery(context).servers().collect { list ->
                val me = list.firstOrNull { it.serverId == serverId } ?: return@collect
                lastSeenOnMdns = SystemClock.elapsedRealtime()
                if (me.host != endpoint.host || me.port != endpoint.port) {
                    Log.i(TAG, "Server moved to ${me.host}:${me.port}")
                    endpoint = Endpoint(me.host, me.port)
                    store.server = SavedServer(serverId, me.name, me.host, me.port)
                    socket.retryNow()
                }
            }
        }
    }

    private suspend fun watchdog() {
        while (scope.isActive) {
            delay(5_000)
            val s = _state.value
            if (s.phase == Phase.ENDED) return
            val now = SystemClock.elapsedRealtime()
            val offline = s.phase != Phase.LIVE && disconnectedSince > 0 &&
                now - maxOf(disconnectedSince, lastSeenOnMdns) > 60_000
            if (offline != s.serverOffline) _state.update { it.copy(serverOffline = offline) }
            // WS up but media down (e.g. LiveKit token expired while offline): get a new token.
            if (s.phase == Phase.LIVE && room.conn.value == RoomController.Conn.DISCONNECTED) {
                sendEmpty("token.refresh")
            }
            reportStatus()
        }
    }

    /** Connects now unless a connect is running or a backoff wait is pending ([rtcRetry]). */
    private fun connectRoomIfNeeded() {
        val token = livekitToken ?: return
        if (rtcConnecting || rtcRetry.waiting) return
        if (room.conn.value != RoomController.Conn.DISCONNECTED) return
        if (_state.value.phase == Phase.ENDED) return
        rtcConnecting = true
        scope.launch {
            try {
                room.connect(endpoint.livekitUrl(livekitPath), token)
                rtcRetry.succeeded()
                _state.update { it.copy(audioUnreachable = false) }
                room.setMicLive(_state.value.micLive)
                recomputeRouting()
            } catch (e: Throwable) {
                rtcRetry.failed()
                Log.w(TAG, "LiveKit connect failed (${rtcRetry.failures} in a row): ${e.message}")
                _state.update { it.copy(lastError = "Audio: ${e.message}", audioUnreachable = rtcRetry.unreachable) }
            } finally {
                rtcConnecting = false
            }
        }
    }

    private fun onRoomEvent(e: RoomController.Event) {
        when (e) {
            is RoomController.Event.Disconnected -> {
                // A failed connect also lands here; connectRoomIfNeeded schedules that retry itself.
                if (!rtcConnecting && _state.value.phase != Phase.ENDED) rtcRetry.schedule()
                reportStatus(force = true)
            }
            RoomController.Event.TracksChanged -> recomputeRouting()
            RoomController.Event.Connected, RoomController.Event.Reconnected -> { recomputeRouting(); reportStatus(force = true) }
            else -> reportStatus(force = true)
        }
    }

    // ---------------------------------------------------------------- routing

    private fun effectiveRoster(): Map<String, Device> {
        val s = _state.value
        val me = s.me ?: return s.roster
        val live = me.live.copy(
            talkTargets = localTalkTargets ?: me.live.talkTargets,
            speakerMuted = s.speakerMuted,
            micLive = s.micLive,
        )
        return s.roster + (me.id to me.copy(live = live))
    }

    private fun recomputeRouting() {
        val s = _state.value
        val result = RoutingEngine.compute(s.myId, effectiveRoster(), s.settings, room.remoteIdentities, localMute, localVolume)
        room.apply(result)
        updateTalking(result)
    }

    private fun updateTalking(result: RoutingEngine.Result? = null) {
        val s = _state.value
        val r = result ?: RoutingEngine.compute(s.myId, effectiveRoster(), s.settings, room.remoteIdentities, localMute, localVolume)
        val names = RoutingEngine.talkingNames(s.roster, r.audible, room.speakers.value)
        if (names != s.talking) _state.update { it.copy(talking = names) }
    }

    // ---------------------------------------------------------------- actions

    /** Main talk button pressed (PTT) or tapped (latch). */
    fun talkPressed() {
        val s = _state.value
        if (s.talkMode == TalkMode.LATCH) setMic(!s.micLive) else setMic(true)
    }

    /** Tap-to-talk from the live notification (like the headset button): toggles the mic. */
    fun toggleTalk() {
        val s = _state.value
        if (s.micLive) { setMic(false); return }
        if (s.hardMuted) setHardMute(false)
        setMic(true)
    }

    /** Inline reply from the live notification: to the latest message's sender by the reply rules, else the producer. */
    fun replyFromLiveNotification(text: String) {
        if (text.isBlank()) return
        val s = _state.value
        val latest = s.messages.lastOrNull { it.from != s.myId }
        val to = latest?.let { replyTargetFor(it) }
            ?: RoutingEngine.replyTarget(s.myId, s.roster) ?: s.me?.groupId?.let { Targets.group(it) } ?: return
        sendMessage(to, text.trim())
        latest?.let { markRead(listOf(it.id)) }
    }

    fun talkReleased() {
        if (_state.value.talkMode == TalkMode.PTT) setMic(false)
    }

    /** PTT rule (§6.3): unmute locally and send state.set together; never wait for the ack. */
    fun setMic(live: Boolean, send: Boolean = true) {
        val s = _state.value
        if (live && !s.canTalk) return
        if (s.micLive == live) return
        room.setMicLive(live)
        _state.update { it.copy(micLive = live) }
        if (send) send("state.set", StateSet(micLive = live))
        reportStatus()
    }

    fun setHardMute(muted: Boolean) {
        if (muted) setMic(false)
        _state.update { it.copy(hardMuted = muted) }
    }

    fun toggleHardMute() = setHardMute(!_state.value.hardMuted)

    fun setSpeakerMuted(muted: Boolean) {
        _state.update { it.copy(speakerMuted = muted) }
        send("state.set", StateSet(speakerMuted = muted))
        recomputeRouting()
    }

    fun toggleSpeaker() = setSpeakerMuted(!_state.value.speakerMuted)

    /** Local only: remembered per device and applied to the live mic at once. */
    fun setVoiceIsolation(on: Boolean) {
        store.voiceIsolation = on
        VoiceIsolation.setEnabled(on)
    }

    fun setTalkMode(mode: TalkMode) {
        store.talkMode = mode
        _state.update { it.copy(localTalkMode = mode) }
        if (_state.value.micLive && mode == TalkMode.PTT) setMic(false)
        send("state.set", StateSet(talkMode = mode))
    }

    /** Hold "Reply to producer" (§6.4): talkTargets = [d:<first online admin>] while held. */
    fun replyPressed(): Boolean {
        val s = _state.value
        if (!s.canTalk || s.replyHeld) return false
        val target = RoutingEngine.replyTarget(s.myId, s.roster) ?: run {
            _state.update { it.copy(notice = "No producer online") }
            return false
        }
        savedTalkTargets = s.me?.live?.talkTargets ?: emptyList()
        localTalkTargets = listOf(target)
        restoreTargetsId = null
        _state.update { it.copy(replyHeld = true) }
        recomputeRouting()
        room.setMicLive(true)
        _state.update { it.copy(micLive = true) }
        send("state.set", StateSet(talkTargets = listOf(target), micLive = true))
        reportStatus()
        return true
    }

    fun replyReleased() {
        if (!_state.value.replyHeld) return
        val restore = savedTalkTargets ?: emptyList()
        room.setMicLive(false)
        localTalkTargets = restore
        _state.update { it.copy(replyHeld = false, micLive = false) }
        val id = socket.nextId()
        restoreTargetsId = id
        send("state.set", StateSet(talkTargets = restore, micLive = false), id)
        recomputeRouting()
        reportStatus()
    }

    private fun clearTargetOverride() {
        restoreTargetsId = null
        savedTalkTargets = null
        localTalkTargets = null
        recomputeRouting()
    }

    fun sendMessage(to: String, text: String, kind: String = "text") {
        send("message.send", MessageSend(to = to, text = text.take(500), kind = kind))
    }

    /** Quick reply goes to the producer when one is online, else to my own group. */
    fun sendQuick(text: String, replyToMessageId: String? = null) {
        val s = _state.value
        val original = replyToMessageId?.let { id -> s.messages.firstOrNull { it.id == id } }
        val sender = original?.from?.let { s.roster[it] }
        val to = when {
            sender != null && sender.isAdmin -> Targets.device(sender.id)
            else -> RoutingEngine.replyTarget(s.myId, s.roster) ?: s.me?.groupId?.let { Targets.group(it) } ?: return
        }
        sendMessage(to, text, kind = "quick")
        replyToMessageId?.let { markRead(listOf(it)) }
    }

    fun sendSignalToProducer() {
        val s = _state.value
        val to = RoutingEngine.replyTarget(s.myId, s.roster) ?: run {
            _state.update { it.copy(notice = "No producer online") }; return
        }
        send("signal.send", SignalSend(to))
    }

    /** Read receipts for messages the user has now seen (pop-up closed/answered, or panel open). */
    fun markRead(ids: Collection<String> = _state.value.unreadIds) {
        if (ids.isEmpty()) return
        val set = ids.toSet()
        set.forEach { id ->
            if (id in _state.value.unreadIds) send("message.ack", MessageAck(id))
            notifier.cancel(id)
        }
        _state.update { it.copy(unreadIds = it.unreadIds - set, popupQueue = it.popupQueue - set) }
    }

    /** Opening the panel shows everything, so it is all seen; pending pop-ups go too. */
    fun setPanelOpen(open: Boolean) {
        _state.update { it.copy(panelOpen = open) }
        if (open) markRead(_state.value.unreadIds + _state.value.popupQueue)
    }

    /** Close (or Next) on the pop-up card. */
    fun dismissPopup(id: String) = markRead(listOf(id))

    fun dismissAllPopups() = markRead(_state.value.popupQueue)

    /**
     * Where a reply to [m] goes, by the message.send rules: an admin on either side gets a direct
     * reply; a group message is answered to the group; else everyone if crew may broadcast; else
     * the producer.
     */
    fun replyTargetFor(m: Message): String? {
        val s = _state.value
        val sender = s.roster[m.from]
        return when {
            sender?.isAdmin == true || s.me?.isAdmin == true -> Targets.device(m.from)
            m.to.startsWith("g:") -> m.to
            s.settings.crewCanBroadcast -> Targets.ALL
            else -> RoutingEngine.replyTarget(s.myId, s.roster) ?: s.me?.groupId?.let { Targets.group(it) }
        }
    }

    /** Inline reply from the notification. */
    fun replyFromNotification(messageId: String, text: String) {
        val m = _state.value.messages.firstOrNull { it.id == messageId } ?: return
        val to = replyTargetFor(m) ?: return
        if (text.isNotBlank()) sendMessage(to, text.trim())
        markRead(listOf(messageId))
    }

    fun clearNotice() = _state.update { it.copy(notice = null) }

    fun setLocalMute(deviceId: String, muted: Boolean) { localMute[deviceId] = muted; recomputeRouting() }
    fun setLocalVolume(deviceId: String, volume: Double) { localVolume[deviceId] = volume; recomputeRouting() }

    // ---------------------------------------------------------------- Telecom hooks

    fun onHold(held: Boolean) {
        if (held) setMic(false)
        room.setSilenced(held)
        _state.update { it.copy(held = held) }
    }

    fun onSystemMute(muted: Boolean) {
        val prev = lastSystemMute
        lastSystemMute = muted
        if (prev == null && !muted) return
        if (prev != muted) setHardMute(muted)
    }

    fun setRoute(route: com.partyline.audio.OutputRoute?) {
        if (route == _state.value.route) return
        _state.update { it.copy(route = route) }
        reportStatus(force = true)
    }

    // ---------------------------------------------------------------- status (§6.8)

    private fun onBattery(i: Intent) {
        val level = i.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
        val scale = i.getIntExtra(BatteryManager.EXTRA_SCALE, 100)
        val status = i.getIntExtra(BatteryManager.EXTRA_STATUS, -1)
        battery = if (level >= 0 && scale > 0) level * 100 / scale else null
        charging = status == BatteryManager.BATTERY_STATUS_CHARGING || status == BatteryManager.BATTERY_STATUS_FULL
        reportStatus()
    }

    private fun currentStatus(): StatusPayload {
        val s = _state.value
        return StatusPayload(
            rtcConnected = room.conn.value == RoomController.Conn.CONNECTED,
            speaking = room.localSpeaking.value && s.micLive,
            battery = battery,
            charging = charging,
            headset = s.route?.isHeadset,
            rttMs = socket.rttMs.value?.toInt(),
            outputRoute = s.route?.wire,
        )
    }

    /** At most every 2 s; immediately when rtcConnected / speaking / route change. */
    private fun reportStatus(force: Boolean = false) {
        if (_state.value.phase != Phase.LIVE) return
        val st = currentStatus()
        val last = lastStatus
        if (st == last) return
        val urgent = force || last == null || st.rtcConnected != last.rtcConnected ||
            st.speaking != last.speaking || st.outputRoute != last.outputRoute
        val now = SystemClock.elapsedRealtime()
        val wait = STATUS_MIN_INTERVAL_MS - (now - lastStatusAt)
        if (urgent || wait <= 0) {
            pendingStatus?.cancel(); pendingStatus = null
            if (send("status", st)) { lastStatus = st; lastStatusAt = now }
        } else if (pendingStatus?.isActive != true) {
            pendingStatus = scope.launch { delay(wait); pendingStatus = null; reportStatus() }
        }
    }

    // ---------------------------------------------------------------- helpers

    private inline fun <reified T> send(type: String, payload: T, id: String? = null): Boolean =
        socket.send(ProtocolCodec.encode(type, payload, id))

    private fun sendEmpty(type: String) = socket.send(ProtocolCodec.encodeEmpty(type))

    fun nameOf(deviceId: String): String = _state.value.roster[deviceId]?.displayName ?: "Someone"

    fun targetLabel(ref: String): String {
        val s = _state.value
        return when {
            ref == Targets.ALL -> "Everyone"
            ref == Targets.device(s.myId) -> ""
            Targets.groupId(ref) != null -> s.groups.firstOrNull { it.id == Targets.groupId(ref) }?.name ?: Targets.groupId(ref)!!
            Targets.deviceId(ref) != null -> nameOf(Targets.deviceId(ref)!!)
            else -> ref
        }
    }

    private fun inForeground(): Boolean =
        ProcessLifecycleOwner.get().lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)

    fun leave() {
        if (_state.value.micLive) send("state.set", StateSet(micLive = false))
        end(EndReason.LEFT)
    }

    fun end(reason: EndReason) {
        if (_state.value.phase == Phase.ENDED) return
        Log.i(TAG, "session ended: $reason")
        _state.update { it.copy(phase = Phase.ENDED, endReason = reason, micLive = false) }
        if (reason == EndReason.KICKED || reason == EndReason.REVOKED) store.forgetSession()
        store.sessionActive = false
        release()
        onEnded(reason)
    }

    private fun release() {
        rediscovery?.cancel()
        rtcRetry.cancel()
        pendingStatus?.cancel()
        socket.stop()
        room.release()
        cues.release()
        notifier.release()
        runCatching { context.unregisterReceiver(batteryReceiver) }
        runCatching { context.getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(networkCallback) }
    }

    companion object {
        private const val TAG = "IntercomSession"
        private const val STATUS_MIN_INTERVAL_MS = 2_000L
        private const val ROUTING_RECONCILE_MS = 2_000L
    }
}
