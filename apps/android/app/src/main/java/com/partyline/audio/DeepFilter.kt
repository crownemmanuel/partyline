package com.partyline.audio

import android.util.Log

/**
 * DeepFilterNet3 through `libdfjni.so` (built by `native/build-native.sh`, model compiled in).
 * One instance is one stateful mono denoiser: 48 kHz, [frameLength] samples (10 ms) per call.
 * Not thread-safe: feed it from one audio thread.
 */
class DeepFilter private constructor(private var handle: Long) {
    val frameLength: Int = nativeFrameLength(handle)
    val sampleRate: Int = nativeSampleRate(handle)

    /** Denoises [frame] (samples in [-1, 1]) in place. Returns false if the frame was left as is. */
    fun process(frame: FloatArray): Boolean = handle != 0L && !nativeProcess(handle, frame).isNaN()

    fun setAttenuationLimit(db: Float) { if (handle != 0L) nativeSetAttenLim(handle, db) }

    fun close() {
        val h = handle
        handle = 0
        if (h != 0L) nativeFree(h)
    }

    companion object {
        private const val TAG = "DeepFilter"

        /** False if the native library is missing for this ABI or failed to load. */
        val available: Boolean by lazy {
            runCatching { System.loadLibrary("dfjni") }
                .onFailure { Log.w(TAG, "libdfjni not loaded: ${it.message}") }
                .isSuccess
        }

        /** Loads the model (a few hundred ms; call off the audio thread). Null if unavailable. */
        fun create(attenuationLimitDb: Float): DeepFilter? {
            if (!available) return null
            val h = runCatching { nativeCreate(attenuationLimitDb) }.getOrDefault(0L)
            return if (h == 0L) null else DeepFilter(h)
        }

        @JvmStatic private external fun nativeCreate(attenLimDb: Float): Long
        @JvmStatic private external fun nativeFrameLength(handle: Long): Int
        @JvmStatic private external fun nativeSampleRate(handle: Long): Int
        @JvmStatic private external fun nativeProcess(handle: Long, frame: FloatArray): Float
        @JvmStatic private external fun nativeSetAttenLim(handle: Long, attenLimDb: Float)
        @JvmStatic private external fun nativeFree(handle: Long)
    }
}
