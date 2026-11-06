import Foundation

// WebSocket envelope and REST bodies, PROTOCOL.md §2 and §3.

enum API {
    static let version = 1
    static var appVersion: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.1.0"
    }
}

// MARK: REST

struct InfoResponse: Codable, Equatable {
    var apiVersion: Int
    var serverId: String
    var name: String
    var appVersion: String?
    var fingerprint: String?
    var joinOpen: Bool?
    var livekitUrl: String?
    var minClientVersion: String?
}

struct JoinRequest: Codable {
    var joinCode: String
    var deviceId: String
    var displayName: String
    var platform = "ios"
    var appVersion = API.appVersion
    var apiVersion = API.version
}

struct SessionRequest: Codable {
    var appVersion = API.appVersion
    var apiVersion = API.version
}

/// Response to both /api/join and /api/session (session has no deviceToken).
struct SessionResponse: Codable {
    var deviceToken: String?
    var livekitToken: String
    var livekitUrl: String?
    var roomName: String?
    var me: Device
    var groups: [TalkGroup]
}

struct APIErrorBody: Codable {
    struct Inner: Codable { var code: String; var message: String? }
    var error: Inner
}

// MARK: WebSocket, client → server

struct StateSet: Codable, Equatable {
    var talkTargets: [TargetRef]?
    var listenGroupIds: [String]?
    var micLive: Bool?
    var speakerMuted: Bool?
    var talkMode: TalkMode?
}

struct StatusReport: Codable, Equatable {
    var rtcConnected: Bool
    var speaking: Bool
    var battery: Int?
    var charging: Bool?
    var headset: Bool?
    var rttMs: Double?
    var outputRoute: String?
}

enum ClientMessage {
    case auth(deviceToken: String)
    case ping
    case stateSet(StateSet)
    case status(StatusReport)
    case messageSend(to: TargetRef, text: String, kind: MessageKind)
    case messageAck(messageId: String)
    case signalSend(to: TargetRef)
    case tokenRefresh

    var type: String {
        switch self {
        case .auth: "auth"
        case .ping: "ping"
        case .stateSet: "state.set"
        case .status: "status"
        case .messageSend: "message.send"
        case .messageAck: "message.ack"
        case .signalSend: "signal.send"
        case .tokenRefresh: "token.refresh"
        }
    }

    private struct Envelope<P: Encodable>: Encodable {
        var type: String
        var id: String?
        var ts: String
        var payload: P
    }

    private struct Empty: Codable {}
    private struct Auth: Codable { var deviceToken: String; var appVersion: String }
    private struct Send: Codable { var to: String; var text: String; var kind: MessageKind }
    private struct Ack: Codable { var messageId: String }
    private struct To: Codable { var to: String }

    func encode(id: String? = nil, now: Date = Date()) throws -> Data {
        let ts = Wire.isoFormatter.string(from: now)
        let enc = JSONEncoder()
        func wrap<P: Encodable>(_ p: P) throws -> Data { try enc.encode(Envelope(type: type, id: id, ts: ts, payload: p)) }
        switch self {
        case let .auth(token): return try wrap(Auth(deviceToken: token, appVersion: API.appVersion))
        case .ping, .tokenRefresh: return try wrap(Empty())
        case let .stateSet(s): return try wrap(s)
        case let .status(s): return try wrap(s)
        case let .messageSend(to, text, kind): return try wrap(Send(to: to, text: text, kind: kind))
        case let .messageAck(mid): return try wrap(Ack(messageId: mid))
        case let .signalSend(to): return try wrap(To(to: to))
        }
    }
}

// MARK: WebSocket, server → client

struct Welcome: Codable {
    var me: Device
    var devices: [Device]
    var groups: [TalkGroup]
    var server: ServerInfo?
    var settings: Settings?
    var livekitToken: String?
    var roomName: String?
    var messages: [Message]?
}

struct AdminNotice: Codable, Equatable {
    var kind: String
    var text: String
}

struct SignalEvent: Codable, Equatable {
    var from: String
    var to: TargetRef
}

struct ServerError: Codable, Equatable {
    var replyTo: String?
    var code: String
    var message: String?
}

