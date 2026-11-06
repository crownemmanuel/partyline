package com.partyline.model

import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File

/**
 * Decodes the PROTOCOL.md samples. Inline samples are copied from PROTOCOL.md §2/§3/§7 so the
 * test stands alone; [SharedSamples] also runs every file in packages/protocol/samples, the
 * bytes the mock server and the other clients test against.
 */
class ProtocolCodecTest {

    @Test fun `welcome from PROTOCOL sample decodes`() {
        val e = ProtocolCodec.decode(Samples.WELCOME) as ServerEvent.WelcomeEvent
        val w = e.welcome
        assertEquals("0f3c", w.me.id)
        assertEquals(listOf("g:camera"), w.me.live.talkTargets)
        assertEquals(2, w.devices.size)
        assertTrue(w.devices.first { it.id == "admin" }.isAdmin)
        assertEquals(TalkMode.LATCH, w.groups.first { it.id == "producer" }.defaultTalkMode)
        assertNull(w.groups.first { it.id == "camera" }.defaultTalkMode)
        assertEquals("lk", w.livekitToken)
        assertEquals(listOf("OK", "Standby"), w.settings.quickReplies)
        assertFalse(w.settings.adminsHearEverything)
        assertNull(w.server?.joinCode)
    }

    @Test fun `every server message type decodes`() {
        fun dec(type: String, payload: String) = ProtocolCodec.decode("""{"type":"$type","payload":$payload}""")
        assertEquals(ServerEvent.Ack("c-1"), dec("ack", """{"replyTo":"c-1"}"""))
        assertEquals(ServerEvent.Error("c-17", "bad_request", "no"), dec("error", """{"replyTo":"c-17","code":"bad_request","message":"no"}"""))
        assertEquals(ServerEvent.Pong, dec("pong", "{}"))
        assertEquals("0f3c", (dec("device.upsert", Samples.DEVICE_ME) as ServerEvent.DeviceUpsert).device.id)
        assertEquals(ServerEvent.DeviceRemovedEvent("x"), dec("device.removed", """{"deviceId":"x"}"""))
        assertEquals(1, (dec("groups.updated", """{"groups":[{"id":"camera","name":"Camera","color":"#2563eb","sortOrder":1,"defaultTalkMode":null}]}""") as ServerEvent.GroupsUpdatedEvent).groups.size)
        assertEquals("483920", (dec("server.updated", """{"serverId":"s","name":"Mac","appVersion":"0.1.0","apiVersion":1,"joinCode":"483920","joinOpen":true,"fingerprint":"ab","failedJoinAttempts":2}""") as ServerEvent.ServerUpdated).server.joinCode)
        assertTrue((dec("settings.updated", """{"crewCanBroadcast":true,"defaultTalkMode":"latch","quickReplies":["Go"]}""") as ServerEvent.SettingsUpdated).settings.crewCanBroadcast)
        val m = (dec("message", """{"id":"m-9","from":"admin","to":"g:camera","kind":"text","text":"Cam 2 tighter please","ts":"2026-11-05T18:02:11Z"}""") as ServerEvent.MessageEvent).message
        assertEquals("Cam 2 tighter please", m.text)
        assertEquals("d1", (dec("message.acked", """{"messageId":"m-9","deviceId":"d1","ts":"2026-11-05T18:02:11Z"}""") as ServerEvent.MessageAckedEvent).acked.deviceId)
        assertEquals(ServerEvent.Signal("admin", "d:0f3c"), dec("signal", """{"from":"admin","to":"d:0f3c"}"""))
        assertEquals(ServerEvent.TokenRefreshedEvent("jwt"), dec("token.refreshed", """{"livekitToken":"jwt"}"""))
        assertEquals("moved", (dec("admin.notice", """{"kind":"moved","text":"You were moved to Backstage"}""") as ServerEvent.AdminNoticeEvent).notice.kind)
        assertEquals(ServerEvent.KickedEvent("removed_by_admin"), dec("kicked", """{"reason":"removed_by_admin"}"""))
        assertEquals(ServerEvent.ShutdownEvent(3000), dec("server.shutdown", """{"reconnectAfterMs":3000}"""))
        assertEquals(ServerEvent.Unknown("future.thing"), dec("future.thing", "{}"))
    }

    @Test fun `unknown fields and missing optional fields are tolerated`() {
        val e = ProtocolCodec.decode("""{"type":"device.upsert","id":"x","ts":"t","extra":1,"payload":{"id":"d9","newField":true,"live":{"micLive":true}}}""")
        val d = (e as ServerEvent.DeviceUpsert).device
        assertTrue(d.live.micLive)
        assertEquals(emptyList<String>(), d.live.talkTargets)
        assertNull(d.forcedTalkMode)
    }

