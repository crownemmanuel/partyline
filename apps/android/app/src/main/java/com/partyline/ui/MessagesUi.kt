package com.partyline.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.partyline.call.IntercomSession
import com.partyline.call.SessionState
import com.partyline.model.Message
import com.partyline.model.RoutingEngine
import com.partyline.model.Targets
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/**
 * Floating messages card near the bottom of the crew screen: history, quick replies, To: picker, 🔔 signal, text + Send.
 * [replyTo] preselects a target and focuses the text field (Reply from the pop-up).
 */
@Composable
fun BoxScope.MessagesPanel(state: SessionState, session: IntercomSession, replyTo: String?, onClose: () -> Unit) {
    var text by remember { mutableStateOf("") }
    val producer = RoutingEngine.replyTarget(state.myId, state.roster)
    val myGroup = state.me?.groupId?.let { Targets.group(it) }
    val targets = buildList {
        producer?.let { add(it to "Producer") }
        myGroup?.let { add(it to (state.myGroup?.name ?: "My group")) }
        if (state.settings.crewCanBroadcast || state.me?.isAdmin == true) add(Targets.ALL to "Everyone")
        if (replyTo != null && none { it.first == replyTo }) add(replyTo to session.targetLabel(replyTo).ifEmpty { session.nameOf(replyTo.removePrefix("d:")) })
    }
    var to by remember(replyTo, targets.firstOrNull()?.first) { mutableStateOf(replyTo ?: targets.firstOrNull()?.first) }
    val focus = remember { FocusRequester() }
    LaunchedEffect(replyTo) { if (replyTo != null) runCatching { focus.requestFocus() } }

    BackHandler(onBack = onClose)
    Card(
        modifier = Modifier.align(Alignment.BottomEnd).padding(12.dp)
            .fillMaxWidth().imePadding(),
        elevation = CardDefaults.cardElevation(defaultElevation = 12.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerHigh),
    ) {
        Column(Modifier.padding(14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Messages", style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f))
                OutlinedButton(onClick = session::sendSignalToProducer, enabled = producer != null) { Text("🔔 Call producer") }
                TextButton(onClick = onClose) { Text("Close") }
            }
            val listState = rememberLazyListState()
            LaunchedEffect(state.messages.size) { if (state.messages.isNotEmpty()) listState.scrollToItem(state.messages.size - 1) }
            LazyColumn(
                Modifier.fillMaxWidth().heightIn(min = 80.dp, max = 300.dp),
                state = listState,
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                if (state.messages.isEmpty()) item {
                    Text("No messages yet", color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(vertical = 20.dp))
                }
                items(state.messages, key = { it.id }) { m ->
                    val mine = m.from == state.myId
                    Column(Modifier.fillMaxWidth(), horizontalAlignment = if (mine) Alignment.End else Alignment.Start) {
                        Text(header(m, session, mine), fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Text(m.text, fontSize = 17.sp, fontWeight = if (m.kind == "quick") FontWeight.SemiBold else FontWeight.Normal)
                    }
                }
            }
            Spacer(Modifier.height(10.dp))
            if (state.me?.isAdmin != true && state.settings.quickReplies.isNotEmpty()) {
                LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    items(state.settings.quickReplies) { q -> AssistChip(onClick = { session.sendQuick(q) }, label = { Text(q) }) }
                }
                Spacer(Modifier.height(6.dp))
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("To:", modifier = Modifier.padding(end = 8.dp))
                LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    items(targets, key = { it.first }) { (ref, label) ->
                        FilterChip(selected = to == ref, onClick = { to = ref }, label = { Text(label) })
                    }
                }
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                OutlinedTextField(
                    value = text, onValueChange = { text = it.take(500) },
                    placeholder = { Text("Message") }, maxLines = 3,
                    modifier = Modifier.weight(1f).focusRequester(focus),
                )
                Spacer(Modifier.width(8.dp))
                Button(
                    onClick = { to?.let { session.sendMessage(it, text.trim()); text = "" } },
                    enabled = text.isNotBlank() && to != null,
                ) { Text("Send") }
            }
        }
    }
}

/**
 * Top card for a new live message while the panel is closed. Stays until dismissed; with more
 * queued, Close becomes Next and "Close all" appears. Back closes the current one.
 */
@Composable
fun BoxScope.MessagePopup(state: SessionState, session: IntercomSession, onReply: (Message) -> Unit) {
    val id = state.popupQueue.firstOrNull() ?: return
    val m = state.messages.firstOrNull { it.id == id } ?: run {
        LaunchedEffect(id) { session.dismissPopup(id) }
        return
    }
    val more = state.popupQueue.size - 1
    BackHandler { session.dismissPopup(id) }
    Card(
        modifier = Modifier.align(Alignment.TopCenter).padding(12.dp).fillMaxWidth(),
        elevation = CardDefaults.cardElevation(defaultElevation = 16.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer),
    ) {
        Column(Modifier.padding(16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("💬 " + header(m, session, false), fontSize = 14.sp, modifier = Modifier.weight(1f))
                if (more > 0) Text("+$more more", fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
            }
            Spacer(Modifier.height(8.dp))
            Text(m.text, fontSize = 24.sp, fontWeight = FontWeight.SemiBold, lineHeight = 30.sp)
            Spacer(Modifier.height(14.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Button(onClick = { onReply(m) }, modifier = Modifier.weight(1f).height(56.dp)) { Text("↩ Reply", fontSize = 18.sp) }
                FilledTonalButton(onClick = { session.dismissPopup(id) }, modifier = Modifier.weight(1f).height(56.dp)) {
                    Text(if (more > 0) "Next" else "Close", fontSize = 18.sp)
                }
            }
            if (more > 0) {
                Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                    TextButton(onClick = session::dismissAllPopups) { Text("Close all") }
                }
            }
        }
    }
}

private fun header(m: Message, session: IntercomSession, mine: Boolean): String {
    val toLabel = session.targetLabel(m.to)
    return (if (mine) "You" else session.nameOf(m.from)) + (if (toLabel.isNotEmpty()) " → $toLabel" else "") + " · ${time(m.ts)}"
}

private val timeFmt = DateTimeFormatter.ofPattern("HH:mm").withZone(ZoneId.systemDefault())

private fun time(ts: String): String = runCatching { timeFmt.format(Instant.parse(ts)) }.getOrDefault("")
