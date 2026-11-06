package com.partyline.audio

import android.content.Context
import android.media.AudioManager
import android.util.Log
import com.partyline.model.RoutingEngine
import com.twilio.audioswitch.AudioDevice
import io.livekit.android.AudioOptions
import io.livekit.android.AudioType
import io.livekit.android.ConnectOptions
import io.livekit.android.LiveKit
import io.livekit.android.LiveKitOverrides
import io.livekit.android.RoomOptions
import io.livekit.android.audio.AudioProcessorOptions
import io.livekit.android.audio.AudioSwitchHandler
import io.livekit.android.audio.NoAudioHandler
import io.livekit.android.events.RoomEvent
import io.livekit.android.events.collect
import io.livekit.android.room.Room
import io.livekit.android.room.participant.AudioTrackPublishOptions
import io.livekit.android.room.participant.ParticipantTrackPermission
import io.livekit.android.room.track.LocalAudioTrackOptions
import io.livekit.android.room.track.LocalTrackPublication
import io.livekit.android.room.track.RemoteAudioTrack
import io.livekit.android.room.track.Track
import io.livekit.android.util.flow
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient

/** Output route as reported in `status.outputRoute`. */
enum class OutputRoute(val wire: String, val isHeadset: Boolean) {
    HEADSET("headset", true), BLUETOOTH("bluetooth", true), SPEAKER("speaker", false), EARPIECE("earpiece", false)
}

/**
 * Owns the LiveKit [Room]: one connection, one mic track named `mic`, always published and
 * muted when not live (ARCHITECTURE §4.3). Routing results from [RoutingEngine] are applied
 * here: publisher permissions and per-track enable/volume.
 */
