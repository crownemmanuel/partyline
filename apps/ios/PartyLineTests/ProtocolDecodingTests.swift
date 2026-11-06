@testable import PartyLine
import XCTest

/// Decodes/encodes against the shared samples in packages/protocol/samples (the same bytes the
/// mock server and the other clients test against), plus the inline samples from PROTOCOL.md §7.
final class ProtocolDecodingTests: XCTestCase {
    static let samplesDir = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("packages/protocol/samples")

    func sample(_ path: String) throws -> Data {
        let url = Self.samplesDir.appendingPathComponent(path)
        guard FileManager.default.fileExists(atPath: url.path) else { throw XCTSkip("shared sample \(path) not present") }
        return try Data(contentsOf: url)
    }

    func json(_ data: Data) throws -> NSDictionary {
        try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? NSDictionary)
    }

    // MARK: Server → client

    func testWelcome() throws {
        guard case let .welcome(w) = try ServerEvent.decode(sample("ws/02-welcome.json")) else { return XCTFail("not welcome") }
        XCTAssertEqual(w.me.id, "0f3c8a72-5d14-4b9e-a6c3-7e21f9d04b58")
        XCTAssertEqual(w.me.displayName, "Camera 2")
        XCTAssertEqual(w.me.groupId, "camera")
        XCTAssertEqual(w.me.live.talkTargets, ["g:camera"])
        XCTAssertEqual(w.me.live.talkMode, .ptt)
        XCTAssertNil(w.me.live.battery)
        XCTAssertFalse(w.devices.isEmpty)
        let producer = try XCTUnwrap(w.devices.first { $0.isAdmin })
        XCTAssertEqual(producer.displayName, "Producer")
        XCTAssertEqual(producer.platform, .desktop)
        XCTAssertTrue(w.groups.contains { $0.id == "camera" })
        XCTAssertNotNil(w.settings)
        XCTAssertNotNil(w.livekitToken)
    }

    func testDeviceUpsert() throws {
        guard case let .deviceUpsert(d) = try ServerEvent.decode(sample("ws/07-device.upsert.micLive.json")) else { return XCTFail() }
        XCTAssertTrue(d.live.micLive)
    }

    func testMessage() throws {
        guard case let .message(m) = try ServerEvent.decode(sample("ws/09-message.json")) else { return XCTFail() }
        XCTAssertEqual(m.id, "m-9")
        XCTAssertEqual(m.to, "g:camera")
        XCTAssertEqual(m.kind, .text)
        XCTAssertEqual(m.text, "Cam 2 tighter please")
    }

    func testAllServerSamplesDecodeToKnownTypes() throws {
        let expected: [String: (ServerEvent) -> Bool] = [
            "ws/04-ack.json": { if case let .ack(r) = $0 { return r == "c-1" }; return false },
            "ws/05-device.upsert.json": { if case .deviceUpsert = $0 { return true }; return false },
            "ws/device.removed.json": { if case .deviceRemoved = $0 { return true }; return false },
            "ws/groups.updated.json": { if case let .groupsUpdated(g) = $0 { return !g.isEmpty }; return false },
            "ws/server.updated.json": { if case .serverUpdated = $0 { return true }; return false },
            "ws/settings.updated.json": { if case let .settingsUpdated(s) = $0 { return !s.quickReplies.isEmpty }; return false },
            "ws/signal.json": { if case let .signal(s) = $0 { return s.to == "g:camera" }; return false },
            "ws/token.refreshed.json": { if case let .tokenRefreshed(t) = $0 { return !t.isEmpty }; return false },
            "ws/admin.notice.muted.json": { if case let .adminNotice(n) = $0 { return n.kind == "muted" }; return false },
            "ws/admin.notice.moved.json": { if case let .adminNotice(n) = $0 { return n.kind == "moved" }; return false },
            "ws/kicked.json": { if case let .kicked(r) = $0 { return r == "removed_by_admin" }; return false },
            "ws/server.shutdown.json": { if case let .serverShutdown(ms) = $0 { return ms == 3000 }; return false },
            "ws/error.json": { if case let .error(e) = $0 { return e.code == "bad_request" && e.replyTo == "c-1" }; return false },
            "ws/pong.json": { if case .pong = $0 { return true }; return false },
        ]
        for (path, check) in expected {
            let e = try ServerEvent.decode(sample(path))
            XCTAssertTrue(check(e), "\(path) decoded as \(e)")
        }
    }

    func testUnknownTypeDoesNotThrow() throws {
        let e = try ServerEvent.decode(Data(#"{"type":"future.thing","payload":{"x":1}}"#.utf8))
        guard case .unknown(type: "future.thing") = e else { return XCTFail() }
    }

    func testDeviceWithMissingLiveFieldsDecodes() throws {
        let d = try JSONDecoder().decode(Device.self, from: Data(#"{"id":"x","displayName":"A","groupId":"camera","live":{}}"#.utf8))
        XCTAssertEqual(d.listenGroupIds, ["camera"])
        XCTAssertEqual(d.canTalkGroupIds, ["camera"])
        XCTAssertEqual(d.live.talkMode, .ptt)
    }

    // MARK: REST

    func testRestResponses() throws {
        let info = try JSONDecoder().decode(InfoResponse.self, from: sample("rest/info.response.json"))
        XCTAssertEqual(info.apiVersion, 1)
        XCTAssertEqual(info.livekitUrl, "/rtc")
        XCTAssertEqual(info.fingerprint?.count, 64)

        let join = try JSONDecoder().decode(SessionResponse.self, from: sample("rest/join.response.json"))
        XCTAssertNotNil(join.deviceToken)
        XCTAssertEqual(join.roomName, "partyline")
        XCTAssertFalse(join.groups.isEmpty)

        let session = try JSONDecoder().decode(SessionResponse.self, from: sample("rest/session.response.json"))
        XCTAssertNil(session.deviceToken)
        XCTAssertEqual(session.me.groupId, "camera")

        let msgs = try JSONDecoder().decode([Message].self, from: sample("rest/messages.response.json"))
        XCTAssertEqual(msgs.first?.id, "m-9")

        for (path, code) in [("rest/error.invalid_code.json", "invalid_code"), ("rest/error.rate_limited.json", "rate_limited"),
                             ("rest/error.revoked.json", "revoked")] {
            XCTAssertEqual(try JSONDecoder().decode(APIErrorBody.self, from: sample(path)).error.code, code)
        }
    }

    func testJoinRequestMatchesSample() throws {
        let fx = try json(sample("fixtures.json"))
        let req = JoinRequest(joinCode: "483920", deviceId: fx["sampleDeviceId"] as! String, displayName: "Camera 2")
        let mine = try json(JSONEncoder().encode(req))
        let theirs = try json(sample("rest/join.request.json"))
        XCTAssertEqual(mine, theirs)
    }

    // MARK: Client → server (compare type + payload; ts/id are per-send)

    func assertEncodes(_ msg: ClientMessage, like path: String, file: StaticString = #filePath, line: UInt = #line) throws {
        let mine = try json(msg.encode(id: nil))
        let theirs = try json(sample(path))
        XCTAssertEqual(mine["type"] as? String, theirs["type"] as? String, path, file: file, line: line)
        XCTAssertEqual(mine["payload"] as? NSDictionary, theirs["payload"] as? NSDictionary, path, file: file, line: line)
        XCTAssertNotNil(mine["ts"], file: file, line: line)
    }

    func testClientMessagesMatchSamples() throws {
        let fx = try json(sample("fixtures.json"))
        let token = fx["deviceToken"] as! String
        let admin = fx["adminDeviceId"] as! String
        try assertEncodes(.auth(deviceToken: token), like: "ws/01-auth.json")
        try assertEncodes(.stateSet(StateSet(talkTargets: ["g:camera"], listenGroupIds: ["camera"], talkMode: .ptt)),
                          like: "ws/03-state.set.json")
        try assertEncodes(.stateSet(StateSet(micLive: true)), like: "ws/06-state.set.micLive.json")
        try assertEncodes(.stateSet(StateSet(micLive: false)), like: "ws/08-state.set.micOff.json")
        try assertEncodes(.messageAck(messageId: "m-9"), like: "ws/10-message.ack.json")
        try assertEncodes(.messageSend(to: "d:\(admin)", text: "OK", kind: .quick), like: "ws/message.send.quick.json")
        try assertEncodes(.signalSend(to: "d:\(admin)"), like: "ws/signal.send.json")
        try assertEncodes(.ping, like: "ws/ping.json")
        try assertEncodes(.status(StatusReport(rtcConnected: true, speaking: false, battery: 82, charging: false, headset: true,
                                               rttMs: 12, outputRoute: "headset")), like: "ws/status.json")
    }

    func testEnvelopeIdIsIncludedWhenGiven() throws {
        let d = try json(ClientMessage.stateSet(StateSet(micLive: true)).encode(id: "c-17"))
        XCTAssertEqual(d["id"] as? String, "c-17")
        let none = try json(ClientMessage.ping.encode(id: nil))
        XCTAssertNil(none["id"])
    }

    // MARK: PROTOCOL.md §7 inline sample (no file dependency)

    func testInlineSessionSample() throws {
        let raw = #"{"type":"message","payload":{"id":"m-9","from":"adm","to":"g:camera","kind":"text","text":"Cam 2 tighter please","ts":"2026-11-05T18:02:11Z"}}"#
        guard case let .message(m) = try ServerEvent.decode(Data(raw.utf8)) else { return XCTFail() }
        XCTAssertEqual(m.text, "Cam 2 tighter please")
        XCTAssertEqual(try ServerEvent.decodeAck(#"{"type":"ack","payload":{"replyTo":"c-1"}}"#), "c-1")
    }
}

private extension ServerEvent {
    static func decodeAck(_ s: String) throws -> String? {
        if case let .ack(r) = try decode(Data(s.utf8)) { return r }
        return nil
    }
}

final class JoinLinkAndFingerprintTests: XCTestCase {
    func testParseInstallLink() {
        let l = Wire.parseJoinLink("https://192.168.86.40:9443/#install&code=483920&fp=AB12CD&id=6e2a")
        XCTAssertEqual(l, Wire.JoinLink(host: "192.168.86.40", port: 9443, code: "483920", fingerprint: "ab12cd", serverId: "6e2a"))
        XCTAssertEqual(Wire.parseJoinLink("https://192.168.86.40:9443/#install"), Wire.JoinLink(host: "192.168.86.40", port: 9443))
    }

    func testParseJoinLink() {
        let l = Wire.parseJoinLink("https://192.168.86.40:8443/#join?code=483920&fp=AB12CD&id=6e2a")
        XCTAssertEqual(l, Wire.JoinLink(host: "192.168.86.40", port: 8443, code: "483920", fingerprint: "ab12cd", serverId: "6e2a"))
    }

    func testParsePlainAddress() {
        XCTAssertEqual(ServerAddress.parse("10.0.0.5"), ServerAddress(host: "10.0.0.5", port: 8443))
        XCTAssertEqual(ServerAddress.parse("partyline.local:9443"), ServerAddress(host: "partyline.local", port: 9443))
        XCTAssertNil(ServerAddress.parse("  "))
    }

    func testFingerprintNormalizeAndDisplay() {
        XCTAssertEqual(Fingerprint.normalize("AB:12:cd:34"), "ab12cd34")
        XCTAssertEqual(Fingerprint.display("ab12cd34ef56ab12cd34ef56ab12cd34ef56"), "ab12 cd34 ef56 ab12 cd34 ef56 ab12 cd34")
    }
}
