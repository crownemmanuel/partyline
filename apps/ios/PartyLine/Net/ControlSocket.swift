import Foundation
import os

/// One control WebSocket connection to /api/ws (PROTOCOL §3). Reconnect policy lives in
/// SessionCoordinator; this object is a single attempt that ends with `.closed`.
@MainActor
final class ControlSocket {
    enum Event {
        case opened
        case event(ServerEvent)
        case closed(reason: String)
    }

    private let log = Logger(subsystem: "com.partyline.app", category: "ws")
    private let session: URLSession
    private let delegate: PinningDelegate
    private var task: URLSessionWebSocketTask?
    private var pingTask: Task<Void, Never>?
    private var lastInbound = Date()
    private var nextId = 0
    private var closed = false

    /// AsyncStream of everything the socket produces, in order.
    let events: AsyncStream<Event>
    private let continuation: AsyncStream<Event>.Continuation

    init(address: ServerAddress, pin: String) {
        delegate = PinningDelegate(pin: pin)
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 10
        config.networkServiceType = .callSignaling
        config.shouldUseExtendedBackgroundIdleMode = true
        session = URLSession(configuration: config, delegate: delegate, delegateQueue: nil)
        (events, continuation) = AsyncStream.makeStream(of: Event.self)

        var c = URLComponents()
        c.scheme = "wss"; c.host = address.host; c.port = address.port; c.path = "/api/ws"
        guard let url = c.url else {
            continuation.yield(.closed(reason: "bad address")); continuation.finish(); closed = true
            return
        }
        let task = session.webSocketTask(with: url)
        task.maximumMessageSize = 8 * 1024 * 1024
        self.task = task
        delegate.onWebSocketOpen = { [weak self] in Task { @MainActor in self?.continuation.yield(.opened) } }
        delegate.onWebSocketClose = { [weak self] code in Task { @MainActor in self?.finish("closed by server (\(code.rawValue))") } }
    }

    func connect(deviceToken: String) {
        guard let task, !closed else { return }
        task.resume()
        lastInbound = Date()
        send(.auth(deviceToken: deviceToken))
        receiveLoop()
        pingTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 15_000_000_000)
                guard let self, !Task.isCancelled else { return }
                if Date().timeIntervalSince(self.lastInbound) > 30 {
                    self.finish("no pong for 30 s")
                    return
                }
                self.send(.ping)
            }
        }
    }

    /// Sends a message. Returns the envelope id used (if `withId`) so callers can match ack/error.
    @discardableResult
    func send(_ msg: ClientMessage, withId: Bool = false) -> String? {
        guard let task, !closed else { return nil }
        var id: String?
        if withId { nextId += 1; id = "c-\(nextId)" }
        do {
            let data = try msg.encode(id: id)
            task.send(.string(String(decoding: data, as: UTF8.self))) { [weak self] error in
                if let error { Task { @MainActor in self?.finish("send failed: \(error.localizedDescription)") } }
            }
        } catch {
            log.error("encode failed: \(error.localizedDescription)")
        }
        return id
    }

    func close() {
        finish("closed by client")
    }

    private func receiveLoop() {
        task?.receive { [weak self] result in
            Task { @MainActor in
                guard let self, !self.closed else { return }
                switch result {
                case let .failure(error):
                    self.finish(error.localizedDescription)
                case let .success(message):
                    self.lastInbound = Date()
                    let data: Data
                    switch message {
                    case let .string(s): data = Data(s.utf8)
                    case let .data(d): data = d
                    @unknown default: data = Data()
                    }
                    do {
                        self.continuation.yield(.event(try ServerEvent.decode(data)))
                    } catch {
                        self.log.error("decode failed: \(error.localizedDescription) \(String(decoding: data.prefix(300), as: UTF8.self))")
                    }
                    self.receiveLoop()
                }
            }
        }
    }

    private func finish(_ reason: String) {
        guard !closed else { return }
        closed = true
        pingTask?.cancel()
        task?.cancel(with: .goingAway, reason: nil)
        session.invalidateAndCancel()
        log.info("socket closed: \(reason)")
        continuation.yield(.closed(reason: reason))
        continuation.finish()
    }
}
