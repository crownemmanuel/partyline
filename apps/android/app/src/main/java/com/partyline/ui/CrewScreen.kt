package com.partyline.ui

import android.view.HapticFeedbackConstants
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.waitForUpOrCancellation
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Chat
import androidx.compose.material.icons.automirrored.filled.VolumeOff
import androidx.compose.material.icons.automirrored.filled.VolumeUp
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.GraphicEq
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.MicOff
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.Badge
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.selected
import androidx.compose.material.icons.outlined.Mic
import androidx.compose.ui.draw.alpha
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.clickable
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.partyline.call.IntercomSession
import com.partyline.call.Phase
import com.partyline.audio.VoiceIsolation
import com.partyline.call.SessionState
import com.partyline.model.TalkMode
import com.partyline.ui.theme.PlColors

/**
 * Crew screen, same layout as the iOS app and the web client: group header, who is talking,
 * talk-mode switch, big talk button, Mic / Speaker tiles, voice isolation, messages (a floating panel drawn over this screen by PartyLineRoot).
 */
@Composable
fun CrewScreen(state: SessionState, session: IntercomSession, onSettings: () -> Unit, onFixBattery: () -> Unit = {}) {
    Column(
        Modifier.fillMaxSize().background(Color.Black).padding(horizontal = 16.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Header(state, onSettings)
        Banners(state, session)
        BatteryBanner(onFixBattery)
        TalkingNow(state)
        TalkModeSwitch(state, session)
        TalkButton(
            state,
            // Like iOS: talking clears the user's own mute instead of refusing.
            onPress = { if (state.hardMuted) session.setHardMute(false); session.talkPressed() },
            onRelease = session::talkReleased,
            modifier = Modifier.weight(1f),
        )
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            MicTile(state, session, Modifier.weight(1f))
            Tile(
                icon = if (state.speakerMuted) Icons.AutoMirrored.Filled.VolumeOff else Icons.AutoMirrored.Filled.VolumeUp,
                label = if (state.speakerMuted) "Speaker off" else "Speaker on",
                red = state.speakerMuted,
                onClick = session::toggleSpeaker,
                modifier = Modifier.weight(1f),
            )
        }
        VoiceIsolationBar(session)
        MessagesButton(state) { session.setPanelOpen(true) }
    }
}

@Composable
private fun Header(state: SessionState, onSettings: () -> Unit) {
    Row(verticalAlignment = Alignment.Top) {
        Column(Modifier.weight(1f)) {
            Text(
                (state.myGroup?.name ?: "—").uppercase(),
                fontSize = 34.sp, fontWeight = FontWeight.Black, lineHeight = 38.sp,
                color = state.myGroup?.color?.let(::parseHex) ?: Color.White,
            )
            Text(state.serverName, color = PlColors.Muted, fontSize = 15.sp)
            state.me?.displayName?.takeIf { it.isNotBlank() }?.let { Text(it, color = PlColors.Muted.copy(alpha = 0.7f), fontSize = 13.sp) }
        }
        Column(horizontalAlignment = Alignment.End) {
            val (color, label) = when {
                state.phase == Phase.LIVE && state.rtcConnected -> PlColors.Ok to "live"
                state.phase == Phase.LIVE && state.audioUnreachable -> PlColors.Live to "no audio"
                state.phase == Phase.LIVE -> PlColors.Warn to "audio…"
                state.serverOffline -> PlColors.Live to "offline"
                state.phase == Phase.RECONNECTING -> PlColors.Warn to "reconnecting"
                else -> PlColors.Warn to "connecting"
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(10.dp).clip(CircleShape).background(color))
                Spacer(Modifier.width(6.dp))
                Text(label, color = color, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
            }
            IconButton(onClick = onSettings) { Icon(Icons.Default.Settings, "Settings") }
        }
    }
}

@Composable
private fun TalkingNow(state: SessionState) {
    val quiet = state.talking.isEmpty()
    Row(verticalAlignment = Alignment.CenterVertically) {
        Icon(Icons.Default.GraphicEq, null, tint = if (quiet) PlColors.Muted else PlColors.Ok)
        Spacer(Modifier.width(8.dp))
        Text(
            if (quiet) "Quiet" else "Talking: ${state.talking.joinToString()}",
            fontSize = 19.sp, fontWeight = FontWeight.SemiBold, maxLines = 2,
            color = if (quiet) Color.White else PlColors.Ok,
        )
    }
}

