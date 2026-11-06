import Foundation

// Types per PROTOCOL.md §3.4. Decoding is tolerant of missing optional/live fields so a
// slightly older or newer server does not take the whole roster down.

enum Platform: String, Codable { case ios, android, web, desktop }

enum TalkMode: String, Codable, CaseIterable { case ptt, latch }

typealias TargetRef = String

enum Target {
    static func group(_ id: String) -> TargetRef { "g:\(id)" }
    static func device(_ id: String) -> TargetRef { "d:\(id)" }
    static let all: TargetRef = "all"
}

struct TalkGroup: Codable, Equatable, Identifiable {
    var id: String
    var name: String
    var color: String
    var sortOrder: Int
    var defaultTalkMode: TalkMode?

    init(id: String, name: String, color: String = "#888888", sortOrder: Int = 0, defaultTalkMode: TalkMode? = nil) {
        self.id = id; self.name = name; self.color = color; self.sortOrder = sortOrder; self.defaultTalkMode = defaultTalkMode
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        color = try c.decodeIfPresent(String.self, forKey: .color) ?? "#888888"
        sortOrder = try c.decodeIfPresent(Int.self, forKey: .sortOrder) ?? 0
        defaultTalkMode = try c.decodeIfPresent(TalkMode.self, forKey: .defaultTalkMode)
    }
}

struct LiveState: Codable, Equatable {
    var online: Bool = false
    var rtcConnected: Bool = false
    var micLive: Bool = false
    var speakerMuted: Bool = false
    var talkMode: TalkMode = .ptt
    var talkTargets: [TargetRef] = []
    var speaking: Bool = false
    var battery: Int?
    var charging: Bool?
    var headset: Bool?
    var outputRoute: String?
    var rttMs: Double?

    init() {}

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        online = try c.decodeIfPresent(Bool.self, forKey: .online) ?? false
        rtcConnected = try c.decodeIfPresent(Bool.self, forKey: .rtcConnected) ?? false
        micLive = try c.decodeIfPresent(Bool.self, forKey: .micLive) ?? false
        speakerMuted = try c.decodeIfPresent(Bool.self, forKey: .speakerMuted) ?? false
        talkMode = try c.decodeIfPresent(TalkMode.self, forKey: .talkMode) ?? .ptt
        talkTargets = try c.decodeIfPresent([TargetRef].self, forKey: .talkTargets) ?? []
        speaking = try c.decodeIfPresent(Bool.self, forKey: .speaking) ?? false
        battery = try c.decodeIfPresent(Int.self, forKey: .battery)
        charging = try c.decodeIfPresent(Bool.self, forKey: .charging)
        headset = try c.decodeIfPresent(Bool.self, forKey: .headset)
        outputRoute = try c.decodeIfPresent(String.self, forKey: .outputRoute)
        rttMs = try c.decodeIfPresent(Double.self, forKey: .rttMs)
    }
}

struct Device: Codable, Equatable, Identifiable {
    var id: String
    var displayName: String
    var platform: Platform?
    var appVersion: String
    var groupId: String
    var listenGroupIds: [String]
    var canTalkGroupIds: [String]
    var isAdmin: Bool
    var forcedTalkMode: TalkMode?
    var adminMuted: Bool
    var createdAt: String?
    var lastSeenAt: String?
    var live: LiveState