class RoomController(
    private val context: Context,
    private val scope: CoroutineScope,
    http: OkHttpClient,
    /** True when Core-Telecom owns the call audio; LiveKit then does no audio-focus/routing itself. */
    private val telecomManagesAudio: Boolean,
    private val onEvent: (Event) -> Unit,
) {
    sealed interface Event {
        data object Connected : Event
        data object Reconnecting : Event
        data object Reconnected : Event
        data class Disconnected(val reason: String) : Event
        /** A remote participant appeared / its track was subscribed; routing must be re-applied. */
        data object TracksChanged : Event
    }

    enum class Conn { DISCONNECTED, CONNECTING, CONNECTED, RECONNECTING }

    private val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager

    val room: Room = LiveKit.create(
        appContext = context.applicationContext,
        options = RoomOptions(
            adaptiveStream = false,
            dynacast = false,
            audioTrackCaptureDefaults = micOptions(VoiceIsolation.wantsWebRtcNoiseSuppression),
        ),
        overrides = LiveKitOverrides(
            okHttpClient = http,
            audioOptions = AudioOptions(
                audioOutputType = AudioType.CallAudioType(),
                audioHandler = if (telecomManagesAudio) NoAudioHandler() else null,
                audioProcessorOptions = AudioProcessorOptions(capturePostProcessor = VoiceIsolation),
            ),
        ),
    )

    private val _conn = MutableStateFlow(Conn.DISCONNECTED)
    val conn: StateFlow<Conn> = _conn

    /** Identities currently speaking (LiveKit VAD), local included when my mic is live. */
    private val _speakers = MutableStateFlow<Set<String>>(emptySet())
    val speakers: StateFlow<Set<String>> = _speakers

    private val _localSpeaking = MutableStateFlow(false)
    val localSpeaking: StateFlow<Boolean> = _localSpeaking

    /** Route chosen by LiveKit's AudioSwitch; null when Telecom reports routes instead. */
    private val _route = MutableStateFlow<OutputRoute?>(null)
    val route: StateFlow<OutputRoute?> = _route

    private var eventsJob: Job? = null
    private var lastAllowed: Set<String>? = null
    private var lastRouting: RoutingEngine.Result? = null
    /** Last enabled/volume applied per remote track (by identity hash), for change logging. */
    private val appliedPlayback = HashMap<Int, Pair<Boolean, Double>>()
    private var silenced = false
    private var micLive = false
    /** Whether the published mic track was created with WebRTC noise suppression. */
    private var micNoiseSuppression: Boolean? = null

    init {
        (room.audioHandler as? AudioSwitchHandler)?.let { sw ->
            sw.preferredDeviceList = listOf(
                AudioDevice.BluetoothHeadset::class.java,
                AudioDevice.WiredHeadset::class.java,
                AudioDevice.Speakerphone::class.java,
                AudioDevice.Earpiece::class.java,
            )
            sw.registerAudioDeviceChangeListener { _, selected -> _route.value = selected?.toRoute() }
        }
        eventsJob = scope.launch { room.events.collect { handle(it) } }
        VoiceIsolation.prepare()
        // DeepFilterNet replaces WebRTC's suppressor; switching needs a new track (capture options are fixed).
        scope.launch {
            VoiceIsolation.state.collect {
                val want = VoiceIsolation.wantsWebRtcNoiseSuppression
                if (micNoiseSuppression != null && micNoiseSuppression != want && _conn.value == Conn.CONNECTED) republishMic()
            }
        }
        scope.launch { room.localParticipant::isSpeaking.flow.collect { _localSpeaking.value = it && micLive } }
    }

    val remoteIdentities: List<String> get() = room.remoteParticipants.keys.map { it.value }

    /**
     * Connect and publish the muted mic. [baseUrl] is `wss://host:8443` (LiveKit adds `/rtc`).
     * Throws on failure; the caller retries with a fresh token from the next `welcome`.
     */
    suspend fun connect(baseUrl: String, token: String) {
        if (_conn.value == Conn.CONNECTED || _conn.value == Conn.CONNECTING) return
        _conn.value = Conn.CONNECTING
        if (telecomManagesAudio) audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
        // A previous attempt may have left the SDK half-connected; it refuses connect() then.
        if (room.state != Room.State.DISCONNECTED) runCatching { room.disconnect() }
        try {
            room.connect(baseUrl, token, ConnectOptions(autoSubscribe = true))
        } catch (e: Throwable) {
            _conn.value = Conn.DISCONNECTED
            throw e
        }
        _conn.value = Conn.CONNECTED
        lastAllowed = null
        lastRouting?.let { apply(it) } ?: room.localParticipant.setTrackSubscriptionPermissions(false, emptyList())
        publishMutedMic()
    }

    private suspend fun publishMutedMic() {
        val lp = room.localParticipant
        if (lp.getTrackPublication(Track.Source.MICROPHONE) != null) return
        val ns = VoiceIsolation.wantsWebRtcNoiseSuppression
        val track = lp.createAudioTrack(name = MIC_TRACK_NAME, options = micOptions(ns))
        micNoiseSuppression = ns
        track.enabled = micLive
        lp.publishAudioTrack(
            track,
            AudioTrackPublishOptions(
                name = MIC_TRACK_NAME, audioBitrate = 48_000, dtx = true, red = true, source = Track.Source.MICROPHONE,
            ),
        )
        setMicLive(micLive)
    }

    /** Swaps the mic for one with the current noise-suppression setting; mute state carries over. */
    private suspend fun republishMic() {
        val lp = room.localParticipant
        lp.getTrackPublication(Track.Source.MICROPHONE)?.track?.let { lp.unpublishTrack(it) }
        micNoiseSuppression = null
        runCatching { publishMutedMic() }.onFailure { Log.w(TAG, "mic republish failed: ${it.message}") }
    }

    /** PTT / latch: toggles mute on the published track. Never unpublishes. */
    fun setMicLive(live: Boolean) {
        micLive = live
        val pub = room.localParticipant.getTrackPublication(Track.Source.MICROPHONE) as? LocalTrackPublication
        if (pub != null) pub.muted = !live
        if (!live) _localSpeaking.value = false
    }

    /** Telecom hold: play nothing regardless of routing until released. */
    fun setSilenced(value: Boolean) {
        silenced = value
        lastRouting?.let { apply(it) }
    }

    /**
     * Applies routing. Playback (enable/volume per remote track) is applied in any state, so a
     * track that arrives while connecting is not left at the SDK's initial state; the publisher
     * permissions need a live signalling connection.
     */
    fun apply(result: RoutingEngine.Result) {
        lastRouting = result
        val allowed = result.allowedSubscribers
        val connected = _conn.value == Conn.CONNECTED || _conn.value == Conn.RECONNECTING
        if (connected && allowed != lastAllowed) {
            room.localParticipant.setTrackSubscriptionPermissions(
                allParticipantsAllowed = false,
                // LiveKit 2.30's toProto() passes participantSid straight to a protobuf setter,
                // which throws on null. An empty sid means "match by identity", which also covers
                // participants that join later.
                participantTrackPermissions = allowed.map {
                    ParticipantTrackPermission(participantIdentity = it, participantSid = "", allTracksAllowed = true)
                },
            )
            lastAllowed = allowed
        }
        val seen = HashSet<Int>()
        for ((identity, participant) in room.remoteParticipants) {
            val pb = result.playback[identity.value] ?: RoutingEngine.Playback(false, 1.0)
            for ((_, track) in participant.audioTrackPublications) {
                val audio = track as? RemoteAudioTrack ?: continue
                val enabled = pb.enabled && !silenced
                val key = System.identityHashCode(audio)
                seen += key
                // Compare with the track's real state (the SDK can reset it), not only our cache.
                val changed = appliedPlayback[key] != (enabled to pb.volume)
                if (changed || audio.enabled != enabled) {
                    // One line per change, so a silent remote track can be traced in logcat.
                    Log.i(TAG, "play ${identity.value}: ${if (enabled) "on" else "off"} vol=${pb.volume}" +
                        if (identity.value in result.playback) "" else " (not in routing yet)")
                    audio.enabled = enabled
                    audio.setVolume(pb.volume)
                    appliedPlayback[key] = enabled to pb.volume
                }
            }
        }
        appliedPlayback.keys.retainAll(seen)
    }

    private fun handle(e: RoomEvent) {
        when (e) {
            is RoomEvent.Reconnecting -> { _conn.value = Conn.RECONNECTING; onEvent(Event.Reconnecting) }
            is RoomEvent.Reconnected -> {
                _conn.value = Conn.CONNECTED
                lastAllowed = null
                lastRouting?.let { apply(it) }
                onEvent(Event.Reconnected)
            }
            is RoomEvent.Disconnected -> {
                _conn.value = Conn.DISCONNECTED
                micNoiseSuppression = null
                _speakers.value = emptySet()
                onEvent(Event.Disconnected(e.reason.name))
            }
            is RoomEvent.Connected -> onEvent(Event.Connected)
            // No apply of the previous result here: it predates this track and would turn it off.
            // The session recomputes with the current participants and applies that.
            is RoomEvent.TrackSubscribed, is RoomEvent.TrackPublished, is RoomEvent.ParticipantConnected,
            is RoomEvent.TrackUnmuted -> onEvent(Event.TracksChanged)
            is RoomEvent.ParticipantDisconnected -> onEvent(Event.TracksChanged)
            is RoomEvent.ActiveSpeakersChanged -> _speakers.value = e.speakers
                .filter { it != room.localParticipant }
                .mapNotNull { it.identity?.value }
                .toSet()
            else -> Unit
        }
    }

    fun disconnect() {
        runCatching { room.disconnect() }
        _conn.value = Conn.DISCONNECTED
    }

    fun release() {
        eventsJob?.cancel()
        runCatching { room.disconnect() }
        runCatching { room.release() }
        if (telecomManagesAudio) runCatching { audioManager.mode = AudioManager.MODE_NORMAL }
    }

    private fun AudioDevice.toRoute(): OutputRoute = when (this) {
        is AudioDevice.BluetoothHeadset -> OutputRoute.BLUETOOTH
        is AudioDevice.WiredHeadset -> OutputRoute.HEADSET
        is AudioDevice.Speakerphone -> OutputRoute.SPEAKER
        is AudioDevice.Earpiece -> OutputRoute.EARPIECE
    }

    companion object {
        private const val TAG = "RoomController"
        const val MIC_TRACK_NAME = "mic"

        private fun micOptions(noiseSuppression: Boolean) = LocalAudioTrackOptions(
            noiseSuppression = noiseSuppression, echoCancellation = true, autoGainControl = true, highPassFilter = true,
        )
    }
}
