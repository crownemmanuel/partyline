package com.partyline.audio

import com.partyline.net.Backoff
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Paces LiveKit (re)connects with the control socket's 1-2-4-8-15 s backoff. Without it a failed
 * connect (Disconnected → token.refresh → token.refreshed → connect) looped as fast as the
 * server answered. At most one retry is pending; [retry] runs when it is due. Main thread only.
 */
class RtcRetry(private val scope: CoroutineScope, private val retry: () -> Unit) {
    var failures = 0
        private set
    private var pending: Job? = null

    val waiting: Boolean get() = pending?.isActive == true

    /** Enough failures in a row to tell the user the audio server is unreachable. */
    val unreachable: Boolean get() = failures >= UNREACHABLE_AFTER

    fun succeeded() {
        failures = 0
        cancel()
    }

    fun failed() {
        failures++
        schedule()
    }

    /** Retry after the current backoff (1 s after a healthy session drops). No-op while one is pending. */
    fun schedule() {
        if (waiting) return
        val wait = Backoff.delayFor(failures.coerceAtLeast(1))
        pending = scope.launch {
            delay(wait)
            pending = null
            retry()
        }
    }

    /** Drop the pending wait, e.g. a fresh `welcome` may try at once. The failure count stays. */
    fun cancel() {
        pending?.cancel()
        pending = null
    }

    companion object {
        const val UNREACHABLE_AFTER = 3
    }
}
