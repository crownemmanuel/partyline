package com.partyline.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Backspace
import androidx.compose.material.icons.filled.QrCodeScanner
import androidx.compose.material.icons.filled.Router
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.partyline.SessionViewModel
import com.partyline.TrustPrompt
import com.partyline.UiState
import com.partyline.ui.theme.PlColors

@Composable
fun DiscoveryScreen(ui: UiState, vm: SessionViewModel) {
    var manual by rememberSaveable { mutableStateOf("") }
    var scanning by remember { mutableStateOf(false) }
    if (scanning) {
        QrScanner(onResult = { if (vm.onQr(it)) scanning = false }, onClose = { scanning = false })
        return
    }
    Column(Modifier.fillMaxSize().padding(20.dp)) {
        Text("PartyLine", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
        Spacer(Modifier.height(4.dp))
        Text("Looking for PartyLine on this Wi-Fi…", color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.height(8.dp))
        LinearProgressIndicator(Modifier.fillMaxWidth())
        Spacer(Modifier.height(16.dp))

        val saved = ui.savedServer
        if (saved != null && ui.hasToken) {
            Card(
                Modifier.fillMaxWidth().clickable { vm.rejoin() },
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primary.copy(alpha = 0.18f)),
            ) {
                Column(Modifier.padding(16.dp)) {
                    Text("Rejoin ${saved.name.ifBlank { saved.host }}", fontWeight = FontWeight.SemiBold)
                    Text("No code needed", color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            Spacer(Modifier.height(12.dp))
        }

        ui.error?.let { ErrorText(it) }
        LazyColumn(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            items(ui.servers, key = { it.serviceName }) { s ->
                Card(Modifier.fillMaxWidth().clickable(enabled = !ui.busy) { vm.pick(s) }) {
                    Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Default.Router, null)
                        Spacer(Modifier.width(12.dp))
                        Column(Modifier.weight(1f)) {
                            Text(s.name, fontWeight = FontWeight.SemiBold)
                            Text("${s.host}:${s.port}", color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 13.sp)
                        }
                        if (ui.busy && ui.candidate?.host == s.host) CircularProgressIndicator(Modifier.size(20.dp))
                    }
                }
            }
            if (ui.servers.isEmpty()) item {
                Text(
                    "No server found yet. Make sure this phone is on the same Wi-Fi as the host, or type its address.",
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        Spacer(Modifier.height(12.dp))
        OutlinedTextField(
            value = manual, onValueChange = { manual = it },
            label = { Text("Server address (e.g. 192.168.1.20)") },
            singleLine = true, modifier = Modifier.fillMaxWidth(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Go),
        )
        Spacer(Modifier.height(8.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = { vm.manual(manual) }, enabled = manual.isNotBlank() && !ui.busy, modifier = Modifier.weight(1f)) {
                Text("Connect")
            }
            FilledTonalButton(onClick = { scanning = true }, modifier = Modifier.weight(1f)) {
                Icon(Icons.Default.QrCodeScanner, null); Spacer(Modifier.width(8.dp)); Text("Scan QR")
            }
        }
    }
}

@Composable
fun JoinScreen(ui: UiState, vm: SessionViewModel) {
    val candidate = ui.candidate ?: return
    var code by rememberSaveable(candidate.host) { mutableStateOf(candidate.joinCode?.filter { it.isDigit() }?.take(6) ?: "") }
    var name by rememberSaveable { mutableStateOf(ui.displayName) }
    val focus = androidx.compose.ui.platform.LocalFocusManager.current

    Column(Modifier.fillMaxSize().padding(20.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("Join ${candidate.name}", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
                Text("Enter the 6-digit code shown on the host", color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            TextButton(onClick = vm::cancelJoin) { Text("Back") }
        }
        Spacer(Modifier.height(16.dp))
        OutlinedTextField(
            value = name, onValueChange = { name = it.take(40) }, label = { Text("Your name (e.g. Camera 2)") },
            singleLine = true, modifier = Modifier.fillMaxWidth(),
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Words, imeAction = ImeAction.Done),
        )
        Spacer(Modifier.height(16.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            for (i in 0 until 6) {
                Box(
                    Modifier.size(44.dp, 56.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Card(Modifier.fillMaxSize()) {
                        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                            Text(code.getOrNull(i)?.toString() ?: "", fontSize = 28.sp, fontFamily = FontFamily.Monospace)
                        }
                    }
                }
            }
        }
        Spacer(Modifier.height(8.dp))
        ui.error?.let { ErrorText(it) }
        Spacer(Modifier.weight(1f))
        CodePad(
            onDigit = { d -> focus.clearFocus(); if (code.length < 6) code += d },
            onDelete = { focus.clearFocus(); code = code.dropLast(1) },
        )
        Spacer(Modifier.height(12.dp))
        Button(
            onClick = { vm.join(code, name) },
            enabled = !ui.busy && code.length == 6 && name.isNotBlank(),
            modifier = Modifier.fillMaxWidth().height(56.dp),
        ) {
            if (ui.busy) CircularProgressIndicator(Modifier.size(20.dp)) else Text("Join", fontSize = 18.sp)
        }
    }
}

@Composable
private fun CodePad(onDigit: (Char) -> Unit, onDelete: () -> Unit) {
    val rows = listOf("123", "456", "789", " 0<")
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        for (row in rows) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                for (c in row) {
                    Box(Modifier.weight(1f).aspectRatio(2f)) {
                        when (c) {
                            ' ' -> Unit
                            '<' -> IconButton(onClick = onDelete, modifier = Modifier.fillMaxSize()) {
                                Icon(Icons.AutoMirrored.Filled.Backspace, "Delete")
                            }
                            else -> FilledTonalButton(onClick = { onDigit(c) }, modifier = Modifier.fillMaxSize()) {
                                Text(c.toString(), fontSize = 24.sp)
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
fun TrustDialog(t: TrustPrompt, onTrust: () -> Unit, onCancel: () -> Unit) {
    AlertDialog(
        onDismissRequest = onCancel,
        title = { Text(if (t.changedFrom != null) "Certificate changed!" else "Trust ${t.serverName}?") },
        text = {
            Column {
                if (t.changedFrom != null) {
                    Text(
                        "This server presented a different certificate than last time. That is normal after the host renews it (about every two years) or changes address. Continue only if the fingerprint below matches the host screen.",
                        color = PlColors.Live,
                    )
                    Spacer(Modifier.height(8.dp))
                }
                Text("Check that this fingerprint matches the one on the host screen:")
                Spacer(Modifier.height(8.dp))
                Text(
                    t.fingerprint.chunked(4).chunked(4).joinToString("\n") { it.joinToString(" ") },
                    fontFamily = FontFamily.Monospace, fontSize = 13.sp,
                )
                Spacer(Modifier.height(8.dp))
                when (t.matchesAdvertised) {
                    true -> Text("✓ Matches the fingerprint the server advertised", color = PlColors.Ok)
                    false -> Text("✗ Does NOT match the advertised fingerprint", color = PlColors.Live)
                    null -> Unit
                }
            }
        },
        confirmButton = { TextButton(onClick = onTrust) { Text("Trust") } },
        dismissButton = { TextButton(onClick = onCancel) { Text("Cancel") } },
    )
}

@Composable
fun ErrorText(text: String) {
    Text(text, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(vertical = 8.dp))
}

@Composable
fun AutoClear(key: Any?, onClear: () -> Unit, delayMs: Long = 4000) {
    LaunchedEffect(key) {
        if (key != null) { kotlinx.coroutines.delay(delayMs); onClear() }
    }
}