/** "Hold to talk" | "Tap on / off" (sets live.talkMode); locked while the producer forces a mode. */
@Composable
private fun TalkModeSwitch(state: SessionState, session: IntercomSession) {
    val forced = state.me?.forcedTalkMode != null
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Row(
            Modifier.fillMaxWidth().clip(RoundedCornerShape(50)).background(PlColors.Surface).padding(4.dp)
                .alpha(if (forced) 0.5f else 1f),
            horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            for ((mode, title) in listOf(TalkMode.PTT to "Hold to talk", TalkMode.LATCH to "Tap on / off")) {
                val selected = state.talkMode == mode
                Box(
                    Modifier.weight(1f).clip(RoundedCornerShape(50))
                        .background(if (selected) PlColors.Idle else Color.Transparent)
                        .clickable(enabled = !forced && !selected) { session.setTalkMode(mode) }
                        .semantics { role = Role.Tab; this.selected = selected }
                        .padding(vertical = 10.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(title, fontWeight = FontWeight.SemiBold, color = if (selected) Color.White else PlColors.Muted)
                }
            }
        }
        if (forced) Text("Talk mode set by the producer", fontSize = 12.sp, color = PlColors.Muted, modifier = Modifier.padding(top = 4.dp))
    }
}

@Composable
private fun Banners(state: SessionState, session: IntercomSession) {
    val lines = buildList {
        if (state.serverOffline) add("Server offline. Retrying…" to PlColors.Live)
        else if (state.phase == Phase.RECONNECTING) add("Reconnecting…" to PlColors.Warn)
        if (state.phase == Phase.LIVE && !state.rtcConnected && state.audioUnreachable) add("Audio server unreachable, retrying" to PlColors.Live)
        if (state.held) add("On hold during your phone call" to PlColors.Warn)
        if (state.adminMuted) add("Muted by producer" to PlColors.Live)
        if (state.headsetWarning) add("No headset: you are on the loudspeaker (echo risk)" to PlColors.Warn)
        state.notice?.let { add(it to MaterialTheme.colorScheme.primary) }
        if (state.phase != Phase.LIVE) state.lastError?.let { add(it to PlColors.Muted) }
    }
    AutoClear(state.notice, onClear = session::clearNotice)
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        for ((text, color) in lines) {
            Surface(color = color.copy(alpha = 0.15f), shape = RoundedCornerShape(8.dp), modifier = Modifier.fillMaxWidth()) {
                Text(text, color = color, modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp))
            }
        }
    }
}

/**
 * Stays until the app is exempt from battery optimisation: without it many phones (and vendor
 * battery managers) stop the intercom some minutes after the screen locks. Re-checked on resume.
 */
@Composable
private fun BatteryBanner(onFix: () -> Unit) {
    val context = androidx.compose.ui.platform.LocalContext.current
    fun restricted() = !context.getSystemService(android.os.PowerManager::class.java)
        .isIgnoringBatteryOptimizations(context.packageName)
    var show by remember { mutableStateOf(restricted()) }
    androidx.lifecycle.compose.LifecycleEventEffect(androidx.lifecycle.Lifecycle.Event.ON_RESUME) { show = restricted() }
    if (!show) return
    Surface(
        color = PlColors.Warn.copy(alpha = 0.15f), shape = RoundedCornerShape(8.dp),
        modifier = Modifier.fillMaxWidth().clickable(onClick = onFix),
    ) {
        Text(
            "Battery optimisation is on: Android may cut the intercom while the screen is locked. Tap to allow.",
            color = PlColors.Warn, modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
        )
    }
}

