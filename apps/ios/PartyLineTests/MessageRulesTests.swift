@testable import PartyLine
import XCTest

/// Reply target and To: options per PROTOCOL §3.1 `message.send`.
final class MessageRulesTests: XCTestCase {
    var roster = Roster()

    override func setUp() {
        roster = Roster()
        roster.groups = [TalkGroup(id: "camera", name: "Camera"), TalkGroup(id: "backstage", name: "Backstage")]
        var online = LiveState(); online.online = true
        for d in [Device(id: "P", displayName: "Producer", groupId: "camera", isAdmin: true, live: online),
                  Device(id: "C1", displayName: "Cam 1", groupId: "camera", live: online),
                  Device(id: "C2", displayName: "Cam 2", groupId: "camera", live: online),
                  Device(id: "B1", displayName: "Back 1", groupId: "backstage", live: online)] {
            roster.devices[d.id] = d
        }
    }

    func msg(from: String, to: TargetRef) -> Message {
        Message(id: "m", from: from, to: to, kind: .text, text: "hi", ts: "2026-11-06T10:00:00Z")
    }

    func reply(_ m: Message, as me: String) -> TargetRef? {
        MessageRules.replyTarget(for: m, me: roster.devices[me]!, roster: roster)
    }

    func testAdminSenderGetsDirectReply() {
        XCTAssertEqual(reply(msg(from: "P", to: "g:camera"), as: "C1"), "d:P")
    }

    func testAdminRepliesDirectToCrew() {
        XCTAssertEqual(reply(msg(from: "C1", to: "g:camera"), as: "P"), "d:C1")
    }

    func testCrewToGroupRepliesToGroup() {
        XCTAssertEqual(reply(msg(from: "C2", to: "g:camera"), as: "C1"), "g:camera")
    }

    func testCrewBroadcastRepliesAllOnlyIfAllowed() {
        XCTAssertEqual(reply(msg(from: "B1", to: "all"), as: "C1"), "d:P")
        roster.settings.crewCanBroadcast = true
        XCTAssertEqual(reply(msg(from: "B1", to: "all"), as: "C1"), "all")
    }

    func testUnknownSenderFallsBackToProducer() {
        XCTAssertEqual(reply(msg(from: "host-synthetic", to: "d:C1"), as: "C1"), "d:P")
    }

    func testCrewComposeOptions() {
        let opts = MessageRules.composeTargets(me: roster.devices["C1"]!, roster: roster).map(\.target)
        XCTAssertEqual(opts, ["d:P", "g:camera"])
        roster.settings.crewCanBroadcast = true
        XCTAssertTrue(MessageRules.composeTargets(me: roster.devices["C1"]!, roster: roster).map(\.target).contains("all"))
    }

    func testAdminComposeOptions() {
        let opts = MessageRules.composeTargets(me: roster.devices["P"]!, roster: roster).map(\.target)
        XCTAssertEqual(opts.first, "all")
        XCTAssertTrue(opts.contains("g:backstage"))
        XCTAssertTrue(opts.contains("d:B1"))
        XCTAssertFalse(opts.contains("d:P"))
    }
}