    @Test fun `client messages encode like the PROTOCOL samples`() {
        assertSameJson(
            """{"type":"auth","payload":{"deviceToken":"tok","appVersion":"0.1.0"}}""",
            ProtocolCodec.encode("auth", AuthPayload("tok", "0.1.0")),
        )
        assertSameJson(
            """{"type":"state.set","id":"c-1","payload":{"talkMode":"ptt","talkTargets":["g:camera"],"listenGroupIds":["camera"]}}""",
            ProtocolCodec.encode("state.set", StateSet(talkTargets = listOf("g:camera"), listenGroupIds = listOf("camera"), talkMode = TalkMode.PTT), "c-1"),
        )
        // Partial state.set: only the field that changed is on the wire.
        assertSameJson("""{"type":"state.set","payload":{"micLive":true}}""", ProtocolCodec.encode("state.set", StateSet(micLive = true)))
        assertSameJson("""{"type":"message.ack","payload":{"messageId":"m-9"}}""", ProtocolCodec.encode("message.ack", MessageAck("m-9")))
        assertSameJson(
            """{"type":"message.send","payload":{"to":"d:admin","text":"OK","kind":"quick"}}""",
            ProtocolCodec.encode("message.send", MessageSend("d:admin", "OK", "quick")),
        )
        assertSameJson("""{"type":"signal.send","payload":{"to":"g:camera"}}""", ProtocolCodec.encode("signal.send", SignalSend("g:camera")))
        assertSameJson("""{"type":"ping","payload":{}}""", ProtocolCodec.encodeEmpty("ping"))
        assertSameJson(
            """{"type":"status","payload":{"rtcConnected":true,"speaking":false,"battery":82,"charging":false,"headset":true,"rttMs":12,"outputRoute":"headset"}}""",
            ProtocolCodec.encode("status", StatusPayload(true, false, 82, false, true, 12, "headset")),
        )
    }

    @Test fun `REST bodies decode`() {
        val info = ProtocolJson.decodeFromString(
            InfoResponse.serializer(),
            """{"apiVersion":1,"serverId":"6e2a","name":"Emmanuel's MacBook","appVersion":"0.1.0","fingerprint":"ab12","joinOpen":true,"livekitUrl":"/rtc","minClientVersion":"0.1.0"}""",
        )
        assertEquals("/rtc", info.livekitUrl)
        val join = ProtocolJson.decodeFromString(
            SessionResponse.serializer(),
            """{"deviceToken":"tok","livekitToken":"jwt","livekitUrl":"/rtc","roomName":"partyline","me":${Samples.DEVICE_ME},"groups":[]}""",
        )
        assertEquals("tok", join.deviceToken)
        val err = ProtocolJson.decodeFromString(ApiErrorBody.serializer(), """{"error":{"code":"invalid_code","message":"Wrong code"}}""")
        assertEquals("invalid_code", err.error.code)
        val req = ProtocolJson.encodeToString(JoinRequest.serializer(), JoinRequest("483920", "0f3c", "Camera 2", appVersion = "0.1.0"))
        // platform/apiVersion are defaults but must be on the wire: the server requires them.
        assertSameJson("""{"joinCode":"483920","deviceId":"0f3c","displayName":"Camera 2","platform":"android","appVersion":"0.1.0","apiVersion":1}""", req)
    }

    private fun assertSameJson(expected: String, actual: String) {
        val a = Json.parseToJsonElement(actual).jsonObject
        // `ts` is stamped at send time; compare without it.
        assertEquals(Json.parseToJsonElement(expected), JsonObject(a - "ts"))
    }
}

/** Runs against packages/protocol/samples when the monorepo is checked out next to this app. */
class SharedSamples {
    private val dir: File? = listOf("../../../packages/protocol/samples", "../../packages/protocol/samples")
        .map { File(it) }.firstOrNull { it.isDirectory }

    private val serverTypes = setOf(
        "welcome", "ack", "error", "pong", "device.upsert", "device.removed", "groups.updated", "server.updated",
        "settings.updated", "message", "message.acked", "signal", "token.refreshed", "admin.notice", "kicked", "server.shutdown",
    )

    @Test fun `all shared ws samples from the server decode to a known event`() {
        assumeTrue("shared samples not found", dir != null)
        val files = File(dir, "ws").listFiles { f -> f.extension == "json" }!!.sortedBy { it.name }
        var checked = 0
        for (f in files) {
            val text = f.readText()
            val type = Json.parseToJsonElement(text).jsonObject["type"].toString().trim('"')
            if (type !in serverTypes) continue
            val e = ProtocolCodec.decode(text)
            assertFalse("${f.name} decoded as Unknown", e is ServerEvent.Unknown)
            checked++
        }
        assertTrue("expected server samples, found $checked", checked >= 10)
    }

