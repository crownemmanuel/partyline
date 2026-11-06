@testable import PartyLine
import XCTest

/// PROTOCOL.md §5.1 / ARCHITECTURE.md §4.1 table: Producer P, Camera C1 & C2, Backstage B1.
final class RoutingEngineTests: XCTestCase {
    var roster = Roster()

    override func setUp() {
        roster = Roster()
        roster.groups = [TalkGroup(id: "producer", name: "Producer"), TalkGroup(id: "camera", name: "Camera"),
                         TalkGroup(id: "backstage", name: "Backstage")]
        add(Device(id: "P", displayName: "Producer", groupId: "producer", listenGroupIds: ["producer", "camera", "backstage"],
                   canTalkGroupIds: ["producer", "camera", "backstage"], isAdmin: true, live: live(["g:camera"], online: true)))
        add(Device(id: "C1", displayName: "Camera 1", groupId: "camera", live: live(["g:camera"])))
        add(Device(id: "C2", displayName: "Camera 2", groupId: "camera", live: live(["g:camera"])))
        add(Device(id: "B1", displayName: "Backstage 1", groupId: "backstage", live: live(["g:backstage"])))
    }

    func live(_ targets: [TargetRef], online: Bool = true) -> LiveState {
        var l = LiveState(); l.talkTargets = targets; l.online = online; return l
    }

    func add(_ d: Device) { roster.devices[d.id] = d }

    func me(_ id: String, targets: [TargetRef]? = nil, listen: [String]? = nil, speakerMuted: Bool = false) -> RoutingEngine.Me {
        let d = roster.devices[id]!
        return .init(id: id, talkTargets: targets ?? d.live.talkTargets, listenGroupIds: listen ?? d.listenGroupIds,
                     speakerMuted: speakerMuted)
    }

    // Publisher side

    func testProducerTalksToCamera() {
        let r = RoutingEngine.compute(roster: roster, me: me("P", targets: ["g:camera"]))
        XCTAssertEqual(r.allowedSubscribers, ["C1", "C2"])
    }

    func testProducerTalksToCameraAndBackstage() {
        let r = RoutingEngine.compute(roster: roster, me: me("P", targets: ["g:camera", "g:backstage"]))
        XCTAssertEqual(r.allowedSubscribers, ["C1", "C2", "B1"])
    }

    func testProducerTalksToOneDevice() {
        let r = RoutingEngine.compute(roster: roster, me: me("P", targets: ["d:C2"]))
        XCTAssertEqual(r.allowedSubscribers, ["C2"])
    }

    func testCameraTalksToCameraReachesC2AndListeningProducer() {
        let r = RoutingEngine.compute(roster: roster, me: me("C1"))
        XCTAssertEqual(r.allowedSubscribers, ["C2", "P"])
        XCTAssertFalse(r.allowedSubscribers.contains("B1"))
    }

    func testProducerNotListeningToCameraIsNotAllowed() {
        roster.devices["P"]!.listenGroupIds = ["backstage"]
        let r = RoutingEngine.compute(roster: roster, me: me("C1"))
        XCTAssertEqual(r.allowedSubscribers, ["C2"])
    }

    func testReplyToProducerOnlyReachesProducer() {
        let r = RoutingEngine.compute(roster: roster, me: me("C1", targets: ["d:P"]))
        XCTAssertEqual(r.allowedSubscribers, ["P"])
    }

    func testNoTargetsNobodyAllowed() {
        let r = RoutingEngine.compute(roster: roster, me: me("C1", targets: []))
        XCTAssertTrue(r.allowedSubscribers.isEmpty)
    }

    func testAdminsHearEverythingSetting() {
        roster.devices["P"]!.listenGroupIds = []
        roster.settings.adminsHearEverything = true
        XCTAssertTrue(RoutingEngine.compute(roster: roster, me: me("B1")).allowedSubscribers.contains("P"))
        XCTAssertFalse(RoutingEngine.compute(roster: roster, me: me("B1", targets: [])).allowedSubscribers.contains("P"))
    }

    // Receiver side

    func testCameraHearsProducerTalkingToCamera() {
        let r = RoutingEngine.compute(roster: roster, me: me("C1"))
        XCTAssertEqual(r.playback["P"]?.enabled, true)
        XCTAssertEqual(r.playback["C2"]?.enabled, true)
        XCTAssertEqual(r.playback["B1"]?.enabled, false)
    }

