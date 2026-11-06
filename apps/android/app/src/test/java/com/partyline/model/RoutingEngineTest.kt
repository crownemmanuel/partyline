package com.partyline.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** PROTOCOL §5.1 against the ARCHITECTURE §4.1 example table: P(roducer), C1, C2 (camera), B1 (backstage). */
class RoutingEngineTest {

    private fun dev(
        id: String, group: String, listen: List<String> = listOf(group), targets: List<String> = listOf("g:$group"),
        admin: Boolean = false, adminMuted: Boolean = false, online: Boolean = true, speakerMuted: Boolean = false,
    ) = Device(
        id = id, displayName = id, groupId = group, listenGroupIds = listen, canTalkGroupIds = listOf(group),
        isAdmin = admin, adminMuted = adminMuted,
        live = LiveState(online = online, talkTargets = targets, speakerMuted = speakerMuted),
    )

    private val settings = Settings()

    private fun roster(vararg d: Device) = d.associateBy { it.id }

    private fun base(pTargets: List<String> = listOf("g:camera"), pListen: List<String> = listOf("producer", "camera", "backstage")) = roster(
        dev("P", "producer", listen = pListen, targets = pTargets, admin = true),
        dev("C1", "camera"),
        dev("C2", "camera"),
        dev("B1", "backstage"),
    )

    private fun allowed(me: String, r: Map<String, Device>) =
        RoutingEngine.compute(me, r, settings, r.keys - me).allowedSubscribers

    private fun hears(me: String, r: Map<String, Device>) =
        RoutingEngine.compute(me, r, settings, r.keys - me).playing()

    @Test fun `producer talks to camera - only camera may subscribe`() {
        assertEquals(setOf("C1", "C2"), allowed("P", base()))
    }

    @Test fun `producer talks to camera and backstage`() {
        assertEquals(setOf("C1", "C2", "B1"), allowed("P", base(listOf("g:camera", "g:backstage"))))
    }

    @Test fun `producer talks to one device`() {
        assertEquals(setOf("C2"), allowed("P", base(listOf("d:C2"))))
        assertEquals(setOf("P"), hears("C2", base(listOf("d:C2"))) intersect setOf("P"))
        assertFalse("P" in hears("C1", base(listOf("d:C2"))))
    }

    @Test fun `camera talks - other camera and the producer listening to camera`() {
        assertEquals(setOf("C2", "P"), allowed("C1", base()))
    }

    @Test fun `producer listening only to camera does not hear backstage`() {
        val r = base(pListen = listOf("camera"))
        val heard = hears("P", r)
        assertTrue("C1" in heard)
        assertFalse("B1" in heard)
        // ...and backstage does not even grant the producer a subscription.
        assertFalse("P" in allowed("B1", r))
    }

    @Test fun `backstage phone never receives producer audio aimed at camera`() {
        assertFalse("B1" in allowed("P", base()))
        assertFalse("P" in hears("B1", base()))
    }

    @Test fun `reply to producer targets only the producer`() {
        val r = base().toMutableMap()
        r["C1"] = dev("C1", "camera", targets = listOf("d:P"))
        assertEquals(setOf("P"), allowed("C1", r))
        assertFalse("C1" in hears("C2", r))
        assertTrue("C1" in hears("P", r))
    }

    @Test fun `admin muted talker is not played`() {
        val r = base().toMutableMap()
        r["P"] = dev("P", "producer", listen = listOf("camera"), targets = listOf("g:camera"), admin = true, adminMuted = true)
        assertFalse("P" in hears("C1", r))
    }

    @Test fun `speaker mute and local mute disable playback, volume is passed through`() {
        val r = base().toMutableMap()
        r["C1"] = dev("C1", "camera", speakerMuted = true)
        assertTrue(hears("C1", r).isEmpty())
        val res = RoutingEngine.compute("C2", base(), settings, listOf("P", "C1"), localMute = mapOf("P" to true), localVolume = mapOf("C1" to 0.5))
        assertFalse(res.playback.getValue("P").enabled)
        assertTrue(res.playback.getValue("C1").enabled)
        assertEquals(0.5, res.playback.getValue("C1").volume, 0.0)
    }

    @Test fun `empty talk targets publish to nobody`() {
        assertTrue(allowed("P", base(emptyList())).isEmpty())
    }

    @Test fun `adminsHearEverything adds admins only while I target something`() {
        val r = roster(dev("P", "producer", listen = listOf("producer"), admin = true), dev("C1", "camera"), dev("C2", "camera"))
        val on = Settings(adminsHearEverything = true)
        assertEquals(setOf("C2", "P"), RoutingEngine.compute("C1", r, on, emptyList()).allowedSubscribers)
        val silent = r + ("C1" to dev("C1", "camera", targets = emptyList()))
        assertTrue(RoutingEngine.compute("C1", silent, on, emptyList()).allowedSubscribers.isEmpty())
        assertEquals(setOf("C2"), RoutingEngine.compute("C1", r, settings, emptyList()).allowedSubscribers)
    }

    @Test fun `unknown remote participant is not played and missing me routes nothing`() {
        val res = RoutingEngine.compute("C1", base(), settings, listOf("ghost"))
        assertFalse(res.playback.getValue("ghost").enabled)
        val none = RoutingEngine.compute("nobody", base(), settings, listOf("P"))
        assertTrue(none.allowedSubscribers.isEmpty())
        assertFalse(none.playback.getValue("P").enabled)
    }

    @Test fun `reply target is the first online admin`() {
        val r = base() + ("A2" to dev("A2", "producer", admin = true, online = false)) + ("A0" to dev("Aardvark", "producer", admin = true))
        assertEquals("d:Aardvark", RoutingEngine.replyTarget("C1", r.values.associateBy { it.id }))
        assertNull(RoutingEngine.replyTarget("C1", roster(dev("C1", "camera"))))
    }
}
