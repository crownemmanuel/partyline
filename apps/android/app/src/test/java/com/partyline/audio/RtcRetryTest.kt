package com.partyline.audio

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class RtcRetryTest {
    private class Harness(scope: TestScope) {
        val retryTimes = mutableListOf<Long>()
        val retry = RtcRetry(scope.backgroundScope) { retryTimes += scope.testScheduler.currentTime }
    }

    @Test fun failuresBackOffOneTwoFourEightFifteen() = runTest {
        val h = Harness(this)
        // Each due retry fails again at once, like a connect that is refused immediately.
        repeat(7) {
            h.retry.failed()
            advanceTimeBy(60_000); runCurrent()
        }
        // The delay of attempt n is retryTime(n) - time failed() was called (n * 60 s).
        val delays = h.retryTimes.mapIndexed { i, t -> t - i * 60_000L }
        assertEquals(listOf(1_000L, 2_000L, 4_000L, 8_000L, 15_000L, 15_000L, 15_000L), delays)
    }

    @Test fun noRetryBeforeTheDelay() = runTest {
        val h = Harness(this)
        h.retry.failed()
        advanceTimeBy(999); runCurrent()
        assertEquals(0, h.retryTimes.size)
        advanceTimeBy(1); runCurrent()
        assertEquals(1, h.retryTimes.size)
    }

    @Test fun burstOfDisconnectsSchedulesOneRetry() = runTest {
        // The old loop: every Disconnected asked for a token and reconnected at once.
        val h = Harness(this)
        h.retry.failed()
        repeat(500) { h.retry.schedule() }
        advanceTimeBy(30_000); runCurrent()
        assertEquals(1, h.retryTimes.size)
    }

    @Test fun healthySessionDropRetriesAfterOneSecond() = runTest {
        val h = Harness(this)
        h.retry.schedule()
        advanceTimeBy(1_000); runCurrent()
        assertEquals(listOf(1_000L), h.retryTimes)
    }

    @Test fun unreachableAfterThreeFailuresAndResetOnSuccess() = runTest {
        val h = Harness(this)
        repeat(2) { h.retry.failed(); advanceTimeBy(20_000); runCurrent() }
        assertFalse(h.retry.unreachable)
        h.retry.failed()
        assertTrue(h.retry.unreachable)
        h.retry.succeeded()
        assertFalse(h.retry.unreachable)
        assertFalse(h.retry.waiting)
        advanceTimeBy(60_000); runCurrent()
        assertEquals(2, h.retryTimes.size) // the pending third retry was cancelled
    }

    @Test fun cancelAllowsAnImmediateAttemptButKeepsCount() = runTest {
        val h = Harness(this)
        repeat(3) { h.retry.failed(); advanceTimeBy(20_000); runCurrent() }
        h.retry.failed()
        assertTrue(h.retry.waiting)
        h.retry.cancel()
        assertFalse(h.retry.waiting)
        assertEquals(4, h.retry.failures)
    }
}
