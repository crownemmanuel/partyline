import Combine
import Foundation
import LiveKit
import os
import UIKit

/// Owns every controller and runs the session state machine
/// `idle → discovering → joining → connecting → live → reconnecting` (IOS.md App module).
@MainActor
final class SessionCoordinator: ObservableObject {
    enum Phase: Equatable { case launching, discovering, joining, onLine, offLine }
    enum Link: Equatable { case connecting, live, reconnecting, serverOffline }

    /// A server the user picked but has not joined yet.
    struct PendingServer: Equatable {
        var address: ServerAddress
        var serverId: String
        var name: String
        var fingerprint: String
        var prefilledCode: String?
    }

    /// Trust-on-first-use prompt.
    struct TrustRequest: Equatable, Identifiable {
        var id: String { server.serverId + server.fingerprint }
        var server: PendingServer
        /// Non-nil when a different cert was pinned before for this server id.
        var replacesPin: String?
        /// Raised from a running session (cert renewed); accepting re-pins and reconnects, no re-join.
        var resumesSession = false
    }

    // MARK: Published state

    @Published private(set) var phase: Phase = .launching
    @Published private(set) var link: Link = .connecting
    @Published private(set) var roster = Roster()
    @Published private(set) var me: Device?
    @Published private(set) var serverName = ""
    @Published private(set) var messages: [Message] = []
    @Published private(set) var readIds: Set<String> = []
    /// Floating messages panel (replaces the old Messages screen).
    @Published private(set) var messagesOpen = false
    /// Live messages from others that arrived while the panel was closed, oldest first.
    @Published private(set) var popupQueue: [Message] = []
    /// Received while the panel was closed and not yet dismissed from the pop-up.
    @Published private(set) var unreadIds: Set<String> = []
    /// The panel's To: picker.
    @Published var composeTarget: TargetRef?
    /// Bumped to focus the panel's text field (Reply).
    @Published private(set) var focusComposeToken = 0
    @Published var toast: String?
    @Published var errorText: String?
    @Published var trustRequest: TrustRequest?
    @Published private(set) var pendingJoin: PendingServer?
    @Published private(set) var busy = false

    @Published private(set) var talkMode: TalkMode = .ptt
    @Published private(set) var talkActive = false
    @Published private(set) var replyHeld = false
    @Published private(set) var micMuted = false
    @Published private(set) var speakerMuted = false
    @Published private(set) var talkTargets: [TargetRef] = []
    @Published private(set) var onHold = false

    let browser = BonjourBrowser()
    let audio = AudioSessionController()
    let room = RoomController()
    private let voiceProcessor = VoiceIsolationProcessor()
    /// DeepFilterNet couldn't run at the mic's sample rate; stay on basic suppression.
    private var deepFilterUnsupported = false
    lazy var call = CallController(audio: audio)
    private let notifier = MessageNotifier()
    private let remote = RemoteCommands()
    private let proxy = PinnedTLSProxy()
    /// New fingerprint already prompted/warned about in this session, so the retry loop asks once.
    private var certPromptedFor: String?
    private let storage = Storage.shared
    private let log = Logger(subsystem: "com.partyline.app", category: "session")

    private var socket: ControlSocket?
    private var sessionTask: Task<Void, Never>?
    private var livekitToken: String?
    private var livekitPath = "/rtc"
    private var connectingRoom = false
    private var wasLive = false
    private var disconnectedSince: Date?
    private var nextReconnectDelay: TimeInterval?
    private var lastStatus: StatusReport?
    private var lastStatusAt = Date.distantPast
    private var statusTimer: Timer?
    private var bag: Set<AnyCancellable> = []
    /// `LiveActivityController` on iOS 16.2+ (stored untyped because of its availability).
    private var liveActivity: AnyObject?
    /// Latest message from someone else this session, for the Live Activity.
    private var lastLiveMessage: Message?

    // MARK: Derived

    var myId: String { storage.deviceId }
    var adminMuted: Bool { me?.adminMuted ?? false }
    var forcedTalkMode: TalkMode? { me?.forcedTalkMode }
    var micLive: Bool { (talkActive || replyHeld) && !micMuted && !adminMuted && !onHold }
    var myGroup: TalkGroup? { me.flatMap { roster.group($0.groupId) } }
    var producer: Device? { roster.firstOnlineAdmin(excluding: myId) }
    var unreadCount: Int { unreadIds.count }
    var quickReplies: [String] { roster.settings.quickReplies }
    var showsNoHeadsetWarning: Bool { micLive && audio.route == .speaker }

    var routing: RoutingEngine.Result {
        RoutingEngine.compute(roster: roster, me: routingMe)
    }

