package com.partyline.notify

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.ContentResolver
import android.content.Context
import android.media.AudioAttributes
import android.net.Uri
import com.partyline.R

/** The three channels from ANDROID.md. */
object Channels {
    const val CALL = "intercom_call"
    const val MESSAGES = "messages"
    const val SIGNALS = "signals"

    val MESSAGE_VIBRATION = longArrayOf(0, 120, 80, 120)
    val SIGNAL_VIBRATION = longArrayOf(0, 400, 150, 400, 150, 400)

    fun create(context: Context) {
        val nm = context.getSystemService(NotificationManager::class.java)
        val call = NotificationChannel(CALL, "Intercom call", NotificationManager.IMPORTANCE_LOW).apply {
            description = "Ongoing while you are on the line"
            setSound(null, null)
            enableVibration(false)
            setShowBadge(false)
        }
        val messages = NotificationChannel(MESSAGES, "Messages", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "Text from the producer and your group"
            enableVibration(true)
            vibrationPattern = MESSAGE_VIBRATION
        }
        val signals = NotificationChannel(SIGNALS, "Attention signals", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "Call-light buzz from the producer"
            enableVibration(true)
            vibrationPattern = SIGNAL_VIBRATION
            setSound(
                signalToneUri(context),
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build(),
            )
        }
        nm.createNotificationChannels(listOf(call, messages, signals))
    }

    fun signalToneUri(context: Context): Uri =
        Uri.parse("${ContentResolver.SCHEME_ANDROID_RESOURCE}://${context.packageName}/${R.raw.signal_tone}")
}
