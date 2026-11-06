package com.partyline.audio

import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.log10
import kotlin.math.sqrt

/**
 * Runs the real libdfjni on the device. White noise must come out much quieter. If
 * `clean.f32` and `noise.f32` (48 kHz mono float32 LE) were pushed to `/data/local/tmp/df/`,
 * speech mixed into noise is also checked: the speech must keep its level. Samples are not in
 * the repo (licensing); any clean speech and noise recording works.
 */
@RunWith(AndroidJUnit4::class)
class DeepFilterTest {
    private fun run(input: FloatArray): FloatArray {
        val df = DeepFilter.create(100f)
        assertNotNull("libdfjni / model failed to load", df)
        df!!
        val n = df.frameLength
        val out = FloatArray(input.size)
        val frame = FloatArray(n)
        var i = 0
        while (i + n <= input.size) {
            System.arraycopy(input, i, frame, 0, n)
            df.process(frame)
            System.arraycopy(frame, 0, out, i, n)
            i += n
        }
        df.close()
        return out
    }

    private fun rms(a: FloatArray, from: Int = 0, to: Int = a.size): Double {
        var s = 0.0
        for (k in from until to) s += a[k].toDouble() * a[k]
        return sqrt(s / (to - from))
    }

    private fun db(x: Double) = 20 * log10(x)

    @Test
    fun whiteNoiseIsAttenuated() {
        val rnd = java.util.Random(1)
        val noise = FloatArray(48_000 * 4) { (rnd.nextGaussian() * 0.05).toFloat() }
        val t0 = System.nanoTime()
        val out = run(noise)
        val ms = (System.nanoTime() - t0) / 1e6
        val skip = 48_000 // let the model settle
        val atten = db(rms(noise, skip)) - db(rms(out, skip))
        Log.i(TAG, "white noise attenuated by %.1f dB; 4 s of audio processed in %.0f ms".format(atten, ms))
        assertTrue("only %.1f dB quieter".format(atten), atten > 20)
        assertTrue("too slow for real time: $ms ms for 4000 ms", ms < 4000)
    }

    @Test
    fun speechInNoiseKeepsItsLevel() {
        val dir = File("/data/local/tmp/df")
        val cleanF = File(dir, "clean.f32"); val noiseF = File(dir, "noise.f32")
        if (!cleanF.exists() || !noiseF.exists()) { Log.i(TAG, "no speech samples pushed; skipped"); return }
        val clean = read(cleanF); val noise = read(noiseF)
        val len = minOf(clean.size, noise.size)
        // 0 dB SNR mix.
        val g = rms(clean, 0, len) / rms(noise, 0, len)
        val mix = FloatArray(len) { (clean[it] + noise[it] * g).toFloat() }
        val out = run(mix)
        // DeepFilterNet delays the signal; find the lag that best matches the clean speech.
        var best = 0; var bestC = Double.NEGATIVE_INFINITY
        for (lag in 0..2400 step 4) {
            var c = 0.0
            for (k in 48_000 until len - lag step 8) c += clean[k].toDouble() * out[k + lag]
            if (c > bestC) { bestC = c; best = lag }
        }
        val from = 48_000; val to = len - best
        var sig = 0.0; var err = 0.0; var errIn = 0.0
        for (k in from until to) {
            sig += clean[k].toDouble() * clean[k]
            val e = out[k + best] - clean[k]; err += e * e
            val ei = mix[k] - clean[k]; errIn += ei * ei
        }
        val snrIn = 10 * log10(sig / errIn); val snrOut = 10 * log10(sig / err)
        val level = db(rms(out, from + best, to + best)) - db(rms(clean, from, to))
        Log.i(TAG, "speech+noise: lag $best samples, SNR %.1f -> %.1f dB, output vs clean speech level %.1f dB".format(snrIn, snrOut, level))
        assertTrue("SNR did not improve", snrOut > snrIn + 5)
        assertTrue("speech lost %.1f dB".format(level), level > -6)
    }

    @Test
    fun whiteNoiseIsAttenuatedAt16kViaResampler() {
        // Bluetooth HFP wideband: 160-sample frames, resampled around the 48 kHz model.
        val df = DeepFilter.create(100f)!!
        val rs = Resampler48(3)
        val rnd = java.util.Random(2)
        val noise = FloatArray(16_000 * 4) { (rnd.nextGaussian() * 0.05).toFloat() }
        val out = FloatArray(noise.size)
        val low = FloatArray(160); val high = FloatArray(480)
        for (f in 0 until noise.size / 160) {
            System.arraycopy(noise, f * 160, low, 0, 160)
            rs.up(low, high); df.process(high); rs.down(high, low)
            System.arraycopy(low, 0, out, f * 160, 160)
        }
        df.close()
        val atten = db(rms(noise, 16_000)) - db(rms(out, 16_000))
        Log.i(TAG, "16 kHz white noise attenuated by %.1f dB".format(atten))
        assertTrue("only %.1f dB quieter".format(atten), atten > 15)
    }

    private fun read(f: File): FloatArray {
        val b = ByteBuffer.wrap(f.readBytes()).order(ByteOrder.LITTLE_ENDIAN).asFloatBuffer()
        return FloatArray(b.remaining()).also { b.get(it) }
    }

    private companion object { const val TAG = "DeepFilterTest" }
}