    /// Devices whose voice reaches me and who are talking right now.
    var talkingNow: [Device] {
        let r = routing
        return roster.devices.values
            .filter { r.audible.contains($0.id) && ($0.live.micLive || room.speakingIds.contains($0.id)) }
            .sorted { $0.displayName < $1.displayName }
    }

    /// Groups I may address (for the target picker; only shown when there is a choice).
    var talkableGroups: [TalkGroup] {
        guard let me else { return [] }
        return roster.sortedGroups.filter { me.isAdmin || me.canTalkGroupIds.contains($0.id) }
    }

    /// Groups I may listen to: own group plus any I may talk to (PROTOCOL §4), all for admins.
    var listenableGroups: [TalkGroup] {
        guard let me else { return [] }
        return roster.sortedGroups.filter { me.isAdmin || $0.id == me.groupId || me.canTalkGroupIds.contains($0.id) }
    }

    private var routingMe: RoutingEngine.Me {
        RoutingEngine.Me(id: myId, talkTargets: talkTargets,
                         listenGroupIds: me?.listenGroupIds ?? [], speakerMuted: speakerMuted)
    }

    // MARK: Lifecycle

    init() {
        // Debug aid: launch with environment PL_LK_DEBUG=1 for LiveKit SDK logs.
        if ProcessInfo.processInfo.environment["PL_LK_DEBUG"] != nil { LiveKitSDK.setLogLevel(.debug) }
        readIds = Set(UserDefaults.standard.stringArray(forKey: "readIds") ?? [])
        notifier.speakMessages = storage.speakMessages
        notifier.onReply = { [weak self] id, text in self?.replyFromNotification(messageId: id, text: text) }
        notifier.onClose = { [weak self] id in self?.dismissFromNotification(messageId: id) }

        room.onRosterChange = { [weak self] in self?.applyRouting() }
        room.onStatusChange = { [weak self] in self?.roomStatusChanged() }
        audio.onRouteChange = { [weak self] in self?.objectWillChange.send(); self?.reportStatus(force: true) }

        call.onMuteChanged = { [weak self] muted in self?.applyHardMute(muted, fromCallKit: true) }
        call.onEnded = { [weak self] in self?.leave() }
        call.onHoldChanged = { [weak self] held in
            guard let self else { return }
            self.onHold = held
            self.micChanged()
        }
        voiceProcessor.onRateUnsupported = { [weak self] in
            Task { @MainActor in
                guard let self, !self.deepFilterUnsupported else { return }
                self.deepFilterUnsupported = true
                self.applyVoiceIsolation()
            }
        }
        applyVoiceIsolation()

        remote.onToggleTalk = { [weak self] in
            guard let self, self.storage.headsetButtonTalks else { return }
            self.toggleTalk()
        }

        // Re-publish nested observable changes so views that read derived values refresh.
        room.$speakingIds.sink { [weak self] _ in self?.objectWillChange.send() }.store(in: &bag)
        room.$connection.sink { [weak self] _ in self?.objectWillChange.send() }.store(in: &bag)
        audio.$route.sink { [weak self] _ in self?.objectWillChange.send() }.store(in: &bag)

        // Lock screen / Dynamic Island mirror of the crew screen, coalesced to one update per burst.
        if #available(iOS 16.2, *) {
            liveActivity = LiveActivityController()
            objectWillChange
                .receive(on: RunLoop.main)
                .throttle(for: .milliseconds(300), scheduler: RunLoop.main, latest: true)
                .sink { [weak self] _ in self?.syncLiveActivity() }
                .store(in: &bag)
        }
        if #available(iOS 17, *) {
            NotificationCenter.default.addObserver(forName: .partyLineSetActivityMic, object: nil, queue: .main) { [weak self] note in
                guard let intent = note.object as? SetActivityMicIntent else { return }
                MainActor.assumeIsolated { self?.setActivityMic(intent) }
            }
        }

        UIDevice.current.isBatteryMonitoringEnabled = true
        NotificationCenter.default.addObserver(forName: UIDevice.batteryStateDidChangeNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.reportStatus() }
        }
    }

    func launch() {
        guard phase == .launching else { return }
        notifier.requestAuthorization()
        browser.start()
        if let saved = storage.savedServer, storage.deviceToken != nil, storage.pin(for: saved.serverId) != nil {
            serverName = saved.name
            if storage.autoJoinCall {
                startSession(initial: nil)
            } else {
                phase = .offLine
            }
        } else {
            phase = .discovering
        }
    }

    func appBecameActive() {
        call.resumeAudioIfNeeded()
        if #available(iOS 16.2, *) { syncLiveActivity() }
        notifier.clearDelivered()
        UIApplication.shared.applicationIconBadgeNumber = 0
        if messagesOpen { ack(messages) }
    }

    // MARK: Discovery → trust → join

    func select(_ server: DiscoveredServer) {
        Task {
            busy = true
            defer { busy = false }
            do {
                let address = try await BonjourBrowser.resolve(server)
                await probe(address: address, expectedFingerprint: server.fingerprint, expectedServerId: server.serverId,
                            code: nil, outOfBand: false)
            } catch {
                errorText = "Could not reach \(server.name): \(error.localizedDescription)"
            }
        }
    }

    /// Manual address field or a scanned/pasted join link.
    func connectManually(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let link = Wire.parseJoinLink(trimmed.contains("://") ? trimmed : "https://\(trimmed)")
        guard let link else { errorText = "That doesn't look like an address."; return }
        Task {
            busy = true
            defer { busy = false }
            await probe(address: ServerAddress(host: link.host, port: link.port), expectedFingerprint: link.fingerprint,
                        expectedServerId: link.serverId, code: link.code, outOfBand: link.fingerprint != nil)
        }
    }

    func handle(url: URL) {
        var s = url.absoluteString
        if url.scheme == "partyline" { s = s.replacingOccurrences(of: "partyline://", with: "https://") }
        guard phase == .discovering || phase == .joining || phase == .offLine else { return }
        connectManually(s)
    }

    private func probe(address: ServerAddress, expectedFingerprint: String?, expectedServerId: String?,
                       code: String?, outOfBand: Bool) async {
        let client = ServerClient(address: address, pin: nil)
        do {
            let (info, seen) = try await client.probe()
            guard info.apiVersion == API.version else {
                errorText = "\(info.name) speaks protocol v\(info.apiVersion); this app needs v\(API.version)."
                return
            }
            if let expectedServerId, expectedServerId != info.serverId {
                errorText = "The server at \(address.display) is not the one advertised."
                return
            }
            if let fp = expectedFingerprint, Fingerprint.normalize(fp) != seen {
                errorText = "\(info.name)'s certificate does not match its advertised fingerprint. Not connecting."
                return
            }
            if let fp = info.fingerprint, Fingerprint.normalize(fp) != seen {
                errorText = "\(info.name)'s certificate does not match the fingerprint it reports. Not connecting."
                return
            }
            let pending = PendingServer(address: address, serverId: info.serverId, name: info.name, fingerprint: seen,
                                        prefilledCode: code)
            let existing = storage.pin(for: info.serverId)
            if existing == seen || (existing == nil && outOfBand) {
                proceedToJoin(pending)
            } else {
                trustRequest = TrustRequest(server: pending, replacesPin: existing)
            }
        } catch {
            errorText = "Could not reach \(address.display): \(error.localizedDescription)"
        }
    }

    func answerTrust(_ accept: Bool) {
        guard let req = trustRequest else { return }
        trustRequest = nil
        if req.resumesSession {
            if accept {
                storage.setPin(req.server.fingerprint, for: req.server.serverId)
                startSession(initial: nil)
            } else {
                leave()
                errorText = "Not connecting: \(req.server.name)'s certificate changed and was not trusted."
            }
            return
        }
        if accept { proceedToJoin(req.server) }
    }

    /// The pinned cert no longer matches (renewal every ~26 months, reinstall, address change).
    /// Check the new cert against what the server reports and its mDNS `fp`, then ask once.
    private func certificateChanged(_ saved: SavedServer) async {
        guard trustRequest == nil else { return }
        guard let (info, seen) = try? await ServerClient(address: saved.address, pin: nil).probe(),
              info.serverId == saved.serverId, seen != storage.pin(for: saved.serverId),
              certPromptedFor != seen else { return }
        certPromptedFor = seen
        let advertised = [info.fingerprint, browser.server(withId: saved.serverId)?.fingerprint].compactMap { $0 }
        if advertised.contains(where: { Fingerprint.normalize($0) != seen }) {
            errorText = "\(info.name)'s certificate changed but does not match its advertised fingerprint. Not connecting."
            return
        }
        trustRequest = TrustRequest(server: PendingServer(address: saved.address, serverId: info.serverId, name: info.name,
                                                          fingerprint: seen),
                                    replacesPin: storage.pin(for: saved.serverId), resumesSession: true)
    }

    private func proceedToJoin(_ server: PendingServer) {
        storage.setPin(server.fingerprint, for: server.serverId)
        pendingJoin = server
        phase = .joining
    }

    func cancelJoin() {
        pendingJoin = nil
        phase = .discovering
    }

    var suggestedName: String { storage.displayName }

    func join(code: String, name: String) {
        guard let p = pendingJoin else { return }
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard code.count == 6, !name.isEmpty else { errorText = "Enter the 6-digit code and your name."; return }
        Task {
            busy = true
            defer { busy = false }
            let client = ServerClient(address: p.address, pin: p.fingerprint)
            do {
                let resp = try await client.join(JoinRequest(joinCode: code, deviceId: myId, displayName: name))
                guard let token = resp.deviceToken else { throw ServerClientError.badResponse }
                storage.deviceToken = token
                storage.displayName = name
                storage.savedServer = SavedServer(serverId: p.serverId, name: p.name, address: p.address)
                serverName = p.name
                pendingJoin = nil
                startSession(initial: resp)
            } catch {
                errorText = error.localizedDescription
            }
        }
    }

    // MARK: Session

    /// Starts intercom audio and the control/LiveKit loop.
    func startSession(initial: SessionResponse?) {
        guard let saved = storage.savedServer else { phase = .discovering; return }
        phase = .onLine
        link = .connecting
        wasLive = false
        certPromptedFor = nil
        sessionTask?.cancel()
        sessionTask = Task { [weak self] in
            guard let self else { return }
            do {
                try await self.call.start(serverName: saved.name)
            } catch {
                self.errorText = (self.call.state.failedMessage) ?? error.localizedDescription
                self.phase = .offLine
                return
            }
            self.remote.enable()
            await self.runLoop(initial: initial)
        }
    }

    private func runLoop(initial: SessionResponse?) async {
        let backoff: [TimeInterval] = [1, 2, 4, 8, 15]
        var attempt = 0
        var initial = initial
        while !Task.isCancelled {
            guard let saved = storage.savedServer, let token = storage.deviceToken,
                  let pin = storage.pin(for: saved.serverId) else { goToDiscovery(); return }
            do {
                let resp: SessionResponse
                if let i = initial { resp = i; initial = nil } else {
                    resp = try await ServerClient(address: saved.address, pin: pin).session(deviceToken: token)
                }
                if Task.isCancelled { return }
                applySession(resp)
                let ok = await runSocket(address: saved.address, pin: pin, token: token)
                if ok { attempt = 0 }
            } catch let e as ServerClientError {
                if e.code == "revoked" || e.code == "invalid_token" {
                    kicked(message: e.localizedDescription)
                    return
                }
                if e == .pinMismatch { await certificateChanged(saved) }
                log.info("session failed: \(e.localizedDescription)")
            } catch {
                log.info("session failed: \(error.localizedDescription)")
            }
            if Task.isCancelled { return }

            enterReconnecting()
            let delay = nextReconnectDelay ?? backoff[min(attempt, backoff.count - 1)]
            nextReconnectDelay = nil
            attempt += 1
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            if attempt >= 2 { await rediscover() }
            updateOffline()
        }
    }

    /// Runs one control socket until it closes. Returns true if it reached `welcome`.
    private func runSocket(address: ServerAddress, pin: String, token: String) async -> Bool {
        let s = ControlSocket(address: address, pin: pin)
        socket = s
        s.connect(deviceToken: token)
        var welcomed = false
        for await ev in s.events {
            if Task.isCancelled { s.close(); break }
            switch ev {
            case .opened: break
            case let .event(e):
                if case .welcome = e { welcomed = true }
                handle(e)
            case let .closed(reason):
                log.info("control closed: \(reason)")
            }
        }
        if socket === s { socket = nil }
        return welcomed
    }

    private func applySession(_ resp: SessionResponse) {
        livekitToken = resp.livekitToken
        if let url = resp.livekitUrl { livekitPath = URL(string: url)?.path.nonEmpty ?? url }
        roster.groups = resp.groups
        roster.devices[resp.me.id] = resp.me
        adoptMe(resp.me, initial: me == nil)
        // Request the activity while joining in the foreground, before the user locks.
        if #available(iOS 16.2, *) { syncLiveActivity() }
    }

    private func enterReconnecting() {
        if disconnectedSince == nil { disconnectedSince = Date() }
        if wasLive {
            notifier.tones.play(.disconnected)
            wasLive = false
        }
        if link != .serverOffline { link = .reconnecting }
        reportStatus(force: true)
    }

    private func updateOffline() {
        guard let saved = storage.savedServer, let since = disconnectedSince else { return }
        let seen = browser.lastSeen(serverId: saved.serverId) ?? since
        if Date().timeIntervalSince(max(seen, since)) > 60 { link = .serverOffline }
    }

    /// Server restarted or moved: look it up by id on Bonjour and update the saved address.
    private func rediscover() async {
        guard var saved = storage.savedServer, let found = browser.server(withId: saved.serverId) else { return }
        if let addr = try? await BonjourBrowser.resolve(found), addr != saved.address {
            log.info("server moved to \(addr.display)")
            saved.address = addr
            saved.name = found.name
            storage.savedServer = saved
        }
    }

    // MARK: Server events

    private func handle(_ e: ServerEvent) {
        switch e {
        case let .welcome(w):
            roster.replace(devices: w.devices + [w.me])
            roster.groups = w.groups
            if let s = w.settings { roster.settings = s }
            if let n = w.server?.name { serverName = n }
            if let t = w.livekitToken { livekitToken = t }
            if let m = w.messages { messages = m.sorted { $0.ts < $1.ts } }
            adoptMe(w.me, initial: true)
            becameLive()
        case .ack, .pong:
            break
        case let .error(err):
            log.error("server error \(err.code): \(err.message ?? "")")
            if err.code != "not_admin" { toast = err.message ?? err.code }
        case let .deviceUpsert(d):
            roster.devices[d.id] = d
            if d.id == myId { adoptMe(d, initial: false) }
            applyRouting()
        case let .deviceRemoved(id):
            roster.devices[id] = nil
            applyRouting()
        case let .groupsUpdated(g):
            roster.groups = g
            applyRouting()
        case let .serverUpdated(info):
            serverName = info.name
            if var saved = storage.savedServer { saved.name = info.name; storage.savedServer = saved }
        case let .settingsUpdated(s):
            roster.settings = s
            applyRouting()
        case let .message(m):
            guard !messages.contains(where: { $0.id == m.id }) else { return }
            messages.append(m)
            if messages.count > 200 { messages.removeFirst(messages.count - 200) }
            guard m.from != myId else { return }
            lastLiveMessage = m
            notifier.message(from: roster.name(of: m.from), text: m.text, id: m.id)
            if messagesOpen && UIApplication.shared.applicationState == .active {
                ack([m])
            } else {
                popupQueue.append(m)
                unreadIds.insert(m.id)
            }
        case .messageAcked:
            break
        case let .signal(s):
            if s.from != myId { notifier.signal(from: roster.name(of: s.from)) }
        case let .tokenRefreshed(t):
            livekitToken = t
        case let .adminNotice(n):
            toast = n.text
            notifier.notice(n.text)
        case .kicked:
            kicked(message: "You were removed by the admin. Join again with a code.")
        case let .serverShutdown(ms):
            nextReconnectDelay = Double(ms) / 1000
            toast = "Host is restarting…"
        case .unknown:
            break
        }
    }

    /// Take the server's view of me, keeping local optimistic mic state.
    private func adoptMe(_ d: Device, initial: Bool) {
        let previousGroup = me?.groupId
        me = d
        if initial {
            talkMode = RoutingEngine.effectiveTalkMode(me: d, saved: storage.savedTalkMode, roster: roster)
            speakerMuted = d.live.speakerMuted
        } else if let forced = d.forcedTalkMode, forced != talkMode {
            talkMode = forced
            if forced == .ptt { talkActive = false }
        }
        if !replyHeld {
            var targets = RoutingEngine.defaultTalkTargets(for: d)
            if let prev = previousGroup, prev != d.groupId, targets == [Target.group(prev)] { targets = [Target.group(d.groupId)] }
            talkTargets = targets
        }
        if d.adminMuted {
            talkActive = false
            call.setMuted(true)
        }
        micChanged(sendState: false)
    }

    private func becameLive() {
        link = .live
        disconnectedSince = nil
        if !wasLive, call.state == .connected || room.isConnected { notifier.tones.play(.reconnected) }
        wasLive = true
        // A new control session starts with blank live state on the server: resend everything.
        lastStatus = nil
        sendState(StateSet(talkTargets: talkTargets, listenGroupIds: me?.listenGroupIds, micLive: micLive,
                           speakerMuted: speakerMuted, talkMode: talkMode))
        connectRoomIfNeeded()
        applyRouting()
        reportStatus(force: true)
        startStatusTimer()
    }

    private func connectRoomIfNeeded() {
        guard !connectingRoom, room.connection == .disconnected, let token = livekitToken,
              let saved = storage.savedServer, let pin = storage.pin(for: saved.serverId) else { return }
        connectingRoom = true
        Task {
            do {
                let port = try await proxy.start(host: saved.address.host, port: saved.address.port, pin: pin)
                let path = livekitPath.hasPrefix("/") ? livekitPath : "/" + livekitPath
                var url = "ws://127.0.0.1:\(port)\(path)"
                #if DEBUG && targetEnvironment(simulator)
                // Debug aid: PL_DIRECT_LK=ws://127.0.0.1:7880 bypasses the TLS proxy (simulator shares host loopback).
                if let direct = ProcessInfo.processInfo.environment["PL_DIRECT_LK"] { url = direct }
                #endif
                try await room.connect(url: url, token: token, myId: myId)
                connectingRoom = false
                roomRetryAttempt = 0
                call.reportConnected()
                room.setMicLive(micLive)
                applyRouting()
            } catch {
                log.error("livekit connect failed: \(error.localizedDescription)")
                // The control link may stay up while the room fails: retry on our own, and ask
                // for a fresh token in case the old one expired.
                let delays: [Double] = [0.5, 2, 4, 8, 15]
                let delay = delays[min(roomRetryAttempt, delays.count - 1)]
                roomRetryAttempt += 1
                if link == .live { socket?.send(.tokenRefresh) }
                try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
                connectingRoom = false
                if link == .live, phase == .onLine { connectRoomIfNeeded() }
            }
        }
    }

    private var roomRetryAttempt = 0

    private func roomStatusChanged() {
        objectWillChange.send()
        reportStatus(force: true)
        if room.connection == .disconnected, link == .live, phase == .onLine {
            Task {
                try? await Task.sleep(nanoseconds: 2_000_000_000)
                connectRoomIfNeeded()
            }
        }
    }

    private func kicked(message: String) {
        sessionTask?.cancel()
        socket?.close()
        storage.deviceToken = nil
        Task {
            await room.disconnect()
            await call.end()
        }
        remote.disable()
        statusTimer?.invalidate()
        me = nil
        roster = Roster()
        messages = []
        clearMessageUI()
        errorText = message
        goToDiscovery()
    }

    private func goToDiscovery() {
        phase = .discovering
        browser.start()
    }

    // MARK: Routing and state

    func applyRouting() {
        room.apply(routing)
        objectWillChange.send()
    }

    private func sendState(_ s: StateSet) {
        socket?.send(.stateSet(s))
    }

    private func micChanged(sendState send: Bool = true) {
        let live = micLive
        room.setMicLive(live)
        if send { sendState(StateSet(micLive: live)) }
        reportStatus()
    }

    // MARK: User actions

    func talkPressed() {
        guard !adminMuted else { return }
        UIImpactFeedbackGenerator(style: .heavy).impactOccurred()
        if micMuted { applyHardMute(false, fromCallKit: false) }
        talkActive = true
        micChanged()
    }

    func talkReleased() {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        talkActive = false
        micChanged()
    }

    /// Latch tap, or headset button in any mode.
    func toggleTalk() {
        if talkActive { talkReleased() } else { talkPressed() }
    }

    func setMicMuted(_ muted: Bool) { applyHardMute(muted, fromCallKit: false) }

    /// "Live · tap to mute" tile: end talking (latch, hold or reply).
    func stopTalking() {
        if replyHeld { replyReleased() }
        if talkActive { talkReleased() }
    }

    private func applyHardMute(_ muted: Bool, fromCallKit: Bool) {
        if adminMuted, !muted {
            if fromCallKit { call.setMuted(true) }
            return
        }
        micMuted = muted
        if muted { talkActive = false }
        if !fromCallKit { call.setMuted(muted) }
        micChanged()
    }

    func setSpeakerMuted(_ muted: Bool) {
        speakerMuted = muted
        sendState(StateSet(speakerMuted: muted))
        applyRouting()
        reportStatus()
    }

    func setTalkMode(_ mode: TalkMode) {
        guard forcedTalkMode == nil else { return }
        storage.savedTalkMode = mode
        talkMode = mode
        talkActive = false
        sendState(StateSet(micLive: micLive, talkMode: mode))
        micChanged(sendState: false)
    }

    func toggleTalkTarget(group id: String) {
        var t = talkTargets
        let ref = Target.group(id)
        if t.contains(ref) { if t.count > 1 { t.removeAll { $0 == ref } } } else { t.append(ref) }
        talkTargets = t
        sendState(StateSet(talkTargets: t))
        applyRouting()
    }

    func toggleListen(group id: String) {
        guard var d = me else { return }
        var l = d.listenGroupIds
        if l.contains(id) { l.removeAll { $0 == id } } else { l.append(id) }
        d.listenGroupIds = l
        me = d
        roster.devices[d.id] = d
        sendState(StateSet(listenGroupIds: l))
        applyRouting()
    }

    private var savedTargets: [TargetRef] = []

    func replyPressed() {
        guard let p = producer, !adminMuted else { toast = "No producer online"; return }
        UIImpactFeedbackGenerator(style: .heavy).impactOccurred()
        if micMuted { applyHardMute(false, fromCallKit: false) }
        savedTargets = talkTargets
        replyHeld = true
        talkTargets = [Target.device(p.id)]
        applyRouting()
        room.setMicLive(micLive)
        sendState(StateSet(talkTargets: talkTargets, micLive: micLive))
    }

    func replyReleased() {
        guard replyHeld else { return }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        replyHeld = false
        room.setMicLive(micLive)
        talkTargets = savedTargets.isEmpty ? me.map(RoutingEngine.defaultTalkTargets) ?? [] : savedTargets
        sendState(StateSet(talkTargets: talkTargets, micLive: micLive))
        applyRouting()
    }

    // MARK: Messages

    var composeOptions: [MessageRules.Option] {
        guard let me else { return [] }
        var opts = MessageRules.composeTargets(me: me, roster: roster)
        if let t = composeTarget, !opts.contains(where: { $0.target == t }) {
            opts.insert(.init(target: t, label: describe(t)), at: 0)
        }
        return opts
    }

    func describe(_ to: TargetRef) -> String { MessageRules.describe(to, roster: roster, myId: myId) }

    private var resolvedComposeTarget: TargetRef? {
        composeTarget ?? me.map { MessageRules.defaultTarget(me: $0, roster: roster) }
    }

    func send(text: String, kind: MessageKind = .text) {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty, let to = resolvedComposeTarget else { return }
        socket?.send(.messageSend(to: to, text: String(t.prefix(500)), kind: kind), withId: true)
    }

    /// 🔔 in the panel: buzz whoever the To: picker points at.
    func sendSignal() {
        guard let to = resolvedComposeTarget else { return }
        socket?.send(.signalSend(to: to), withId: true)
        toast = "Signalled \(describe(to))"
    }

    /// Opening the panel shows everything, so everything is seen: ack it and clear badge and pop-ups.
    func openMessages() {
        if composeTarget == nil, let me { composeTarget = MessageRules.defaultTarget(me: me, roster: roster) }
        messagesOpen = true
        popupQueue = []
        unreadIds = []
        ack(messages)
        notifier.clearDelivered()
    }

    func closeMessages() { messagesOpen = false }

    /// Close/Next on the pop-up: that message is seen.
    func dismissPopup() {
        guard let m = popupQueue.first else { return }
        popupQueue.removeFirst()
        unreadIds.remove(m.id)
        ack([m])
    }

    func dismissAllPopups() {
        let all = popupQueue
        popupQueue = []
        all.forEach { unreadIds.remove($0.id) }
        ack(all)
    }

    /// ↩ Reply: open the panel addressed per the message.send rules, text field focused.
    func reply(to m: Message) {
        if let me, let t = MessageRules.replyTarget(for: m, me: me, roster: roster) { composeTarget = t }
        openMessages()
        focusComposeToken += 1
    }

    func replyToPopup() {
        guard let m = popupQueue.first else { return }
        reply(to: m)
    }

    /// Inline reply from the lock-screen notification.
    private func replyFromNotification(messageId: String, text: String) {
        guard let m = messages.first(where: { $0.id == messageId }), let me,
              let to = MessageRules.replyTarget(for: m, me: me, roster: roster) else { return }
        dismissFromNotification(messageId: messageId)
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        socket?.send(.messageSend(to: to, text: String(t.prefix(500)), kind: .text), withId: true)
    }

    private func dismissFromNotification(messageId: String) {
        popupQueue.removeAll { $0.id == messageId }
        unreadIds.remove(messageId)
        if let m = messages.first(where: { $0.id == messageId }) { ack([m]) }
    }

    /// Read receipts only for messages actually seen (pop-up closed/answered, or panel open).
    private func ack(_ ms: [Message]) {
        let fresh = ms.filter { $0.from != myId && !readIds.contains($0.id) }
        guard !fresh.isEmpty else { return }
        for m in fresh { socket?.send(.messageAck(messageId: m.id)) }
        readIds.formUnion(fresh.map(\.id))
        UserDefaults.standard.set(Array(readIds.suffix(300)), forKey: "readIds")
    }

    private func clearMessageUI() {
        lastLiveMessage = nil
        messagesOpen = false
        popupQueue = []
        unreadIds = []
        composeTarget = nil
    }

    var speakMessages: Bool {
        get { storage.speakMessages }
        set { storage.speakMessages = newValue; notifier.speakMessages = newValue; objectWillChange.send() }
    }

    var autoJoinCall: Bool {
        get { storage.autoJoinCall }
        set { storage.autoJoinCall = newValue; objectWillChange.send() }
    }

    var headsetButtonTalks: Bool {
        get { storage.headsetButtonTalks }
        set { storage.headsetButtonTalks = newValue; objectWillChange.send() }
    }

    var voiceIsolation: Bool {
        get { storage.voiceIsolation }
        set { storage.voiceIsolation = newValue; applyVoiceIsolation() }
    }

    var voiceIsolationEngine: VoiceIsolationEngine {
        guard storage.voiceIsolation else { return .off }
        return VoiceIsolationProcessor.isAvailable && !deepFilterUnsupported ? .deepFilter : .basic
    }

    /// Takes effect on the live mic: DFN attaches/detaches instantly; basic re-publishes the track.
    private func applyVoiceIsolation() {
        let engine = voiceIsolationEngine
        if engine == .deepFilter {
            let p = voiceProcessor
            Task.detached(priority: .userInitiated) { p.prepare() }
            AudioManager.shared.capturePostProcessingDelegate = voiceProcessor
        } else if AudioManager.shared.capturePostProcessingDelegate != nil {
            AudioManager.shared.capturePostProcessingDelegate = nil
        }
        room.setNoiseSuppression(engine == .basic)
        objectWillChange.send()
    }

    var savedServerAddress: String? { storage.savedServer?.address.display }

    /// Leave the line but keep the pairing (next launch / Rejoin is code-free).
    func leave() {
        sessionTask?.cancel()
        socket?.close()
        statusTimer?.invalidate()
        talkActive = false
        replyHeld = false
        Task {
            await room.disconnect()
            await call.end()
        }
        remote.disable()
        phase = storage.savedServer != nil && storage.deviceToken != nil ? .offLine : .discovering
    }

    func rejoin() { startSession(initial: nil) }

    /// Unpair from this server entirely.
    func forgetServer() {
        leave()
        storage.deviceToken = nil
        storage.savedServer = nil
        me = nil
        roster = Roster()
        messages = []
        clearMessageUI()
        goToDiscovery()
    }

    // MARK: Live Activity

    private var canUnmuteFromActivity: Bool {
        phase == .onLine && link == .live && room.isConnected && !onHold && !adminMuted
    }

    @available(iOS 17, *)
    private func setActivityMic(_ intent: SetActivityMicIntent) {
        guard phase == .onLine, (liveActivity as? LiveActivityController)?.activityID == intent.activityID else { return }
        if intent.live {
            if canUnmuteFromActivity && !micLive { talkPressed() }
        } else {
            stopTalking()
        }
        syncLiveActivity()
    }

    @available(iOS 16.2, *)
    private func syncLiveActivity() {
        guard let la = liveActivity as? LiveActivityController else { return }
        guard phase == .onLine, let me else { la.end(); return }
        let attrs = PartyLineActivityAttributes(serverName: serverName, groupName: myGroup?.name ?? me.groupId,
                                                groupColor: myGroup?.color)
        let link: PartyLineActivityAttributes.ContentState.Link = switch self.link {
        case .live: .live
        case .connecting: .connecting
        case .reconnecting: .reconnecting
        case .serverOffline: .offline
        }
        let m = lastLiveMessage
        let state = PartyLineActivityAttributes.ContentState(
            mic: adminMuted ? .locked : (micLive ? .live : .muted), link: link,
            talking: talkingNow.map(\.displayName),
            messageFrom: m.map { roster.name(of: $0.from) }, messageText: m?.text,
            messageDate: m.flatMap { Wire.isoFormatter.date(from: $0.ts) }, unread: unreadCount, canUnmute: canUnmuteFromActivity)
        la.show(attrs, state)
    }

    // MARK: Status reporting (PROTOCOL §6.8)

    private func startStatusTimer() {
        statusTimer?.invalidate()
        statusTimer = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.reportStatus() }
        }
    }

    private func reportStatus(force: Bool = false) {
        guard socket != nil, link == .live else { return }
        let dev = UIDevice.current
        let battery = dev.batteryLevel >= 0 ? Int((dev.batteryLevel * 100).rounded()) : nil
        let charging: Bool? = dev.batteryState == .unknown ? nil : (dev.batteryState == .charging || dev.batteryState == .full)
        let s = StatusReport(rtcConnected: room.isConnected, speaking: room.localSpeaking && micLive, battery: battery,
                             charging: charging, headset: audio.hasHeadset, rttMs: room.rttMs, outputRoute: audio.route.rawValue)
        guard s != lastStatus else { return }
        let urgent = s.rtcConnected != lastStatus?.rtcConnected || s.speaking != lastStatus?.speaking
            || s.outputRoute != lastStatus?.outputRoute
        guard force || urgent || Date().timeIntervalSince(lastStatusAt) >= 2 else { return }
        lastStatus = s
        lastStatusAt = Date()
        socket?.send(.status(s))
    }
}

private extension String {
    var nonEmpty: String? { isEmpty ? nil : self }
}

extension CallController.State {
    var failedMessage: String? { if case let .failed(m) = self { return m }; return nil }
}
