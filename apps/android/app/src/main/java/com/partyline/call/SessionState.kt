package com.partyline.call

import com.partyline.audio.OutputRoute
import com.partyline.model.Device
import com.partyline.model.Group
import com.partyline.model.Message
import com.partyline.model.ServerInfo
import com.partyline.model.Settings
import com.partyline.model.TalkMode

/** Live-call part of the state machine (ANDROID.md: connecting → live → reconnecting). */
enum class Phase { CONNECTING, LIVE, RECONNECTING, ENDED }

/** CERT_CHANGED: the server presented a cert that does not match our pin; the UI re-runs the trust prompt. */
enum class EndReason { LEFT, KICKED, REVOKED, SYSTEM, CERT_CHANGED }

data class SessionState(
    val phase: Phase = Phase.CONNECTING,
    val serverName: String = "",
    val myId: String = "",
    val roster: Map<String, Device> = emptyMap(),
    val groups: List<Group> = emptyList(),
    val settings: Settings = Settings(),
    val server: ServerInfo? = null,
    val messages: List<Message> = emptyList(),
    /** Messages from others not yet seen (= not yet acked); the FAB badge. */
    val unreadIds: Set<String> = emptySet(),
    /** Live messages waiting to be shown as the top pop-up card, oldest first. */
    val popupQueue: List<String> = emptyList(),
    /** The floating messages panel is open (everything in it counts as seen). */
    val panelOpen: Boolean = false,
    val micLive: Boolean = false,
    /** User's hard mic mute (call notification Mute). */
    val hardMuted: Boolean = false,
    val speakerMuted: Boolean = false,
    /** Telecom hold (a real phone call is active). */
    val held: Boolean = false,
    val localTalkMode: TalkMode = TalkMode.PTT,
    val replyHeld: Boolean = false,
    val rtcConnected: Boolean = false,
    /** LiveKit failed [com.partyline.audio.RtcRetry.UNREACHABLE_AFTER]+ times in a row; still retrying. */
    val audioUnreachable: Boolean = false,
    /** Display names of people I am hearing right now. */
    val talking: List<String> = emptyList(),
    val route: OutputRoute? = null,
    val serverOffline: Boolean = false,
    val lastError: String? = null,
    val notice: String? = null,
    val endReason: EndReason? = null,
    val usingTelecom: Boolean = false,
) {
    val me: Device? get() = roster[myId]
    val adminMuted: Boolean get() = me?.adminMuted == true
    val talkMode: TalkMode get() = me?.forcedTalkMode ?: localTalkMode
    val forcedPtt: Boolean get() = me?.forcedTalkMode != null
    val myGroup: Group? get() = me?.let { m -> groups.firstOrNull { it.id == m.groupId } }
    val canTalk: Boolean get() = !hardMuted && !adminMuted && !held && phase != Phase.ENDED
    val producerOnline: Boolean get() = roster.values.any { it.isAdmin && it.id != myId && it.live.online }
    val headsetWarning: Boolean get() = route == OutputRoute.SPEAKER
}
