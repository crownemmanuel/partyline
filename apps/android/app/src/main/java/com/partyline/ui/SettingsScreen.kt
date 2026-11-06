package com.partyline.ui

import android.os.PowerManager
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.partyline.BuildConfig
import com.partyline.PartyLineApp
import com.partyline.SessionViewModel
import com.partyline.call.IntercomSession
import com.partyline.call.SessionState
import com.partyline.model.TalkMode
import com.partyline.ui.theme.PlColors

/** One screen: name, server, talk mode, headset check, text-to-speech, leave (ARCHITECTURE §10). */
@Composable
fun SettingsScreen(
    state: SessionState,
    vm: SessionViewModel,
    session: IntercomSession,
    onBack: () -> Unit,
    onOpenUrl: (String) -> Unit,
    onBattery: () -> Unit,
) {
    val context = LocalContext.current
    var tts by remember { mutableStateOf(vm.tts) }
    var autoJoin by remember { mutableStateOf(vm.autoJoin) }
    val pm = context.getSystemService(PowerManager::class.java)
    val exempt = pm.isIgnoringBatteryOptimizations(context.packageName)
    val vendor = SessionViewModel.vendorHelpUrl()

    Column(Modifier.fillMaxSize().padding(20.dp).verticalScroll(rememberScrollState())) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Settings", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
            TextButton(onClick = onBack) { Text("Done") }
        }
        Section("Name") { Text(state.me?.displayName ?: "", fontSize = 18.sp); Hint("The producer can rename you.") }
        Section("Server") {
            Text(state.serverName, fontSize = 18.sp)
            PartyLineApp.store(context).server?.let { Hint("${it.host}:${it.port}") }
            PartyLineApp.store(context).server?.serverId?.let { id ->
                PartyLineApp.store(context).pinnedFingerprint(id)?.let {
                    Text(it.chunked(4).joinToString(" "), fontFamily = FontFamily.Monospace, fontSize = 11.sp, color = PlColors.Muted)
                }
            }
        }
        Section("Talk mode") {
            SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
                listOf(TalkMode.PTT to "Hold to talk", TalkMode.LATCH to "Latch").forEachIndexed { i, (mode, label) ->
                    SegmentedButton(
                        selected = state.talkMode == mode,
                        onClick = { session.setTalkMode(mode) },
                        enabled = !state.forcedPtt,
                        shape = SegmentedButtonDefaults.itemShape(i, 2),
                    ) { Text(label) }
                }
            }
            if (state.forcedPtt) Hint("The producer set hold-to-talk for you.")
        }
        Section("Headset") {
            val route = state.route
            Text(
                when (route) {
                    null -> "Unknown"
                    else -> route.wire.replaceFirstChar { it.uppercase() }
                } + if (state.usingTelecom) " (system call)" else "",
            )
            if (state.headsetWarning) Text("Plug in a headset: the loudspeaker causes echo for everyone.", color = PlColors.Warn)
        }
        Section("Read messages aloud") {
            ToggleRow("Speak new messages into the headset", tts) { tts = it; vm.setTts(it) }
        }
        Section("Start") {
            ToggleRow("Rejoin automatically when the app opens", autoJoin) { autoJoin = it; vm.setAutoJoin(it) }
        }
        Section("Battery") {
            if (exempt) Text("Battery optimization is off for PartyLine. ✓", color = PlColors.Ok)
            else {
                Text("Android may stop the intercom while locked.", color = PlColors.Warn)
                OutlinedButton(onClick = onBattery) { Text("Allow running in background") }
            }
            if (vendor != null) TextButton(onClick = { onOpenUrl(vendor) }) { Text("Extra steps for this phone (${android.os.Build.MANUFACTURER})") }
        }
        Spacer(Modifier.height(24.dp))
        Button(
            onClick = { vm.leave(); onBack() },
            colors = ButtonDefaults.buttonColors(containerColor = PlColors.Live),
            modifier = Modifier.fillMaxWidth().height(52.dp),
        ) { Text("Leave the line") }
        Spacer(Modifier.height(8.dp))
        TextButton(onClick = { vm.forgetServer(); onBack() }, modifier = Modifier.fillMaxWidth()) {
            Text("Forget this server (needs a new code)")
        }
        Spacer(Modifier.height(8.dp))
        Hint("PartyLine ${BuildConfig.VERSION_NAME}")
    }
}

@Composable
private fun Section(title: String, content: @Composable () -> Unit) {
    Spacer(Modifier.height(16.dp))
    Text(title.uppercase(), fontSize = 12.sp, color = PlColors.Muted, fontWeight = FontWeight.SemiBold)
    Spacer(Modifier.height(4.dp))
    content()
    Spacer(Modifier.height(8.dp))
    HorizontalDivider()
}

@Composable
private fun Hint(text: String) = Text(text, fontSize = 13.sp, color = PlColors.Muted)

@Composable
private fun ToggleRow(label: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(label, modifier = Modifier.weight(1f))
        Switch(checked = checked, onCheckedChange = onChange)
    }
}