/** Hold in PTT mode, tap in latch mode, haptics on press and release (§6.3). */
@Composable
private fun TalkButton(state: SessionState, onPress: () -> Unit, onRelease: () -> Unit, modifier: Modifier = Modifier) {
    val view = LocalView.current
    val press by rememberUpdatedState(onPress)
    val release by rememberUpdatedState(onRelease)
    val live = state.micLive && !state.replyHeld
    val locked = state.adminMuted || state.held || state.phase == Phase.ENDED
    val label = when {
        state.adminMuted -> "MUTED BY PRODUCER"
        state.held -> "ON HOLD"
        state.talkMode == TalkMode.LATCH -> if (live) "TALK ON" else "TAP TO TALK"
        else -> if (live) "TALKING" else "HOLD TO TALK"
    }
    val bg = when {
        locked -> PlColors.Idle
        live -> PlColors.Live
        else -> PlColors.Talk
    }
    Box(
        modifier
            .fillMaxWidth()
            .heightIn(min = 140.dp)
            .clip(RoundedCornerShape(28.dp))
            .background(bg)
            .semantics { role = Role.Button; contentDescription = label }
            .pointerInput(locked) {
                if (locked) return@pointerInput
                awaitEachGesture {
                    awaitFirstDown(requireUnconsumed = false)
                    view.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY)
                    press()
                    waitForUpOrCancellation()
                    view.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_RELEASE)
                    release()
                }
            },
        contentAlignment = Alignment.Center,
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Icon(
                if (state.adminMuted) Icons.Default.Lock else if (live) Icons.Default.Mic else Icons.Outlined.Mic, null,
                modifier = Modifier.size(48.dp), tint = Color.White,
            )
            Spacer(Modifier.height(6.dp))
            Text(label, fontSize = 26.sp, fontWeight = FontWeight.Black, color = Color.White, textAlign = TextAlign.Center)
        }
    }
}

/** Left tile (iOS MicTile): "Muted" / red "Live · tap to mute" / lock "Muted by producer". */
@Composable
private fun MicTile(state: SessionState, session: IntercomSession, modifier: Modifier) {
    val live = state.micLive
    val (icon, label) = when {
        state.adminMuted -> Icons.Default.Lock to "Muted by producer"
        live -> Icons.Default.Mic to "Live · tap to mute"
        else -> Icons.Default.MicOff to "Muted"
    }
    Tile(
        icon = icon, label = label, red = live, enabled = !state.adminMuted, modifier = modifier,
        onClick = {
            when {
                state.replyHeld -> session.replyReleased()
                live -> session.setMic(false)
                state.hardMuted -> session.setHardMute(false)
            }
        },
    )
}

@Composable
private fun Tile(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    label: String,
    red: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    Column(
        modifier
            .clip(RoundedCornerShape(14.dp))
            .background(if (red) PlColors.Live else PlColors.Surface)
            .clickable(enabled = enabled, onClick = onClick)
            .semantics { role = Role.Button }
            .padding(vertical = 12.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Icon(icon, null, tint = Color.White)
        Spacer(Modifier.height(4.dp))
        Text(label, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, color = Color.White, maxLines = 1)
    }
}

/** Full-width bar: dark green ON (small "basic" tag on the platform fallback), dark grey OFF. */
@Composable
private fun VoiceIsolationBar(session: IntercomSession) {
    val vi by VoiceIsolation.state.collectAsState()
    Row(
        Modifier.fillMaxWidth().height(48.dp).clip(RoundedCornerShape(14.dp))
            .background(if (vi.enabled) PlColors.IsolationOn else PlColors.Surface)
            .clickable { session.setVoiceIsolation(!vi.enabled) }
            .semantics { role = Role.Switch },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.Center,
    ) {
        Icon(Icons.Default.GraphicEq, null, tint = Color.White)
        Spacer(Modifier.width(8.dp))
        Text("Voice isolation " + if (vi.enabled) "ON" else "OFF", fontWeight = FontWeight.SemiBold, color = Color.White)
        if (vi.enabled && vi.engine == VoiceIsolation.Engine.BASIC) {
            Spacer(Modifier.width(8.dp))
            Text(
                "basic", fontSize = 11.sp, color = Color.White,
                modifier = Modifier.clip(RoundedCornerShape(50)).background(Color.White.copy(alpha = 0.18f)).padding(horizontal = 8.dp, vertical = 2.dp),
            )
        }
    }
}

/** Pill "💬 Messages" with blue text and the unread badge; opens the panel in place. */
@Composable
private fun MessagesButton(state: SessionState, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().height(50.dp).clip(RoundedCornerShape(50)).background(PlColors.Surface)
            .clickable(onClick = onClick).semantics { role = Role.Button },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.Center,
    ) {
        Text("💬", fontSize = 18.sp)
        Spacer(Modifier.width(8.dp))
        Text("Messages", color = MaterialTheme.colorScheme.primary, fontWeight = FontWeight.SemiBold, fontSize = 16.sp)
        if (state.unreadIds.isNotEmpty()) {
            Spacer(Modifier.width(8.dp))
            Badge { Text("${state.unreadIds.size}") }
        }
    }
}

private fun parseHex(hex: String): Color? = runCatching {
    Color(android.graphics.Color.parseColor(if (hex.startsWith("#")) hex else "#$hex"))
}.getOrNull()
