import AVFoundation
import CallKit
import os

/// Owns intercom audio while joined. On older phones CallKit provides the lock-screen controls.
@MainActor
final class CallController: NSObject, ObservableObject {
    enum State: Equatable { case idle, starting, connecting, connected, held, failed(String) }

    @Published private(set) var state: State = .idle
    @Published private(set) var isMuted = false

    /// Lock-screen / headset Mute (hard mic mute).
    var onMuteChanged: ((Bool) -> Void)?
    /// User ended the call from the system UI.
    var onEnded: (() -> Void)?
    var onHoldChanged: ((Bool) -> Void)?

    private let log = Logger(subsystem: "com.partyline.app", category: "callkit")
    private lazy var provider: CXProvider = {
        let config = CXProviderConfiguration()
        config.supportsVideo = false
        config.maximumCallGroups = 1
        config.maximumCallsPerCallGroup = 1
        config.supportedHandleTypes = [.generic]
        config.includesCallsInRecents = false
        return CXProvider(configuration: config)
    }()
    private lazy var controller = CXCallController()
    private let audio: AudioSessionController
    private(set) var callId: UUID?
    private var endingLocally = false

    var isInCall: Bool { callId != nil }

    private static var useCallKit: Bool {
        // A system call can be ended by the side button. A joined intercom instead uses
        // background audio and exposes its controls through the Live Activity.
        if #available(iOS 16.2, *) { return false }
        #if targetEnvironment(simulator)
        return false
        #else
        return true
        #endif
    }

    init(audio: AudioSessionController) {
        self.audio = audio
        super.init()
        if Self.useCallKit {
            provider.setDelegate(self, queue: nil)
            controller.callObserver.setDelegate(self, queue: nil)
        } else {
            audio.onInterruption = { [weak self] began, shouldResume in
                guard let self, self.callId != nil else { return }
                if began {
                    self.audio.didDeactivate()
                    self.onHoldChanged?(true)
                } else if shouldResume {
                    self.resumeAudioIfNeeded()
                }
            }
        }
    }

    func resumeAudioIfNeeded() {
        guard !Self.useCallKit, isInCall, !audio.isActive else { return }
        do {
            try audio.activateWithoutCallKit()
            onHoldChanged?(false)
        } catch {
            log.error("resume intercom audio failed: \(error.localizedDescription)")
        }
    }

    func start(serverName: String) async throws {
        guard callId == nil else { return }
        let id = UUID()
        callId = id
        state = .starting
        guard Self.useCallKit else {
            do {
                try audio.activateWithoutCallKit()
            } catch {
                finishEnded()
                throw error
            }
            state = .connecting
            return
        }
        let handle = CXHandle(type: .generic, value: serverName)
        let action = CXStartCallAction(call: id, handle: handle)
        action.isVideo = false
        action.contactIdentifier = "PartyLine"
        do {
            try await controller.request(CXTransaction(action: action))
            let update = CXCallUpdate()
            update.remoteHandle = handle
            update.localizedCallerName = "PartyLine · \(serverName)"
            update.hasVideo = false
            update.supportsHolding = true
            update.supportsGrouping = false
            update.supportsUngrouping = false
            update.supportsDTMF = false
            provider.reportCall(with: id, updated: update)
        } catch {
            callId = nil
            let msg = (error as? CXErrorCodeRequestTransactionError)?.code == .callUUIDAlreadyExists
                ? "A call is already active." : "Could not start the call: \(error.localizedDescription). End any other call and try again."
            state = .failed(msg)
            throw error
        }
    }

    /// Room and control are up.
    func reportConnected() {
        guard let id = callId, state != .connected else { return }
        if Self.useCallKit { provider.reportOutgoingCall(with: id, connectedAt: Date()) }
        state = .connected
    }

    func end() async {
        guard let id = callId else { return }
        endingLocally = true
        defer { endingLocally = false }
        if Self.useCallKit {
            do {
                try await controller.request(CXTransaction(action: CXEndCallAction(call: id)))
            } catch {
                provider.reportCall(with: id, endedAt: Date(), reason: .remoteEnded)
                finishEnded()
            }
        } else {
            audio.deactivateWithoutCallKit()
            onHoldChanged?(false)
            finishEnded()
        }
    }

    /// App-initiated mute (mic button, admin mute) so the lock-screen Mute shows the same thing.
    func setMuted(_ muted: Bool) {
        guard muted != isMuted else { return }
        guard let id = callId, Self.useCallKit else { isMuted = muted; return }
        isMuted = muted
        Task {
            do { try await controller.request(CXTransaction(action: CXSetMutedCallAction(call: id, muted: muted))) } catch {
                log.error("set muted failed: \(error.localizedDescription)")
            }
        }
    }

    private func finishEnded() {
        callId = nil
        isMuted = false
        state = .idle
    }

    /// After a real phone call ends, take the intercom off hold without a tap (IOS.md acceptance 3).
    fileprivate func resumeIfOtherCallsEnded() {
        guard let id = callId, state == .held, Self.useCallKit else { return }
        let others = controller.callObserver.calls.filter { $0.uuid != id && !$0.hasEnded }
        guard others.isEmpty else { return }
        log.info("other call ended; resuming")
        Task {
            do { try await controller.request(CXTransaction(action: CXSetHeldCallAction(call: id, onHold: false))) } catch {
                log.error("unhold failed: \(error.localizedDescription)")
            }
        }
    }
}

extension CallController: CXCallObserverDelegate {
    nonisolated func callObserver(_ callObserver: CXCallObserver, callChanged call: CXCall) {
        Task { @MainActor in self.resumeIfOtherCallsEnded() }
    }
}

extension CallController: CXProviderDelegate {
    nonisolated func providerDidReset(_ provider: CXProvider) {
        Task { @MainActor in
            self.log.error("provider reset")
            self.audio.didDeactivate()
            let wasInCall = self.callId != nil
            self.finishEnded()
            if wasInCall { self.onEnded?() }
        }
    }

    nonisolated func provider(_ provider: CXProvider, perform action: CXStartCallAction) {
        Task { @MainActor in
            self.audio.configure()
            provider.reportOutgoingCall(with: action.callUUID, startedConnectingAt: Date())
            self.state = .connecting
            action.fulfill()
        }
    }

    nonisolated func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        Task { @MainActor in
            let local = self.endingLocally
            self.finishEnded()
            action.fulfill()
            if !local { self.onEnded?() }
        }
    }

    nonisolated func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
        Task { @MainActor in
            self.isMuted = action.isMuted
            self.onMuteChanged?(action.isMuted)
            action.fulfill()
        }
    }

    nonisolated func provider(_ provider: CXProvider, perform action: CXSetHeldCallAction) {
        Task { @MainActor in
            self.state = action.isOnHold ? .held : .connected
            self.onHoldChanged?(action.isOnHold)
            action.fulfill()
        }
    }

    nonisolated func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
        Task { @MainActor in
            self.log.info("audio session activated")
            self.audio.didActivate()
        }
    }

    nonisolated func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
        Task { @MainActor in
            self.log.info("audio session deactivated")
            self.audio.didDeactivate()
        }
    }
}
