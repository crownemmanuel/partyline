package com.partyline.model

import org.junit.Assert.assertEquals
import org.junit.Test

/** "Talking: …" line (IntercomSession.updateTalking → RoutingEngine.talkingNames), iOS semantics. */
class TalkingIndicatorTest {
    private fun dev(id: String, group: String, targets: List<String> = listOf("g:$group"), micLive: Boolean = false,
                    speaking: Boolean = false, admin: Boolean = false, adminMuted: Boolean = false) = Device(
        id = id, displayName = id, groupId = group, listenGroupIds = listOf(group), canTalkGroupIds = listOf(group),
        isAdmin = admin, adminMuted = adminMuted,
        live = LiveState(online = true, talkTargets = targets, micLive = micLive, speaking = speaking),
    )

    private fun talking(me: String, roster: Map<String, Device>, liveKit: Collection<String> = roster.keys - me,
                        vad: Set<String> = emptySet()): List<String> {
        val r = RoutingEngine.compute(me, roster, Settings(), liveKit)
        return RoutingEngine.talkingNames(roster, r.audible, vad)
    }

    private fun roster(vararg d: Device) = d.associateBy { it.id }

    @Test fun `producer mic live but silent - shown without voice detection`() {
        // The cross-device case: fake-mic beep, no VAD hit and no server "speaking" flag.
        val r = roster(dev("Producer", "producer", targets = listOf("g:camera"), micLive = true, admin = true), dev("Andro", "camera"))
        assertEquals(listOf("Producer"), talking("Andro", r))
    }

    @Test fun `shown even before the LiveKit track exists`() {
        val r = roster(dev("Producer", "producer", targets = listOf("g:camera"), micLive = true, admin = true), dev("Andro", "camera"))
        assertEquals(listOf("Producer"), talking("Andro", r, liveKit = emptyList()))
    }

    @Test fun `not shown when talking to another group`() {
        val r = roster(dev("Producer", "producer", targets = listOf("g:backstage"), micLive = true, admin = true), dev("Andro", "camera"))
        assertEquals(emptyList<String>(), talking("Andro", r))
    }

    @Test fun `not shown when mic is closed and voice detection is quiet`() {
        val r = roster(dev("Producer", "producer", targets = listOf("g:camera"), micLive = false, speaking = true, admin = true), dev("Andro", "camera"))
        assertEquals(emptyList<String>(), talking("Andro", r))
    }

    @Test fun `voice detection alone is enough when routed to me`() {
        val r = roster(dev("C2", "camera"), dev("Andro", "camera"))
        assertEquals(listOf("C2"), talking("Andro", r, vad = setOf("C2")))
    }

    @Test fun `admin muted device is never shown`() {
        val r = roster(dev("C2", "camera", micLive = true, adminMuted = true), dev("Andro", "camera"))
        assertEquals(emptyList<String>(), talking("Andro", r))
    }

    @Test fun `direct talk to me is shown, my own mic never is`() {
        val r = roster(dev("Producer", "producer", targets = listOf("d:Andro"), micLive = true, admin = true),
            dev("Andro", "camera", micLive = true))
        assertEquals(listOf("Producer"), talking("Andro", r))
    }
}
