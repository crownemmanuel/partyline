package com.partyline.notify

import android.content.Context
import android.media.AudioManager
import android.media.ToneGenerator
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.util.Log

/**
 * Short tones and vibrations played into the call stream, so they are heard in the headset
 * even when the speaker is muted (LiveKit playback mute does not affect ToneGenerator).
 */
class Cues(context: Context) {
    private val vibrator: Vibrator = if (Build.VERSION.SDK_INT >= 31) {
        context.getSystemService(VibratorManager::class.java).defaultVibrator
    } else {
        @Suppress("DEPRECATION")
        context.getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
    }

    private val tones: ToneGenerator? = try {
        ToneGenerator(AudioManager.STREAM_VOICE_CALL, 70)
    } catch (e: RuntimeException) {
        Log.w("Cues", "ToneGenerator unavailable", e); null
    }

    fun disconnected() = tone(ToneGenerator.TONE_PROP_NACK, 300)
    fun reconnected() = tone(ToneGenerator.TONE_PROP_ACK, 200)
    fun message() {
        tone(ToneGenerator.TONE_PROP_BEEP, 120)
        vibrate(Channels.MESSAGE_VIBRATION)
    }

    fun signal() {
        tone(ToneGenerator.TONE_CDMA_ALERT_CALL_GUARD, 600)
        vibrate(Channels.SIGNAL_VIBRATION)
    }

    fun vibrate(pattern: LongArray) {
        runCatching { vibrator.vibrate(VibrationEffect.createWaveform(pattern, -1)) }
    }

    private fun tone(type: Int, ms: Int) {
        runCatching { tones?.startTone(type, ms) }
    }

    fun release() {
        runCatching { tones?.release() }
    }
}
