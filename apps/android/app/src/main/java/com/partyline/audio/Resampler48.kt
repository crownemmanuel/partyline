package com.partyline.audio

import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin

/**
 * Integer-ratio resampling between a capture rate of 48 kHz / [factor] and DeepFilterNet's
 * 48 kHz (16 kHz Bluetooth wideband = 3, 8 kHz narrowband = 6). Windowed-sinc low-pass FIR,
 * filter state kept across frames; about 1 ms of delay each way.
 */
internal class Resampler48(val factor: Int) {
    private val taps = lowPass(16 * factor + 1, 0.45 / factor)
    private val upHist = FloatArray(taps.size - 1)
    private val downHist = FloatArray(taps.size - 1)
    private var upExt = FloatArray(0)
    private var downExt = FloatArray(0)

    /** [input] at the low rate → [out] (input.size * factor samples) at 48 kHz. */
    fun up(input: FloatArray, out: FloatArray) {
        val n = input.size * factor
        if (upExt.size != upHist.size + n) upExt = FloatArray(upHist.size + n)
        System.arraycopy(upHist, 0, upExt, 0, upHist.size)
        java.util.Arrays.fill(upExt, upHist.size, upExt.size, 0f)
        // Zero-stuff with gain = factor so the level is kept after the low-pass.
        for (i in input.indices) upExt[upHist.size + i * factor] = input[i] * factor
        filter(upExt, out, 1)
        System.arraycopy(upExt, n, upHist, 0, upHist.size)
    }

    /** [input] at 48 kHz → [out] (input.size / factor samples) at the low rate. */
    fun down(input: FloatArray, out: FloatArray) {
        if (downExt.size != downHist.size + input.size) downExt = FloatArray(downHist.size + input.size)
        System.arraycopy(downHist, 0, downExt, 0, downHist.size)
        System.arraycopy(input, 0, downExt, downHist.size, input.size)
        filter(downExt, out, factor)
        System.arraycopy(downExt, input.size, downHist, 0, downHist.size)
    }

    /** out[j] = FIR output at sample j*step of ext's new part (ext = history + new). */
    private fun filter(ext: FloatArray, out: FloatArray, step: Int) {
        val last = taps.size - 1
        for (j in out.indices) {
            val end = j * step + last
            var acc = 0f
            for (k in taps.indices) acc += taps[k] * ext[end - k]
            out[j] = acc
        }
    }

    private companion object {
        /** Blackman-windowed sinc; [cutoff] in cycles per sample at 48 kHz. */
        fun lowPass(n: Int, cutoff: Double): FloatArray {
            val m = (n - 1) / 2.0
            val h = DoubleArray(n) { k ->
                val x = k - m
                val sinc = if (x == 0.0) 2 * cutoff else sin(2 * PI * cutoff * x) / (PI * x)
                val w = 0.42 - 0.5 * cos(2 * PI * k / (n - 1)) + 0.08 * cos(4 * PI * k / (n - 1))
                sinc * w
            }
            val sum = h.sum()
            return FloatArray(n) { (h[it] / sum).toFloat() }
        }
    }
}
