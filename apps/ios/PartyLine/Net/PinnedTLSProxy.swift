import Foundation
import Network
import os

/// Loopback TCP → pinned TLS byte pipe for LiveKit signaling.
///
/// The LiveKit Swift SDK opens its signaling WebSocket with its own URLSession and no hook for
/// custom trust, so it rejects the host's self-signed cert. Instead of weakening trust, LiveKit
/// connects to `ws://127.0.0.1:<port>/rtc` and every byte is forwarded to `host:8443` over TLS
/// that only accepts the pinned fingerprint. Media (DTLS-SRTP over UDP) does not go through here.
final class PinnedTLSProxy: @unchecked Sendable {
    private let log = Logger(subsystem: "com.partyline.app", category: "proxy")
    private let queue = DispatchQueue(label: "partyline.tlsproxy")
    private var listener: NWListener?
    private var upstream: (host: String, port: Int, pin: String)?
    private var pipes: [ObjectIdentifier: Pipe] = [:]
    private(set) var localPort: UInt16 = 0

    /// Starts (once) and points at the given upstream. Returns the loopback port.
    func start(host: String, port: Int, pin: String) async throws -> UInt16 {
        queue.sync { upstream = (host, port, Fingerprint.normalize(pin)) }
        if let listener, listener.state == .ready, localPort != 0 { return localPort }
        listener?.cancel()

        let params = NWParameters.tcp
        params.requiredLocalEndpoint = NWEndpoint.hostPort(host: .ipv4(.loopback), port: .any)
        params.allowLocalEndpointReuse = true
        let l = try NWListener(using: params)
        listener = l
        l.newConnectionHandler = { [weak self] conn in self?.accept(conn) }

        return try await withCheckedThrowingContinuation { (cont: CheckedContinuation<UInt16, Error>) in
            let once = Once()
            l.stateUpdateHandler = { [weak self] state in
                guard let self else { return }
                switch state {
                case .ready:
                    self.localPort = l.port?.rawValue ?? 0
                    if once.claim() { cont.resume(returning: self.localPort) }
                case let .failed(error):
                    self.log.error("listener failed: \(error.localizedDescription)")
                    self.localPort = 0
                    if once.claim() { cont.resume(throwing: error) }
                default: break
                }
            }
            l.start(queue: queue)
        }
    }

    func stop() {
        queue.async {
            self.listener?.cancel()
            self.listener = nil
            self.localPort = 0
            self.pipes.values.forEach { $0.cancel() }
            self.pipes.removeAll()
        }
    }

    private func accept(_ inbound: NWConnection) {
        guard let up = upstream else { inbound.cancel(); return }
        let tls = NWProtocolTLS.Options()
        let pin = up.pin
        sec_protocol_options_set_verify_block(tls.securityProtocolOptions, { _, secTrust, complete in
            let trust = sec_trust_copy_ref(secTrust).takeRetainedValue()
            complete(Fingerprint.ofLeaf(trust: trust) == pin)
        }, queue)
        let tcp = NWProtocolTCP.Options()
        tcp.noDelay = true
        tcp.enableKeepalive = true
        let params = NWParameters(tls: tls, tcp: tcp)
        params.serviceClass = .signaling
        let outbound = NWConnection(host: NWEndpoint.Host(up.host), port: NWEndpoint.Port(integerLiteral: UInt16(up.port)), using: params)

        let pipe = Pipe(a: inbound, b: outbound, queue: queue)
        let key = ObjectIdentifier(pipe)
        pipes[key] = pipe
        pipe.onDone = { [weak self] in self?.pipes[key] = nil }
        pipe.start()
    }

    private final class Pipe {
        let a: NWConnection, b: NWConnection
        let queue: DispatchQueue
        var onDone: (() -> Void)?
        private var done = false

        init(a: NWConnection, b: NWConnection, queue: DispatchQueue) { self.a = a; self.b = b; self.queue = queue }

        func start() {
            for c in [a, b] {
                c.stateUpdateHandler = { [weak self] state in
                    switch state {
                    case .failed, .cancelled: self?.cancel()
                    default: break
                    }
                }
                c.start(queue: queue)
            }
            pump(from: a, to: b)
            pump(from: b, to: a)
        }

        private func pump(from src: NWConnection, to dst: NWConnection) {
            src.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, isComplete, error in
                guard let self, !self.done else { return }
                if let data, !data.isEmpty {
                    dst.send(content: data, completion: .contentProcessed { [weak self] err in
                        if err != nil { self?.cancel() }
                    })
                }
                if isComplete || error != nil {
                    self.cancel()
                    return
                }
                self.pump(from: src, to: dst)
            }
        }

        func cancel() {
            guard !done else { return }
            done = true
            a.cancel(); b.cancel()
            onDone?()
        }
    }
}
