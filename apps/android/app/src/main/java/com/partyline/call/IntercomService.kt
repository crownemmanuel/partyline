package com.partyline.call

import android.annotation.SuppressLint
import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import com.partyline.MainActivity
import com.partyline.PartyLineApp
import com.partyline.R
import com.partyline.input.MediaButtons
import com.partyline.model.SessionResponse
import com.partyline.notify.Channels
import com.partyline.store.SavedServer
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.conflate
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch

/**
 * Foreground service (microphone|phoneCall) that owns the session for its whole life, so the
 * call survives the Activity, the lock screen and a swipe from Recents. Started on join,
 * stopped on leave/kick.
 */
class IntercomService : Service() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var session: IntercomSession? = null
    private var telecom: TelecomController? = null
    private var mediaButtons: MediaButtons? = null
    private var wifiLock: WifiManager.WifiLock? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var starting = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action != ACTION_START && session == null && !starting) {
            // A stale notification action after the call ended.
            stopEverything()
            return START_NOT_STICKY
        }
        when (intent?.action) {
            ACTION_START -> start()
            ACTION_TOGGLE_MUTE -> session?.toggleHardMute()
            ACTION_TOGGLE_TALK -> session?.toggleTalk()
            ACTION_LIVE_REPLY -> androidx.core.app.RemoteInput.getResultsFromIntent(intent)
                ?.getCharSequence(KEY_REPLY_TEXT)?.toString()?.let { session?.replyFromLiveNotification(it) }
            ACTION_TOGGLE_SPEAKER -> session?.toggleSpeaker()
            ACTION_LEAVE -> session?.leave() ?: stopEverything()
            ACTION_QUICK_OK -> {
                val id = intent.getStringExtra(EXTRA_MESSAGE_ID)
                session?.sendQuick("OK", id)
            }
            ACTION_REPLY -> {
                val id = intent.getStringExtra(EXTRA_MESSAGE_ID)
                val text = androidx.core.app.RemoteInput.getResultsFromIntent(intent)?.getCharSequence(KEY_REPLY_TEXT)?.toString()
                if (id != null && text != null) session?.replyFromNotification(id, text)
            }
            ACTION_DISMISS_MESSAGE -> intent.getStringExtra(EXTRA_MESSAGE_ID)?.let { session?.dismissPopup(it) }
            null -> {
                // Restarted by the system after the process died (START_STICKY). We cannot
                // restart mic capture from the background; end cleanly so the next launch
                // shows the battery-optimization help instead.
                if (session == null && !starting) stopEverything()
            }
        }
        return START_STICKY
    }

    private fun start() {
        if (session != null || starting) return
        val server = pendingServer ?: PartyLineApp.store(this).server
        if (server == null) { stopEverything(); return }
        val initial = pendingResponse
        pendingServer = null; pendingResponse = null
        starting = true

        // Foreground first: Android 14 requires the microphone FGS before capture starts.
        if (!goForeground(placeholderNotification(server.name))) { starting = false; stopEverything(); return }
        acquireLocks()

        scope.launch {
            val tc = TelecomController(this@IntercomService, scope, telecomListener)
            telecom = tc
            val name = PartyLineApp.store(this@IntercomService).displayName.ifBlank { "PartyLine" }
            val usingTelecom = tc.start("PartyLine · ${server.name.ifBlank { name }}")
            if (!usingTelecom) telecom = null
            val s = try {
                IntercomSession(
                    this@IntercomService, scope, PartyLineApp.store(this@IntercomService), server, initial, usingTelecom,
                ) { reason -> onSessionEnded(reason) }
            } catch (e: Exception) {
                Log.e(TAG, "Cannot start session", e)
                starting = false
                stopEverything()
                return@launch
            }
            session = s
            _current.value = s
            starting = false
            s.start()
            telecom?.let { t -> launch { t.route.collect { r -> if (r != null) s.setRoute(r) } } }
            mediaButtons = MediaButtons(
                this@IntercomService,
                onDown = { s.talkPressed() },
                onUp = { s.talkReleased() },
                onToggle = { s.setMic(!s.state.value.micLive) },
            ).also { it.activate() }
            launch {
                // Live view: at most about one update a second, always ending on the latest state.
                s.state.map { NotificationModel.of(it, s::nameOf) }.distinctUntilChanged().conflate().collect {
                    updateNotification(it)
                    delay(NOTIFICATION_MIN_INTERVAL_MS)
                }
            }
        }
    }

    private val telecomListener = object : TelecomController.Listener {
        override fun onHold(held: Boolean) { session?.onHold(held) }
        override fun onSystemDisconnect() { session?.leave() ?: stopEverything() }
        override fun onSystemMute(muted: Boolean) { session?.onSystemMute(muted) }
    }

    private fun onSessionEnded(reason: EndReason) {
        Log.i(TAG, "ended: $reason")
        stopEverything()
    }

    private fun stopEverything() {
        telecom?.stop(); telecom = null
        mediaButtons?.release(); mediaButtons = null
        releaseLocks()
        session = null
        _current.value = null
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        // Swiped from Recents: keep the call. Do not call super (which may stop us on some OEMs).
        Log.i(TAG, "task removed; staying on the line")
    }

    override fun onDestroy() {
        session?.end(EndReason.SYSTEM)
        telecom?.stop()
        mediaButtons?.release()
        releaseLocks()
        _current.value = null
        scope.cancel()
        super.onDestroy()
    }

    // ---------------------------------------------------------------- foreground + locks

    private fun goForeground(n: Notification): Boolean {
        val types = if (Build.VERSION.SDK_INT >= 30) {
            ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL
        } else 0
        return try {
            ServiceCompat.startForeground(this, NOTIFICATION_ID, n, types)
            true
        } catch (e: Exception) {
            Log.w(TAG, "startForeground(mic|phoneCall) failed, retrying with microphone only", e)
            try {
                ServiceCompat.startForeground(
                    this, NOTIFICATION_ID, n,
                    if (Build.VERSION.SDK_INT >= 30) ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE else 0,
                )
                true
            } catch (e2: Exception) {
                Log.e(TAG, "startForeground failed", e2)
                false
            }
        }
    }

    @SuppressLint("WakelockTimeout")
    private fun acquireLocks() {
        val wifi = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
        @Suppress("DEPRECATION")
        val mode = if (Build.VERSION.SDK_INT >= 29) WifiManager.WIFI_MODE_FULL_LOW_LATENCY else WifiManager.WIFI_MODE_FULL_HIGH_PERF
        wifiLock = wifi.createWifiLock(mode, "partyline:wifi").apply { setReferenceCounted(false); acquire() }
        val pm = getSystemService(PowerManager::class.java)
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "partyline:live").apply { setReferenceCounted(false); acquire() }
    }

    private fun releaseLocks() {
        runCatching { wifiLock?.takeIf { it.isHeld }?.release() }
        runCatching { wakeLock?.takeIf { it.isHeld }?.release() }
        wifiLock = null; wakeLock = null
    }

    // ---------------------------------------------------------------- notification

    /**
     * The live view (lock screen / status bar, the Android take on an iOS Live Activity):
     * mic state, who is talking, the latest message, group and server.
     */
    private data class NotificationModel(
        val title: String,
        /** Mic state, or the connection state while not live. */
        val status: String,
        val talking: String,
        val lastMessage: String?,
        val micLive: Boolean,
        val adminMuted: Boolean,
        val live: Boolean,
        val groupName: String = "",
        val groupColor: String = "#3A7BD5",
    ) {
        /** Compact so it fits the call title: "🔇 Muted · 🔊 Producer" (connection state alone while not live). */
        val text: String get() {
            if (!live) return status
            val mic = when { adminMuted -> "🔒 $status"; micLive -> "🎙 $status"; else -> "🔇 $status" }
            return "$mic · $talking"
        }

        companion object {
            fun of(s: SessionState, nameOf: (String) -> String): NotificationModel {
                val group = s.myGroup?.name ?: "PartyLine"
                val live = s.phase == Phase.LIVE && !s.held
                val status = when {
                    s.phase == Phase.CONNECTING -> "Connecting…"
                    s.phase == Phase.RECONNECTING && s.serverOffline -> "Server offline, retrying"
                    s.phase == Phase.RECONNECTING -> "Reconnecting…"
                    s.held -> "On hold (phone call)"
                    s.adminMuted -> "Muted by producer"
                    s.micLive -> "Live"
                    else -> "Muted"
                }
                val talking = if (s.talking.isEmpty()) "Quiet" else "🔊 ${s.talking.joinToString()}"
                val last = s.messages.lastOrNull { it.from != s.myId }?.let { "${nameOf(it.from)} → ${it.text}" }
                return NotificationModel(
                    title = "$group · ${s.serverName}", status = status, talking = talking, lastMessage = last,
                    micLive = s.micLive, adminMuted = s.adminMuted, live = live,
                    groupName = group, groupColor = s.myGroup?.color ?: "#3A7BD5",
                )
            }
        }
    }

    private fun placeholderNotification(serverName: String): Notification =
        build(NotificationModel("PartyLine · $serverName", "Connecting…", "Quiet", null, micLive = false, adminMuted = false, live = false))

    /** The group's initial on a circle in the group colour (CallStyle's caller picture). */
    private fun groupAvatar(name: String, hex: String): androidx.core.graphics.drawable.IconCompat {
        val size = 128
        val bmp = android.graphics.Bitmap.createBitmap(size, size, android.graphics.Bitmap.Config.ARGB_8888)
        val c = android.graphics.Canvas(bmp)
        val p = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG)
        p.color = runCatching { android.graphics.Color.parseColor(hex) }.getOrDefault(0xFF3A7BD5.toInt())
        c.drawCircle(size / 2f, size / 2f, size / 2f, p)
        p.color = android.graphics.Color.WHITE
        p.textSize = size * 0.5f
        p.typeface = android.graphics.Typeface.DEFAULT_BOLD
        p.textAlign = android.graphics.Paint.Align.CENTER
        val letter = name.firstOrNull { it.isLetterOrDigit() }?.uppercase() ?: "P"
        c.drawText(letter, size / 2f, size / 2f - (p.descent() + p.ascent()) / 2, p)
        return androidx.core.graphics.drawable.IconCompat.createWithBitmap(bmp)
    }

    @SuppressLint("MissingPermission")
    private fun updateNotification(m: NotificationModel) {
        val granted = Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(
            this, android.Manifest.permission.POST_NOTIFICATIONS,
        ) == android.content.pm.PackageManager.PERMISSION_GRANTED
        if (granted) NotificationManagerCompat.from(this).notify(NOTIFICATION_ID, build(m))
    }

    /**
     * CallStyle (Telecom expects it for the self-managed call), public on the lock screen and
     * promoted to a Live Update on Android 16. Actions: Hang up, Talk on/off (hidden while the
     * producer mutes me), inline Reply. Tapping the body opens the app.
     */
    private fun build(m: NotificationModel): Notification {
        // CallStyle shows: the caller name (big), one text line, and a small header line.
        // Big: live status; text: latest message (else group · server); header: group · server.
        val person = Person.Builder().setName(m.text).setIcon(groupAvatar(m.groupName, m.groupColor)).setImportant(true).build()
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val b = NotificationCompat.Builder(this, Channels.CALL)
            .setSmallIcon(R.drawable.ic_stat_call)
            .setContentTitle(m.text)
            .setContentText(m.lastMessage?.let { "💬 $it" } ?: m.title)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setContentIntent(open)
            .setRequestPromotedOngoing(true)
            .setShortCriticalText(if (m.micLive) "LIVE" else if (m.adminMuted) "MUTED" else "ON AIR")
        val style = NotificationCompat.CallStyle.forOngoingCall(person, actionIntent(this, ACTION_LEAVE))
        style.setVerificationText(m.title)
        b.setStyle(style)
        if (m.live && !m.adminMuted) {
            b.addAction(
                if (m.micLive) R.drawable.ic_mic else R.drawable.ic_mic_off,
                if (m.micLive) "Stop talking" else "Talk", actionIntent(this, ACTION_TOGGLE_TALK),
            )
        }
        if (m.live) {
            b.addAction(
                NotificationCompat.Action.Builder(
                    R.drawable.ic_stat_message, "Reply", actionIntent(this, ACTION_LIVE_REPLY, mutable = true),
                )
                    .addRemoteInput(androidx.core.app.RemoteInput.Builder(KEY_REPLY_TEXT).setLabel("Reply").build())
                    .setAllowGeneratedReplies(false)
                    .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_REPLY)
                    .build(),
            )
        }
        return b.build()
    }

    companion object {
        private const val TAG = "IntercomService"
        private const val NOTIFICATION_ID = 1001
        private const val NOTIFICATION_MIN_INTERVAL_MS = 1_000L

        const val ACTION_START = "com.partyline.START"
        const val ACTION_TOGGLE_MUTE = "com.partyline.TOGGLE_MUTE"
        const val ACTION_TOGGLE_TALK = "com.partyline.TOGGLE_TALK"
        const val ACTION_LIVE_REPLY = "com.partyline.LIVE_REPLY"
        const val ACTION_TOGGLE_SPEAKER = "com.partyline.TOGGLE_SPEAKER"
        const val ACTION_LEAVE = "com.partyline.LEAVE"
        const val ACTION_QUICK_OK = "com.partyline.QUICK_OK"
        const val ACTION_REPLY = "com.partyline.REPLY"
        const val ACTION_DISMISS_MESSAGE = "com.partyline.DISMISS_MESSAGE"
        const val EXTRA_MESSAGE_ID = "messageId"
        const val KEY_REPLY_TEXT = "replyText"

        private val _current = MutableStateFlow<IntercomSession?>(null)
        /** The running session, for the UI. Same process, so no binder is needed. */
        val current: StateFlow<IntercomSession?> = _current

        @Volatile private var pendingServer: SavedServer? = null
        @Volatile private var pendingResponse: SessionResponse? = null

        /** Must be called from the foreground (Activity) so the microphone FGS may start. */
        fun start(context: Context, server: SavedServer, response: SessionResponse?) {
            pendingServer = server
            pendingResponse = response
            ContextCompat.startForegroundService(context, Intent(context, IntercomService::class.java).setAction(ACTION_START))
        }

        /** [mutable] is needed for RemoteInput, which adds the typed text to the intent. */
        fun actionIntent(context: Context, action: String, messageId: String? = null, mutable: Boolean = false): PendingIntent {
            val i = Intent(context, IntercomService::class.java).setAction(action)
            if (messageId != null) i.putExtra(EXTRA_MESSAGE_ID, messageId)
            return PendingIntent.getService(
                context, (action + (messageId ?: "")).hashCode(), i,
                PendingIntent.FLAG_UPDATE_CURRENT or (if (mutable) PendingIntent.FLAG_MUTABLE else PendingIntent.FLAG_IMMUTABLE),
            )
        }
    }
}