    init(id: String, displayName: String, platform: Platform? = .ios, appVersion: String = "0.1.0",
         groupId: String, listenGroupIds: [String]? = nil, canTalkGroupIds: [String]? = nil,
         isAdmin: Bool = false, forcedTalkMode: TalkMode? = nil, adminMuted: Bool = false, live: LiveState = LiveState()) {
        self.id = id; self.displayName = displayName; self.platform = platform; self.appVersion = appVersion
        self.groupId = groupId
        self.listenGroupIds = listenGroupIds ?? [groupId]
        self.canTalkGroupIds = canTalkGroupIds ?? [groupId]
        self.isAdmin = isAdmin; self.forcedTalkMode = forcedTalkMode; self.adminMuted = adminMuted; self.live = live
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        displayName = try c.decodeIfPresent(String.self, forKey: .displayName) ?? "Unnamed"
        platform = try? c.decodeIfPresent(Platform.self, forKey: .platform)
        appVersion = try c.decodeIfPresent(String.self, forKey: .appVersion) ?? ""
        groupId = try c.decodeIfPresent(String.self, forKey: .groupId) ?? ""
        listenGroupIds = try c.decodeIfPresent([String].self, forKey: .listenGroupIds) ?? [groupId]
        canTalkGroupIds = try c.decodeIfPresent([String].self, forKey: .canTalkGroupIds) ?? [groupId]
        isAdmin = try c.decodeIfPresent(Bool.self, forKey: .isAdmin) ?? false
        forcedTalkMode = try c.decodeIfPresent(TalkMode.self, forKey: .forcedTalkMode)
        adminMuted = try c.decodeIfPresent(Bool.self, forKey: .adminMuted) ?? false
        createdAt = try c.decodeIfPresent(String.self, forKey: .createdAt)
        lastSeenAt = try c.decodeIfPresent(String.self, forKey: .lastSeenAt)
        live = try c.decodeIfPresent(LiveState.self, forKey: .live) ?? LiveState()
    }
}

struct ServerInfo: Codable, Equatable {
    var serverId: String
    var name: String
    var appVersion: String?
    var apiVersion: Int?
    var joinCode: String?
    var joinOpen: Bool?
    var fingerprint: String?
    var failedJoinAttempts: Int?
}

struct Settings: Codable, Equatable {
    var crewCanBroadcast: Bool = false
    var defaultTalkMode: TalkMode = .ptt
    var quickReplies: [String] = ["OK", "Standby", "Go", "Problem", "Can't hear"]
    /// Referenced by PROTOCOL §5.1 but not part of the Settings type; defaults to false.
    var adminsHearEverything: Bool = false

    init() {}

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        crewCanBroadcast = try c.decodeIfPresent(Bool.self, forKey: .crewCanBroadcast) ?? false
        defaultTalkMode = try c.decodeIfPresent(TalkMode.self, forKey: .defaultTalkMode) ?? .ptt
        quickReplies = try c.decodeIfPresent([String].self, forKey: .quickReplies) ?? Settings().quickReplies
        adminsHearEverything = try c.decodeIfPresent(Bool.self, forKey: .adminsHearEverything) ?? false
    }
}

enum MessageKind: String, Codable { case text, quick, signal }

struct Message: Codable, Equatable, Identifiable {
    var id: String
    var from: String
    var to: TargetRef
    var kind: MessageKind
    var text: String
    var ts: String
    var ackedBy: [String]?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        from = try c.decode(String.self, forKey: .from)
        to = try c.decode(String.self, forKey: .to)
        kind = (try? c.decodeIfPresent(MessageKind.self, forKey: .kind)) ?? .text
        text = try c.decodeIfPresent(String.self, forKey: .text) ?? ""
        ts = try c.decodeIfPresent(String.self, forKey: .ts) ?? ""
        ackedBy = try c.decodeIfPresent([String].self, forKey: .ackedBy)
    }

    init(id: String, from: String, to: TargetRef, kind: MessageKind, text: String, ts: String) {
        self.id = id; self.from = from; self.to = to; self.kind = kind; self.text = text; self.ts = ts
    }
}

// MARK: - Roster

/// In-memory roster. The server is the source of truth; `welcome` replaces, `device.upsert` replaces by id.
struct Roster: Equatable {
    var devices: [String: Device] = [:]
    var groups: [TalkGroup] = []
    var settings = Settings()

    mutating func replace(devices list: [Device]) {
        devices = Dictionary(list.map { ($0.id, $0) }, uniquingKeysWith: { _, b in b })
    }

    func group(_ id: String) -> TalkGroup? { groups.first { $0.id == id } }

    /// Messages can come from the host itself (not a roster device).
    func name(of deviceId: String) -> String { devices[deviceId]?.displayName ?? "Host" }

    /// "Reply to producer" target: first online admin that is not me (PROTOCOL §6.4).
    func firstOnlineAdmin(excluding me: String) -> Device? {
        devices.values
            .filter { $0.isAdmin && $0.id != me && $0.live.online }
            .sorted { ($0.createdAt ?? $0.id) < ($1.createdAt ?? $1.id) }
            .first
    }

    var sortedGroups: [TalkGroup] { groups.sorted { ($0.sortOrder, $0.name) < ($1.sortOrder, $1.name) } }
}
