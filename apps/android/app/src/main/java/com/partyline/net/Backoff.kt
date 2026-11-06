package com.partyline.net

/** Reconnect pacing shared by the control socket and LiveKit: 1, 2, 4, 8, 15, 15… s. */
object Backoff {
    val STEPS_MS = longArrayOf(1_000, 2_000, 4_000, 8_000, 15_000)

    /** Delay after the n-th consecutive failure (1-based). */
    fun delayFor(failure: Int): Long = STEPS_MS[(failure - 1).coerceIn(0, STEPS_MS.size - 1)]
}
