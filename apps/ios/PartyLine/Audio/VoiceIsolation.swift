import Foundation
import LiveKit
import os
#if canImport(DeepFilterC)
import DeepFilterC
#endif

/// What the "Voice isolation" button actually does on this device.
enum VoiceIsolationEngine: Equatable {
    /// DeepFilterNet3 on the outgoing mic (same model as web/desktop); WebRTC noise suppression off.
    case deepFilter
    /// libDF or its model is missing, or the mic runs at a rate DFN can't take: WebRTC noise suppression.
    case basic
    case off
}

/// On-device DeepFilterNet3 noise removal, run as LiveKit's capture post-processing step
/// (after echo cancellation and AGC, before the encoder). Fully offline: the model ships in the app.
/// Built from libDF's C API by `scripts/build-libdf.sh`; without it this compiles to a pass-through
/// and `isAvailable` is false, so the app falls back to `.basic`.
final class VoiceIsolationProcessor: NSObject, AudioCustomProcessingDelegate, @unchecked Sendable {
    static let modelName = "DeepFilterNet3_onnx"
    static let sampleRate = 48_000
    /// Same as the web client: let DFN remove as much noise as it can.
    static let attenuationLimitDb: Float = 100

    static var modelURL: URL? { Bundle.main.url(forResource: modelName, withExtension: "tar.gz") }

    static var isAvailable: Bool {
        #if canImport(DeepFilterC)
        return modelURL != nil
        #else
        return false
        #endif
    }

    var audioProcessingName: String { "deepfilternet3" }

    /// False once the audio unit reports a rate DFN can't run at; the coordinator then shows "basic".
    private(set) var rateSupported = true
    var onRateUnsupported: (() -> Void)?

    private let log = Logger(subsystem: "com.partyline.app", category: "voice-isolation")
    private let lock = NSLock()
    private var active = false
    #if canImport(DeepFilterC)
    private var df: OpaquePointer?
    #endif
    private var hop = 0
    private var inFifo: [Float] = []
    private var outFifo: [Float] = []
    private var frameIn: [Float] = []
    private var frameOut: [Float] = []

    /// Loads the model off the audio thread (takes ~100 ms). Safe to call more than once.
    func prepare() {
        #if canImport(DeepFilterC)
        lock.lock()
        defer { lock.unlock() }
        guard df == nil, let path = Self.modelURL?.path else { return }
        let st = path.withCString { df_create($0, Self.attenuationLimitDb, nil) }
        guard let st else { log.error("df_create failed"); return }
        df = st
        hop = Int(df_get_frame_length(st))
        frameIn = [Float](repeating: 0, count: hop)
        frameOut = [Float](repeating: 0, count: hop)
        log.info("DeepFilterNet3 loaded, hop \(self.hop)")
        #endif
    }

    // MARK: AudioCustomProcessingDelegate (audio thread)

    func audioProcessingInitialize(sampleRate sampleRateHz: Int, channels: Int) {
        lock.lock()
        rateSupported = sampleRateHz == Self.sampleRate
        active = rateSupported
        resetFifos()
        lock.unlock()
        if !rateSupported {
            log.error("mic runs at \(sampleRateHz) Hz, DeepFilterNet needs 48 kHz; passing through")
            onRateUnsupported?()
        }
    }

    func audioProcessingProcess(audioBuffer: LKAudioBuffer) {
        #if canImport(DeepFilterC)
        // Never block the audio thread; skip a buffer rather than wait for prepare()/release.
        guard lock.try() else { return }
        defer { lock.unlock() }
        guard active, let df, hop > 0 else { return }
        let n = audioBuffer.frames
        let samples = audioBuffer.rawBuffer(forChannel: 0)
        // WebRTC hands float samples on the int16 scale; DFN wants [-1, 1].
        if n == hop, inFifo.isEmpty, outFifo.isEmpty {
            for i in 0 ..< n { frameIn[i] = samples[i] / 32768 }
            _ = frameIn.withUnsafeMutableBufferPointer { i in
                frameOut.withUnsafeMutableBufferPointer { o in df_process_frame(df, i.baseAddress, o.baseAddress) }
            }
            for i in 0 ..< n { samples[i] = frameOut[i] * 32768 }
        } else {
            // Buffer size isn't one hop: re-block through FIFOs (adds one hop of latency).
            if outFifo.isEmpty { outFifo.append(contentsOf: repeatElement(0, count: hop)) }
            for i in 0 ..< n { inFifo.append(samples[i] / 32768) }
            while inFifo.count >= hop {
                for i in 0 ..< hop { frameIn[i] = inFifo[i] }
                inFifo.removeFirst(hop)
                _ = frameIn.withUnsafeMutableBufferPointer { i in
                    frameOut.withUnsafeMutableBufferPointer { o in df_process_frame(df, i.baseAddress, o.baseAddress) }
                }
                outFifo.append(contentsOf: frameOut)
            }
            let ready = min(n, outFifo.count)
            for i in 0 ..< ready { samples[i] = outFifo[i] * 32768 }
            for i in ready ..< n { samples[i] = 0 }
            outFifo.removeFirst(ready)
        }
        for ch in 1 ..< max(audioBuffer.channels, 1) {
            audioBuffer.rawBuffer(forChannel: ch).update(from: samples, count: n)
        }
        #endif
    }

    func audioProcessingRelease() {
        lock.lock()
        active = false
        resetFifos()
        lock.unlock()
    }

    private func resetFifos() {
        inFifo.removeAll(keepingCapacity: true)
        outFifo.removeAll(keepingCapacity: true)
        inFifo.reserveCapacity(4 * max(hop, 480))
        outFifo.reserveCapacity(4 * max(hop, 480))
    }

    deinit {
        #if canImport(DeepFilterC)
        if let df { df_free(df) }
        #endif
    }
}
