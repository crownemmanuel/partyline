package com.partyline.audio

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.PI
import kotlin.math.log10
import kotlin.math.sin
import kotlin.math.sqrt

class Resampler48Test {
    private fun rms(a: FloatArray, from: Int) = sqrt(a.drop(from).sumOf { it.toDouble() * it } / (a.size - from))

    /** Round trip 16 kHz → 48 kHz → 16 kHz in 10 ms frames, as the capture path does. */
    private fun roundTrip(rate: Int, signal: (Int) -> Double): Pair<FloatArray, FloatArray> {
        val factor = 48_000 / rate
        val rs = Resampler48(factor)
        val n = rate / 100
        val input = FloatArray(rate) { signal(it).toFloat() }
        val out = FloatArray(input.size)
        val low = FloatArray(n); val high = FloatArray(n * factor)
        for (f in 0 until input.size / n) {
            System.arraycopy(input, f * n, low, 0, n)
            rs.up(low, high)
            rs.down(high, low)
            System.arraycopy(low, 0, out, f * n, n)
        }
        return input to out
    }

    @Test fun keepsSpeechBandLevelAt16k() {
        val (input, out) = roundTrip(16_000) { 0.3 * sin(2 * PI * 1000 * it / 16_000.0) }
        assertEquals(0.0, 20 * log10(rms(out, 1600) / rms(input, 1600)), 0.2)
    }

    @Test fun keepsSpeechBandLevelAt8k() {
        val (input, out) = roundTrip(8_000) { 0.3 * sin(2 * PI * 700 * it / 8_000.0) }
        assertEquals(0.0, 20 * log10(rms(out, 800) / rms(input, 800)), 0.2)
    }

    @Test fun upsampledSignalHasNoImages() {
        // A 1 kHz tone at 16 kHz upsampled to 48 kHz must stay a 1 kHz tone: the images at
        // 15 and 17 kHz are filtered out.
        val rs = Resampler48(3)
        val low = FloatArray(160); val high = FloatArray(480)
        var t = 0
        var image = 0.0; var tone = 0.0
        repeat(50) { frame ->
            for (i in low.indices) { low[i] = (0.3 * sin(2 * PI * 1000 * t / 16_000.0)).toFloat(); t++ }
            rs.up(low, high)
            if (frame >= 10) {
                var re15 = 0.0; var im15 = 0.0; var re1 = 0.0; var im1 = 0.0
                for (i in high.indices) {
                    val n = frame * 480 + i
                    re15 += high[i] * kotlin.math.cos(2 * PI * 15_000 * n / 48_000.0); im15 += high[i] * sin(2 * PI * 15_000 * n / 48_000.0)
                    re1 += high[i] * kotlin.math.cos(2 * PI * 1_000 * n / 48_000.0); im1 += high[i] * sin(2 * PI * 1_000 * n / 48_000.0)
                }
                image += re15 * re15 + im15 * im15; tone += re1 * re1 + im1 * im1
            }
        }
        assertTrue("image only ${10 * log10(tone / image)} dB down", 10 * log10(tone / image) > 50)
    }
}