enum ServerEvent {
    case welcome(Welcome)
    case ack(replyTo: String)
    case error(ServerError)
    case pong
    case deviceUpsert(Device)
    case deviceRemoved(deviceId: String)
    case groupsUpdated([TalkGroup])
    case serverUpdated(ServerInfo)
    case settingsUpdated(Settings)
    case message(Message)
    case messageAcked(messageId: String, deviceId: String)
    case signal(SignalEvent)
    case tokenRefreshed(livekitToken: String)
    case adminNotice(AdminNotice)
    case kicked(reason: String)
    case serverShutdown(reconnectAfterMs: Int)
    case unknown(type: String)

    private struct Head: Decodable { var type: String }
    private struct Body<P: Decodable>: Decodable { var payload: P }
    private struct ReplyTo: Decodable { var replyTo: String }
    private struct DeviceIdOnly: Decodable { var deviceId: String }
    private struct GroupsBody: Decodable { var groups: [TalkGroup] }
    private struct Acked: Decodable { var messageId: String; var deviceId: String }
    private struct Token: Decodable { var livekitToken: String }
    private struct Kicked: Decodable { var reason: String? }
    private struct Shutdown: Decodable { var reconnectAfterMs: Int? }

    static func decode(_ data: Data) throws -> ServerEvent {
        let dec = JSONDecoder()
        let type = try dec.decode(Head.self, from: data).type
        func p<P: Decodable>(_: P.Type) throws -> P { try dec.decode(Body<P>.self, from: data).payload }
        switch type {
        case "welcome": return .welcome(try p(Welcome.self))
        case "ack": return .ack(replyTo: try p(ReplyTo.self).replyTo)
        case "error": return .error(try p(ServerError.self))
        case "pong": return .pong
        case "device.upsert": return .deviceUpsert(try p(Device.self))
        case "device.removed": return .deviceRemoved(deviceId: try p(DeviceIdOnly.self).deviceId)
        case "groups.updated": return .groupsUpdated(try p(GroupsBody.self).groups)
        case "server.updated": return .serverUpdated(try p(ServerInfo.self))
        case "settings.updated": return .settingsUpdated(try p(Settings.self))
        case "message": return .message(try p(Message.self))
        case "message.acked":
            let a = try p(Acked.self)
            return .messageAcked(messageId: a.messageId, deviceId: a.deviceId)
        case "signal": return .signal(try p(SignalEvent.self))
        case "token.refreshed": return .tokenRefreshed(livekitToken: try p(Token.self).livekitToken)
        case "admin.notice": return .adminNotice(try p(AdminNotice.self))
        case "kicked": return .kicked(reason: (try? p(Kicked.self).reason) ?? "removed_by_admin")
        case "server.shutdown": return .serverShutdown(reconnectAfterMs: (try? p(Shutdown.self).reconnectAfterMs) ?? 3000)
        default: return .unknown(type: type)
        }
    }
}

enum Wire {
    static let isoFormatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    /// Join link: `https://<ip>:8443/#join?code=<6 digits>&fp=<fp>&id=<server uuid>` (PROTOCOL §1).
    struct JoinLink: Equatable {
        var host: String
        var port: Int
        var code: String?
        var fingerprint: String?
        var serverId: String?
    }

    static func parseJoinLink(_ string: String) -> JoinLink? {
        guard let url = URL(string: string.trimmingCharacters(in: .whitespacesAndNewlines)),
              let host = url.host, !host.isEmpty else { return nil }
        var link = JoinLink(host: host, port: url.port ?? 8443)
        // `#join?code=…` and the host's "Get the app" page `#install&code=…` carry the same fields.
        if let fragment = url.fragment, let prefix = ["join", "install"].first(where: fragment.hasPrefix) {
            let query = fragment.dropFirst(prefix.count).drop(while: { $0 == "?" || $0 == "&" })
            for pair in query.split(separator: "&") {
                let kv = pair.split(separator: "=", maxSplits: 1).map { String($0).removingPercentEncoding ?? String($0) }
                guard kv.count == 2 else { continue }
                switch kv[0] {
                case "code": link.code = kv[1]
                case "fp": link.fingerprint = kv[1].lowercased()
                case "id": link.serverId = kv[1]
                default: break
                }
            }
        }
        return link
    }
}