    @Test fun `shared client samples round-trip through our payload types`() {
        assumeTrue(dir != null)
        fun payload(name: String): JsonElement = Json.parseToJsonElement(File(dir, "ws/$name").readText()).jsonObject["payload"]!!
        fun <T> roundTrip(name: String, s: kotlinx.serialization.KSerializer<T>) =
            assertEquals(name, payload(name), ProtocolJson.encodeToJsonElement(s, ProtocolJson.decodeFromJsonElement(s, payload(name))))
        roundTrip("01-auth.json", AuthPayload.serializer())
        roundTrip("03-state.set.json", StateSet.serializer())
        roundTrip("06-state.set.micLive.json", StateSet.serializer())
        roundTrip("08-state.set.micOff.json", StateSet.serializer())
        roundTrip("10-message.ack.json", MessageAck.serializer())
        roundTrip("message.send.quick.json", MessageSend.serializer())
        roundTrip("signal.send.json", SignalSend.serializer())
    }

    @Test fun `shared rest samples decode`() {
        assumeTrue(dir != null)
        fun read(n: String) = File(dir, "rest/$n").readText()
        ProtocolJson.decodeFromString(InfoResponse.serializer(), read("info.response.json"))
        val join = ProtocolJson.decodeFromString(SessionResponse.serializer(), read("join.response.json"))
        assertTrue(join.deviceToken!!.isNotEmpty())
        ProtocolJson.decodeFromString(SessionResponse.serializer(), read("session.response.json"))
        ProtocolJson.decodeFromString(JoinRequest.serializer(), read("join.request.json"))
        val msgs = ProtocolJson.decodeFromString(ListSerializer(Message.serializer()), read("messages.response.json"))
        assertEquals("m-9", msgs.first().id)
        for (e in listOf("error.invalid_code.json", "error.rate_limited.json", "error.revoked.json")) {
            ProtocolJson.decodeFromString(ApiErrorBody.serializer(), read(e))
        }
    }

    @Test fun `routing on the shared welcome`() {
        assumeTrue(dir != null)
        val w = (ProtocolCodec.decode(File(dir, "ws/02-welcome.json").readText()) as ServerEvent.WelcomeEvent).welcome
        val roster = (w.devices + w.me).associateBy { it.id }
        val admin = w.devices.first { it.isAdmin }
        // Camera 2 talks to g:camera; the producer listens to camera → producer may subscribe.
        val r = RoutingEngine.compute(w.me.id, roster, w.settings, listOf(admin.id))
        assertEquals(setOf(admin.id), r.allowedSubscribers)
        // Producer talks to g:camera, Camera 2 listens to camera → played.
        assertTrue(r.playback.getValue(admin.id).enabled)
        assertEquals("d:${admin.id}", RoutingEngine.replyTarget(w.me.id, roster))
    }
}

object Samples {
    const val DEVICE_ME = """{"id":"0f3c","displayName":"Camera 2","platform":"android","appVersion":"0.1.0","groupId":"camera",
        "listenGroupIds":["camera"],"canTalkGroupIds":["camera"],"isAdmin":false,"forcedTalkMode":null,"adminMuted":false,
        "createdAt":"2026-11-05T18:02:11Z","lastSeenAt":"2026-11-05T18:02:11Z",
        "live":{"online":true,"rtcConnected":false,"micLive":false,"speakerMuted":false,"talkMode":"ptt","talkTargets":["g:camera"],
        "speaking":false,"battery":null,"charging":null,"headset":null,"outputRoute":null,"rttMs":null}}"""

    const val ADMIN = """{"id":"admin","displayName":"Producer","platform":"desktop","appVersion":"0.1.0","groupId":"producer",
        "listenGroupIds":["producer","camera"],"canTalkGroupIds":["producer","camera","backstage"],"isAdmin":true,"forcedTalkMode":null,
        "adminMuted":false,"createdAt":"2026-11-05T18:02:11Z","lastSeenAt":"2026-11-05T18:02:11Z",
        "live":{"online":true,"rtcConnected":true,"micLive":false,"speakerMuted":false,"talkMode":"latch","talkTargets":["g:camera"],
        "speaking":false,"battery":null,"charging":null,"headset":true,"outputRoute":"headset","rttMs":4}}"""

    const val WELCOME = """{"type":"welcome","ts":"2026-11-05T18:02:11Z","payload":{
        "me":$DEVICE_ME,"devices":[$ADMIN,$DEVICE_ME],
        "groups":[{"id":"producer","name":"Producer","color":"#e11d48","sortOrder":0,"defaultTalkMode":"latch"},
                  {"id":"camera","name":"Camera","color":"#2563eb","sortOrder":1,"defaultTalkMode":null}],
        "server":{"serverId":"6e2a","name":"Emmanuel's MacBook","appVersion":"0.1.0","apiVersion":1,"joinCode":null,"joinOpen":true,"fingerprint":"ab12","failedJoinAttempts":0},
        "settings":{"crewCanBroadcast":false,"defaultTalkMode":"ptt","quickReplies":["OK","Standby"]},
        "livekitToken":"lk","roomName":"partyline","messages":[]}}"""
}
