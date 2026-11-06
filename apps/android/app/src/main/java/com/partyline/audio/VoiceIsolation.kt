package com.partyline.audio

import android.util.Log
import io.livekit.android.audio.AudioProcessorInterface
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * On-device voice isolation for the mic, local only (no protocol field). Same engine as the
 * web/desktop client: DeepFilterNet3, 48 kHz, attenuation limit 100 dB, as LiveKit's capture
 * post-processor. While it runs, WebRTC's own noise suppression is off (both together smear
 * speech); echo cancellation and AGC stay on.
 *
 * Capture at 16 or 8 kHz (Bluetooth HFP headsets, some mics) is resampled to 48 kHz around the
 * model. If the model cannot run (no native lib for this ABI, or another frame format)
 * the engine is [Engine.BASIC]: WebRTC's noise suppression plus the platform suppressor on the
 * VOICE_COMMUNICATION source, and the button says "basic".
 */
object VoiceIsolation : AudioProcessorInterface {
    enum class Engine { DEEP, BASIC }
    data class State(val enabled: Boolean = true, val engine: Engine = Engine.DEEP)

    private const val TAG = "VoiceIsolation"
    private const val ATTEN_LIMIT_DB = 100f
    private const val S16 = 32768f

    private val _state = MutableStateFlow(State(engine = if (DeepFilter.available) Engine.DEEP else Engine.BASIC))
    val state: StateFlow<State> = _state

    /** WebRTC's software noise suppression should run unless DeepFilterNet is doing the job. */
    val wantsWebRtcNoiseSuppression: Boolean
        get() = _state.value.let { !(it.enabled && it.engine == Engine.DEEP) }

    @Volatile private var enabled = true
    @Volatile private var filter: DeepFilter? = null
    @Volatile private var modelOk = DeepFilter.available
    /**
     * Judged from real frames only: WebRTC initialises the processor at a 16 kHz default before
     * audio flows. Sticky once false, so a mic republish cannot make the engine flap.
     */
    @Volatile private var framesOk = true
    private var frame = FloatArray(0)
    private var resampler: Resampler48? = null
    private var low = FloatArray(0)
    private var loading = false
    private var logged = false

    fun setEnabled(value: Boolean) {
        enabled = value
        _state.update { it.copy(enabled = value) }
    }

    /** Loads the model in the background so the audio thread never waits for it. */
    fun prepare() {
        synchronized(this) {
            if (filter != null || loading || !DeepFilter.available) return
            loading = true
        }
        CoroutineScope(Dispatchers.Default).launch {
            val f = DeepFilter.create(ATTEN_LIMIT_DB)
            if (f == null || f.sampleRate != 48_000) {
                Log.w(TAG, "DeepFilterNet unavailable (sr=${f?.sampleRate}); using basic suppression")
                f?.close()
                modelOk = false
                refreshEngine()
            } else {
                frame = FloatArray(f.frameLength)
                filter = f
                Log.i(TAG, "DeepFilterNet3 ready: ${f.frameLength} samples @ ${f.sampleRate} Hz")
            }
            synchronized(this@VoiceIsolation) { loading = false }
        }
    }

    private fun refreshEngine() {
        val engine = if (modelOk && framesOk) Engine.DEEP else Engine.BASIC
        _state.update { if (it.engine == engine) it else it.copy(engine = engine) }
    }

    // ---------------------------------------------------------------- AudioProcessorInterface

    override fun isEnabled(): Boolean = true  // bypassed internally, so the toggle needs no SDK call
    override fun getName(): String = "deepfilternet3"

    override fun initializeAudioProcessing(sampleRateHz: Int, numChannels: Int) = checkFormat(sampleRateHz, numChannels)
    override fun resetAudioProcessing(newRate: Int) = checkFormat(newRate, 1)

    private fun checkFormat(rate: Int, channels: Int) {
        Log.i(TAG, "capture post-processing: $rate Hz, $channels ch")
        logged = false
    }

    /** One 10 ms capture frame, float samples at int16 scale, at the capture processing rate. */
    override fun processAudio(numBands: Int, numFrames: Int, buffer: ByteBuffer) {
        if (!logged) { logged = true; Log.i(TAG, "first capture frame: $numBands band(s) x $numFrames, ${buffer.capacity()} bytes") }
        if (!enabled || !framesOk) return
        val f = filter ?: return
        // 10 ms at 48 kHz is the model's hop; 16 and 8 kHz (Bluetooth HFP, some mics) are resampled.
        val factor = if (numBands == 1 && numFrames > 0 && frame.size % numFrames == 0) frame.size / numFrames else 0
        if (factor !in 1..6) {
            Log.w(TAG, "unexpected frame: $numBands bands x $numFrames; using basic suppression")
            framesOk = false
            refreshEngine()
            return
        }
        val fb = buffer.order(ByteOrder.nativeOrder()).asFloatBuffer()
        if (factor == 1) {
            for (i in frame.indices) frame[i] = fb.get(i) / S16
            if (!f.process(frame)) return
            for (i in frame.indices) fb.put(i, frame[i] * S16)
            return
        }
        val rs = resampler?.takeIf { it.factor == factor } ?: Resampler48(factor).also { resampler = it; low = FloatArray(numFrames) }
        for (i in 0 until numFrames) low[i] = fb.get(i) / S16
        rs.up(low, frame)
        if (!f.process(frame)) return
        rs.down(frame, low)
        for (i in 0 until numFrames) fb.put(i, low[i] * S16)
    }
}
