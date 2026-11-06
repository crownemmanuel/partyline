package com.partyline.input

import android.content.Context
import android.content.Intent
import android.os.Build
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import android.view.KeyEvent

/**
 * Headset button while live: in PTT mode the button acts as press/release, in latch mode a
 * press toggles the mic. Wired headsets deliver HEADSETHOOK with down/up; most Bluetooth
 * headsets only deliver a single PLAY_PAUSE click, which we treat as a toggle.
 */
class MediaButtons(
    context: Context,
    private val onDown: () -> Unit,
    private val onUp: () -> Unit,
    private val onToggle: () -> Unit,
) {
    private val session = MediaSessionCompat(context, "PartyLine").apply {
        setCallback(object : MediaSessionCompat.Callback() {
            override fun onMediaButtonEvent(mediaButtonEvent: Intent): Boolean {
                val key = if (Build.VERSION.SDK_INT >= 33) {
                    mediaButtonEvent.getParcelableExtra(Intent.EXTRA_KEY_EVENT, KeyEvent::class.java)
                } else {
                    @Suppress("DEPRECATION")
                    mediaButtonEvent.getParcelableExtra(Intent.EXTRA_KEY_EVENT)
                } ?: return false
                return handle(key)
            }

            // Some stacks bypass onMediaButtonEvent and call the transport controls directly.
            override fun onPlay() = onToggle()
            override fun onPause() = onToggle()
        })
        // Playing state is what makes the system route media buttons to us.
        setPlaybackState(
            PlaybackStateCompat.Builder()
                .setActions(PlaybackStateCompat.ACTION_PLAY_PAUSE or PlaybackStateCompat.ACTION_PLAY or PlaybackStateCompat.ACTION_PAUSE)
                .setState(PlaybackStateCompat.STATE_PLAYING, 0, 1f)
                .build(),
        )
    }

    private var hookDown = false

    private fun handle(key: KeyEvent): Boolean {
        when (key.keyCode) {
            KeyEvent.KEYCODE_HEADSETHOOK -> {
                if (key.action == KeyEvent.ACTION_DOWN && key.repeatCount == 0 && !hookDown) {
                    hookDown = true; onDown()
                } else if (key.action == KeyEvent.ACTION_UP) {
                    hookDown = false; onUp()
                }
                return true
            }
            KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, KeyEvent.KEYCODE_MEDIA_PLAY, KeyEvent.KEYCODE_MEDIA_PAUSE -> {
                if (key.action == KeyEvent.ACTION_UP) onToggle()
                return true
            }
        }
        return false
    }

    fun activate() { session.isActive = true }

    fun release() {
        session.isActive = false
        session.release()
    }
}
