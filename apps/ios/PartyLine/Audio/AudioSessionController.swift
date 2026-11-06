import AVFoundation
import LiveKit
import os

/// Owns AVAudioSession configuration and gates the LiveKit engine on session activation.
@MainActor
final class AudioSessionController: ObservableObject {
    enum Route: String { case headset, speaker, earpiece, bluetooth }

    @Published private(set) var route: Route = .earpiece
    @Published private(set) var isActive = false

    var onRouteChange: (() -> Void)?
    var onInterruption: ((_ began: Bool, _ shouldResume: Bool) -> Void)?

    private let log = Logger(subsystem: "com.partyline.app", category: "audio")
    private var observers: [NSObjectProtocol] = []

    var hasHeadset: Bool { route == .headset || route == .bluetooth }

    init() {
        AudioManager.shared.audioSession.isAutomaticConfigurationEnabled = false
        // Engine stays off until CallKit hands us an active session.
        try? AudioManager.shared.setEngineAvailability(.none)

        let nc = NotificationCenter.default
        observers.append(nc.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.refreshRoute() }
        })
        observers.append(nc.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] n in
            let raw = n.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
            guard let raw, let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
            let options = AVAudioSession.InterruptionOptions(rawValue: n.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0)
            Task { @MainActor in self?.onInterruption?(type == .began, options.contains(.shouldResume)) }
        })
        observers.append(nc.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in
                self?.log.error("media services reset; reconfiguring")
                self?.configure()
            }
        })
        refreshRoute()
    }

    /// Category and mode. Called before CallKit activates the session.
    func configure() {
        let s = AVAudioSession.sharedInstance()
        do {
            #if compiler(>=6.2)
            let options: AVAudioSession.CategoryOptions = [.allowBluetoothHFP, .allowBluetoothA2DP]
            #else
            let options: AVAudioSession.CategoryOptions = [.allowBluetooth, .allowBluetoothA2DP]
            #endif
            try s.setCategory(.playAndRecord, mode: .voiceChat, options: options)
            try s.setPreferredIOBufferDuration(0.01)
            try? s.setPreferredSampleRate(48000)
        } catch {
            log.error("configure failed: \(error.localizedDescription)")
        }
    }

    /// CallKit `didActivate`: let LiveKit's engine run.
    func didActivate() {
        isActive = true
        do { try AudioManager.shared.setEngineAvailability(.default) } catch { log.error("engine enable failed: \(error.localizedDescription)") }
        refreshRoute()
    }

    /// CallKit `didDeactivate` (call ended or put on hold by a real call).
    func didDeactivate() {
        isActive = false
        try? AudioManager.shared.setEngineAvailability(.none)
    }

    /// A joined intercom owns its own voice-chat session while the screen is locked.
    func activateWithoutCallKit() throws {
        configure()
        try AVAudioSession.sharedInstance().setActive(true)
        didActivate()
    }

    func deactivateWithoutCallKit() {
        didDeactivate()
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func refreshRoute() {
        let outputs = AVAudioSession.sharedInstance().currentRoute.outputs
        let new: Route = outputs.reduce(.earpiece) { acc, port in
            switch port.portType {
            case .headphones, .usbAudio, .lineOut: return .headset
            case .bluetoothHFP, .bluetoothA2DP, .bluetoothLE, .carAudio, .airPlay: return .bluetooth
            case .builtInSpeaker: return acc == .earpiece ? .speaker : acc
            default: return acc
            }
        }
        if new != route {
            log.info("route → \(new.rawValue)")
            route = new
            onRouteChange?()
        }
    }
}
