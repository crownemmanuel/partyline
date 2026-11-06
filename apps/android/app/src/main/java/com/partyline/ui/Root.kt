package com.partyline.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.foundation.layout.Box
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.partyline.SessionViewModel
import com.partyline.Stage
import com.partyline.call.Phase

@Composable
fun PartyLineRoot(
    vm: SessionViewModel,
    openMessages: MutableState<Boolean>,
    onRequestBatteryExemption: () -> Unit,
    onOpenUrl: (String) -> Unit,
) {
    val ui by vm.ui.collectAsStateWithLifecycle()
    val call by vm.call.collectAsStateWithLifecycle()
    val session by vm.session.collectAsStateWithLifecycle()
    var showSettings by remember { mutableStateOf(false) }

    val live = call?.takeIf { it.phase != Phase.ENDED }
    val s = session
    var replyTo by remember { mutableStateOf<String?>(null) }
    // Notification tap: open the messages panel.
    LaunchedEffect(openMessages.value, s) {
        if (openMessages.value && s != null) { showSettings = false; s.setPanelOpen(true); openMessages.value = false }
    }

    Surface(Modifier.fillMaxSize(), color = if (live != null) androidx.compose.ui.graphics.Color.Black else MaterialTheme.colorScheme.background) {
      Box(Modifier.fillMaxSize().safeDrawingPadding()) {
        Column(Modifier.fillMaxSize()) {
            when {
                live != null && s != null && showSettings -> SettingsScreen(
                    state = live, vm = vm, session = s,
                    onBack = { showSettings = false }, onOpenUrl = onOpenUrl,
                    onBattery = onRequestBatteryExemption,
                )
                live != null && s != null -> CrewScreen(
                    state = live, session = s, onSettings = { showSettings = true }, onFixBattery = onRequestBatteryExemption,
                )
                ui.stage == Stage.CONNECTING -> Connecting(ui.savedServer?.name ?: "")
                ui.candidate != null && ui.trustedServerId != null -> JoinScreen(ui, vm)
                else -> DiscoveryScreen(ui, vm)
            }
        }
        if (live != null && s != null) {
            val closePanel = { s.setPanelOpen(false); replyTo = null }
            if (!showSettings && live.panelOpen) MessagesPanel(live, s, replyTo, onClose = closePanel)
            // Over everything, settings included; never while the panel shows the messages anyway.
            if (!live.panelOpen) MessagePopup(live, s) { m ->
                replyTo = s.replyTargetFor(m)
                showSettings = false
                s.setPanelOpen(true)  // acks the card and everything else now shown
            }
        }
      }
    }

    ui.trust?.let { TrustDialog(it, onTrust = vm::acceptTrust, onCancel = vm::rejectTrust) }

    if (ui.askBatteryExemption) {
        AlertDialog(
            onDismissRequest = vm::batteryPromptHandled,
            title = { Text("Stay on the line all shift") },
            text = { Text("Allow PartyLine to run without battery restrictions so Android does not cut the intercom while the phone is locked.") },
            confirmButton = { TextButton(onClick = { vm.batteryPromptHandled(); onRequestBatteryExemption() }) { Text("Allow") } },
            dismissButton = { TextButton(onClick = vm::batteryPromptHandled) { Text("Not now") } },
        )
    }

    if (ui.killedLastTime) {
        val vendor = SessionViewModel.vendorHelpUrl()
        AlertDialog(
            onDismissRequest = vm::dismissKilled,
            title = { Text("The intercom was stopped") },
            text = {
                Text(
                    "Android closed PartyLine while you were on the line. Turn off battery optimization for PartyLine" +
                        (if (vendor != null) " and follow the steps for your phone." else "."),
                )
            },
            confirmButton = {
                TextButton(onClick = { vm.dismissKilled(); onRequestBatteryExemption() }) { Text("Battery settings") }
            },
            dismissButton = {
                if (vendor != null) TextButton(onClick = { vm.dismissKilled(); onOpenUrl(vendor) }) { Text("Steps for this phone") }
                else TextButton(onClick = vm::dismissKilled) { Text("OK") }
            },
        )
    }

    ui.endedMessage?.let { msg ->
        AlertDialog(
            onDismissRequest = vm::dismissEnded,
            title = { Text("Disconnected") },
            text = { Text(msg) },
            confirmButton = { TextButton(onClick = vm::dismissEnded) { Text("OK") } },
        )
    }
}

@Composable
private fun Connecting(serverName: String) {
    Column(
        Modifier.fillMaxSize().padding(24.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        CircularProgressIndicator()
        Spacer(Modifier.height(16.dp))
        Text(if (serverName.isNotEmpty()) "Connecting to $serverName…" else "Connecting…")
    }
}
