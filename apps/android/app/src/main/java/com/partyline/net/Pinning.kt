package com.partyline.net

import okhttp3.OkHttpClient
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager

/** sha256 of the DER certificate, lowercase hex: the `fp` in mDNS TXT and the QR link. */
fun X509Certificate.sha256Fingerprint(): String =
    MessageDigest.getInstance("SHA-256").digest(encoded).joinToString("") { "%02x".format(it) }

/** Normalises user/TXT input ("AB:12:…" or "ab12…") to lowercase hex without separators. */
fun normalizeFingerprint(fp: String): String = fp.lowercase().filter { it in '0'..'9' || it in 'a'..'f' }

/** Thrown when the server presents a certificate that does not match the pin. */
class PinMismatchException(val expected: String, val actual: String) :
    CertificateException("Server certificate changed (expected $expected, got $actual)")

/**
 * Trusts exactly one leaf certificate by fingerprint. The server cert is self-signed and
 * there is no CA, so chain building and hostname checks are replaced by this pin.
 *
 * With [expected] == null the manager is in trust-on-first-use capture mode: it accepts the
 * certificate and records its fingerprint in [observed] so the UI can ask the user. Capture
 * mode is only used for `GET /api/info` before the user confirms; nothing secret is sent.
 */
class PinnedTrustManager(private val expected: String?) : X509TrustManager {
    @Volatile var observed: String? = null
        private set

    override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
        val leaf = chain?.firstOrNull() ?: throw CertificateException("Empty certificate chain")
        val fp = leaf.sha256Fingerprint()
        observed = fp
        if (expected != null && fp != expected) throw PinMismatchException(expected, fp)
    }

    override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) =
        throw CertificateException("Client certificates are not used")

    override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
}

object PinnedHttp {
    /** One OkHttp client per pin; REST, the control WebSocket and LiveKit signaling all use it. */
    fun client(expectedFingerprint: String?, trustManager: PinnedTrustManager = PinnedTrustManager(expectedFingerprint)): OkHttpClient {
        val ssl = SSLContext.getInstance("TLS").apply { init(null, arrayOf(trustManager), SecureRandom()) }
        return OkHttpClient.Builder()
            .sslSocketFactory(ssl.socketFactory, trustManager)
            // The pin is the identity check; LAN IPs change and the cert's SANs may be stale.
            .hostnameVerifier { _, _ -> true }
            .connectTimeout(5, TimeUnit.SECONDS)
            .readTimeout(10, TimeUnit.SECONDS)
            .writeTimeout(10, TimeUnit.SECONDS)
            // WebSocket keepalive is our own ping/pong (§3); OkHttp pings would double it.
            .pingInterval(0, TimeUnit.SECONDS)
            .retryOnConnectionFailure(true)
            .build()
    }
}