    func testBackstageDoesNotHearProducerTalkingToCamera() {
        let r = RoutingEngine.compute(roster: roster, me: me("B1"))
        XCTAssertEqual(r.playback["P"]?.enabled, false)
        XCTAssertFalse(r.audible.contains("P"))
    }

    func testDirectTargetIsHeardOnlyByThatDevice() {
        roster.devices["P"]!.live.talkTargets = ["d:C2"]
        XCTAssertEqual(RoutingEngine.compute(roster: roster, me: me("C2")).playback["P"]?.enabled, true)
        XCTAssertEqual(RoutingEngine.compute(roster: roster, me: me("C1")).playback["P"]?.enabled, false)
    }

    func testProducerListenFilter() {
        // P listens only to Camera: hears Camera talk, nothing from Backstage.
        let r = RoutingEngine.compute(roster: roster, me: me("P", listen: ["camera"]))
        XCTAssertEqual(r.playback["C1"]?.enabled, true)
        XCTAssertEqual(r.playback["B1"]?.enabled, false)
    }

    func testAdminMutedTalkerIsNotPlayed() {
        roster.devices["P"]!.adminMuted = true
        XCTAssertEqual(RoutingEngine.compute(roster: roster, me: me("C1")).playback["P"]?.enabled, false)
    }

    func testSpeakerMuteDisablesPlaybackButKeepsAudible() {
        let r = RoutingEngine.compute(roster: roster, me: me("C1", speakerMuted: true))
        XCTAssertEqual(r.playback["P"]?.enabled, false)
        XCTAssertTrue(r.audible.contains("P"))
    }

    func testLocalMuteAndVolume() {
        let r = RoutingEngine.compute(roster: roster, me: me("C1"), localMute: ["C2"], localVolume: ["P": 0.5])
        XCTAssertEqual(r.playback["C2"]?.enabled, false)
        XCTAssertEqual(r.playback["P"], .init(enabled: true, volume: 0.5))
    }

    func testMeIsNeverInResults() {
        let r = RoutingEngine.compute(roster: roster, me: me("C1"))
        XCTAssertNil(r.playback["C1"])
        XCTAssertFalse(r.allowedSubscribers.contains("C1"))
    }

    // Helpers around routing

    func testFirstOnlineAdmin() {
        XCTAssertEqual(roster.firstOnlineAdmin(excluding: "C1")?.id, "P")
        roster.devices["P"]!.live.online = false
        XCTAssertNil(roster.firstOnlineAdmin(excluding: "C1"))
        XCTAssertNil(roster.firstOnlineAdmin(excluding: "P"))
    }

    func testEffectiveTalkMode() {
        var d = roster.devices["C1"]!
        roster.settings.defaultTalkMode = .ptt
        XCTAssertEqual(RoutingEngine.effectiveTalkMode(me: d, saved: nil, roster: roster), .ptt)
        roster.groups[1].defaultTalkMode = .latch
        XCTAssertEqual(RoutingEngine.effectiveTalkMode(me: d, saved: nil, roster: roster), .latch)
        XCTAssertEqual(RoutingEngine.effectiveTalkMode(me: d, saved: .ptt, roster: roster), .ptt)
        d.forcedTalkMode = .ptt
        XCTAssertEqual(RoutingEngine.effectiveTalkMode(me: d, saved: .latch, roster: roster), .ptt)
    }

    func testDefaultTalkTargets() {
        var d = roster.devices["C1"]!
        d.live.talkTargets = []
        XCTAssertEqual(RoutingEngine.defaultTalkTargets(for: d), ["g:camera"])
    }

    /// The welcome sample from packages/protocol, run through the engine end to end.
    func testWelcomeSampleRouting() throws {
        let url = ProtocolDecodingTests.samplesDir.appendingPathComponent("ws/02-welcome.json")
        guard FileManager.default.fileExists(atPath: url.path) else { throw XCTSkip("no shared samples") }
        guard case let .welcome(w) = try ServerEvent.decode(Data(contentsOf: url)) else { return XCTFail() }
        var r = Roster()
        r.replace(devices: w.devices + [w.me])
        r.groups = w.groups
        let result = RoutingEngine.compute(roster: r, me: .init(id: w.me.id, talkTargets: w.me.live.talkTargets,
                                                                listenGroupIds: w.me.listenGroupIds, speakerMuted: false))
        let producer = try XCTUnwrap(w.devices.first { $0.isAdmin })
        XCTAssertTrue(result.allowedSubscribers.contains(producer.id), "producer listens to camera")
        XCTAssertEqual(result.playback[producer.id]?.enabled, true, "producer talks to camera")
    }
}
