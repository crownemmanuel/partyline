import Foundation
import Network
import os

struct DiscoveredServer: Identifiable, Equatable {
    var id: String { serverId ?? serviceName }
    var serviceName: String
    var serverId: String?
    var name: String
    var fingerprint: String?
    var apiVersion: String?
    fileprivate var endpoint: NWEndpoint
    var lastSeen = Date()

    static func == (a: Self, b: Self) -> Bool {
        a.serviceName == b.serviceName && a.serverId == b.serverId && a.name == b.name && a.fingerprint == b.fingerprint
    }
}

/// Browses `_partyline._tcp` (PROTOCOL §1) and resolves a result to an IPv4 host:port.
@MainActor
final class BonjourBrowser: ObservableObject {
    @Published private(set) var servers: [DiscoveredServer] = []
    @Published private(set) var isBrowsing = false
    @Published private(set) var error: String?

    private let log = Logger(subsystem: "com.partyline.app", category: "bonjour")
    private var browser: NWBrowser?
    private var lastSeenById: [String: Date] = [:]

    func start() {
        guard browser == nil else { return }
        let params = NWParameters()
        params.includePeerToPeer = false
        let b = NWBrowser(for: .bonjourWithTXTRecord(type: "_partyline._tcp", domain: nil), using: params)
        b.stateUpdateHandler = { [weak self] state in
            Task { @MainActor in
                switch state {
                case .ready: self?.isBrowsing = true; self?.error = nil
                case let .failed(e): self?.error = e.localizedDescription; self?.restart()
                case let .waiting(e): self?.error = e.localizedDescription
                default: break
                }
            }
        }
        b.browseResultsChangedHandler = { [weak self] results, _ in
            Task { @MainActor in self?.update(results) }
        }
        b.start(queue: .main)
        browser = b
    }

    func stop() {
        browser?.cancel()
        browser = nil
        isBrowsing = false
    }

    private func restart() {
        stop()
        Task { try? await Task.sleep(nanoseconds: 2_000_000_000); start() }
    }

    private func update(_ results: Set<NWBrowser.Result>) {
        let now = Date()
        servers = results.compactMap { r in
            guard case let .service(name, _, _, _) = r.endpoint else { return nil }
            var txt: [String: String] = [:]
            if case let .bonjour(record) = r.metadata { txt = record.dictionary }
            let s = DiscoveredServer(serviceName: name, serverId: txt["id"], name: txt["name"] ?? name,
                                     fingerprint: txt["fp"].map(Fingerprint.normalize), apiVersion: txt["v"],
                                     endpoint: r.endpoint, lastSeen: now)
            if let id = s.serverId { lastSeenById[id] = now }
            return s
        }.sorted { $0.name < $1.name }
        log.info("servers: \(self.servers.map(\.name))")
    }

    func server(withId id: String) -> DiscoveredServer? { servers.first { $0.serverId == id } }

    /// Last time this server id was present in a browse result (nil = never this launch).
    func lastSeen(serverId: String) -> Date? {
        if server(withId: serverId) != nil { return Date() }
        return lastSeenById[serverId]
    }

    /// Resolves the service to a numeric IPv4 address + port by opening a throwaway TCP connection.
    nonisolated static func resolve(_ server: DiscoveredServer, timeout: TimeInterval = 4) async throws -> ServerAddress {
        let params = NWParameters.tcp
        if let ip = params.defaultProtocolStack.internetProtocol as? NWProtocolIP.Options { ip.version = .v4 }
        let conn = NWConnection(to: server.endpoint, using: params)
        let queue = DispatchQueue(label: "partyline.resolve")
        return try await withCheckedThrowingContinuation { cont in
            let once = Once()
            @Sendable func finish(_ r: Result<ServerAddress, Error>) {
                guard once.claim() else { return }
                conn.cancel()
                cont.resume(with: r)
            }
            conn.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    if case let .hostPort(host, port) = conn.currentPath?.remoteEndpoint {
                        var h = "\(host)"
                        if let pct = h.firstIndex(of: "%") { h = String(h[..<pct]) }
                        finish(.success(ServerAddress(host: h, port: Int(port.rawValue))))
                    } else {
                        finish(.failure(URLError(.cannotFindHost)))
                    }
                case let .failed(e): finish(.failure(e))
                case let .waiting(e): finish(.failure(e))
                default: break
                }
            }
            conn.start(queue: queue)
            queue.asyncAfter(deadline: .now() + timeout) { finish(.failure(URLError(.timedOut))) }
        }
    }
}
