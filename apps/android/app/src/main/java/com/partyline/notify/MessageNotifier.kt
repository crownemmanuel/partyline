package com.partyline.notify

import android.Manifest
import android.annotation.SuppressLint
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.speech.tts.TextToSpeech
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.partyline.MainActivity
import com.partyline.R
import com.partyline.call.IntercomService
import com.partyline.model.Message
import java.util.Locale

/**
 * `message` and `signal` as heads-up notifications (shown when the app is not in front),
 * plus the optional on-device text-to-speech readout into the call audio.
 */
class MessageNotifier(private val context: Context) {

    private val nm = NotificationManagerCompat.from(context)
    private var tts: TextToSpeech? = null
    private var ttsReady = false

    fun showMessage(message: Message, fromName: String, toLabel: String) {
        val title = if (toLabel.isEmpty()) fromName else "$fromName → $toLabel"
        val builder = NotificationCompat.Builder(context, Channels.MESSAGES)
            .setSmallIcon(R.drawable.ic_stat_message)
            .setContentTitle(title)
            .setContentText(message.text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(message.text))
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setVibrate(Channels.MESSAGE_VIBRATION)
            .setAutoCancel(true)
            .setContentIntent(openMessages(message.id))
            .addAction(
                NotificationCompat.Action.Builder(
                    R.drawable.ic_stat_message, "Reply",
                    IntercomService.actionIntent(context, IntercomService.ACTION_REPLY, message.id, mutable = true),
                )
                    .addRemoteInput(androidx.core.app.RemoteInput.Builder(IntercomService.KEY_REPLY_TEXT).setLabel("Reply").build())
                    .setAllowGeneratedReplies(false)
                    .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_REPLY)
                    .build(),
            )
            .addAction(0, "Close", IntercomService.actionIntent(context, IntercomService.ACTION_DISMISS_MESSAGE, message.id))
            // Swiping it away counts as Close (seen).
            .setDeleteIntent(IntercomService.actionIntent(context, IntercomService.ACTION_DISMISS_MESSAGE, message.id))
        post(message.id.hashCode(), builder)
    }

    fun showSignal(fromName: String) {
        val builder = NotificationCompat.Builder(context, Channels.SIGNALS)
            .setSmallIcon(R.drawable.ic_stat_signal)
            .setContentTitle("Attention")
            .setContentText("$fromName is calling you")
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setVibrate(Channels.SIGNAL_VIBRATION)
            .setSound(Channels.signalToneUri(context))
            .setAutoCancel(true)
            .setTimeoutAfter(60_000)
            .setContentIntent(openMessages(null))
        post(SIGNAL_ID, builder)
    }

    fun showNotice(text: String) {
        val builder = NotificationCompat.Builder(context, Channels.MESSAGES)
            .setSmallIcon(R.drawable.ic_stat_message)
            .setContentTitle("PartyLine")
            .setContentText(text)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(openMessages(null))
        post(NOTICE_ID, builder)
    }

    fun cancel(messageId: String) = nm.cancel(messageId.hashCode())

    fun speak(text: String) {
        val engine = tts
        if (engine == null) {
            tts = TextToSpeech(context.applicationContext) { status ->
                ttsReady = status == TextToSpeech.SUCCESS
                if (ttsReady) {
                    tts?.language = Locale.getDefault()
                    tts?.speak(text, TextToSpeech.QUEUE_ADD, null, "pl-${System.nanoTime()}")
                }
            }
            return
        }
        if (ttsReady) engine.speak(text, TextToSpeech.QUEUE_ADD, null, "pl-${System.nanoTime()}")
    }

    fun release() {
        tts?.shutdown()
        tts = null
    }

    @SuppressLint("MissingPermission")
    private fun post(id: Int, builder: NotificationCompat.Builder) {
        val granted = android.os.Build.VERSION.SDK_INT < 33 ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
        if (granted) nm.notify(id, builder.build())
    }

    private fun openMessages(messageId: String?): PendingIntent {
        val intent = Intent(context, MainActivity::class.java)
            .setAction(MainActivity.ACTION_OPEN_MESSAGES)
            .putExtra(MainActivity.EXTRA_MESSAGE_ID, messageId)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        return PendingIntent.getActivity(
            context, (messageId ?: "open").hashCode(), intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    companion object {
        private const val SIGNAL_ID = 2001
        private const val NOTICE_ID = 2002
    }
}
