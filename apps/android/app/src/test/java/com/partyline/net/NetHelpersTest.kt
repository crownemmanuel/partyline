package com.partyline.net

import com.partyline.SessionViewModel
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NetHelpersTest {

    @Test fun `livekit url is the base the SDK appends rtc to`() {
        assertEquals("wss://192.168.1.20:8443", Endpoint("192.168.1.20").livekitUrl("/rtc"))
        assertEquals("wss://[fe80::1]:8443", Endpoint("fe80::1").livekitUrl("/rtc"))
        assertEquals("wss://h:9000", Endpoint("h", 9000).livekitUrl("/rtc/"))
        assertEquals("wss://x:1", Endpoint("h").livekitUrl("wss://x:1/rtc"))
        assertEquals("wss://192.168.1.20:8443/api/ws", Endpoint("192.168.1.20").wsUrl())
    }

    @Test fun `backoff is 1 2 4 8 15 15`() {
        assertEquals(listOf(1_000L, 2_000L, 4_000L, 8_000L, 15_000L, 15_000L, 15_000L), (1..7).map { ControlSocket.backoffFor(it) })
    }

    @Test fun `fingerprints normalise`() {
        assertEquals("ab12cd", normalizeFingerprint("AB:12:cd"))
        assertEquals("ab12cd", normalizeFingerprint(" ab12 cd "))
    }

    @Test fun `join link from QR parses`() {
        val c = SessionViewModel.parseJoinLink("https://192.168.1.20:8443/#join?code=483920&fp=ab12cd&id=6e2a1c4e")!!
        assertEquals("192.168.1.20", c.host)
        assertEquals(8443, c.port)
        assertEquals("483920", c.joinCode)
        assertEquals("ab12cd", c.advertisedFp)
        assertEquals("6e2a1c4e", c.serverId)
        assertTrue(c.fromQr)
        assertNull(SessionViewModel.parseJoinLink("https://example.com/"))
        assertNull(SessionViewModel.parseJoinLink("not a url"))
    }

    @Test fun `install link from the Get the app QR parses like a join link`() {
        val c = SessionViewModel.parseJoinLink("https://192.168.86.40:9443/#install&code=483920&fp=ab12cd&id=6e2a1c4e")!!
        assertEquals("192.168.86.40", c.host)
        assertEquals(9443, c.port)
        assertEquals("483920", c.joinCode)
        assertEquals("ab12cd", c.advertisedFp)
        assertEquals("6e2a1c4e", c.serverId)
        assertTrue(c.fromQr)
        // The bare install page (no join fields) still opens the server, without a code.
        assertNull(SessionViewModel.parseJoinLink("https://192.168.86.40:9443/#install")!!.joinCode)
        assertNull(SessionViewModel.parseJoinLink("https://192.168.86.40:9443/#settings"))
    }

    @Test fun `manual address parsing`() {
        assertEquals("10.0.0.5" to 8443, SessionViewModel.splitHostPort("10.0.0.5"))
        assertEquals("10.0.0.5" to 9443, SessionViewModel.splitHostPort("10.0.0.5:9443"))
        assertEquals("fe80::1" to 8443, SessionViewModel.splitHostPort("[fe80::1]"))
        assertEquals("partyline.local" to 8443, SessionViewModel.splitHostPort("partyline.local"))
    }
}
