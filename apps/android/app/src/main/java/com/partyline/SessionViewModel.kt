package com.partyline

import android.app.Application
import android.os.Build
import android.os.PowerManager
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.partyline.call.EndReason
import com.partyline.call.IntercomService
import com.partyline.call.IntercomSession
import com.partyline.call.Phase
import com.partyline.call.SessionState
import com.partyline.discovery.DiscoveredServer
import com.partyline.discovery.NsdDiscovery
import com.partyline.model.JoinRequest
import com.partyline.net.ApiException
import com.partyline.net.Endpoint
import com.partyline.net.PinMismatchException
import com.partyline.net.PinnedHttp
import com.partyline.net.PinnedTrustManager
import com.partyline.net.ServerClient
import com.partyline.net.normalizeFingerprint
import com.partyline.store.SavedServer
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.net.URI
import javax.net.ssl.SSLHandshakeException

/** App-level state machine: idle → discovering → joining → connecting → live → reconnecting. */
enum class Stage { IDLE, DISCOVERING, JOINING, CONNECTING, LIVE, RECONNECTING }

/** A server the user picked: from mDNS, a QR link, or typed by hand. */
data class Candidate(
    val name: String,
    val host: String,
    val port: Int = 8443,
    val serverId: String? = null,
    /** Fingerprint learned out of band (mDNS TXT or QR) to compare with what the server presents. */
    val advertisedFp: String? = null,
    val joinCode: String? = null,
    val fromQr: Boolean = false,
)

data class TrustPrompt(
    val candidate: Candidate,
    val serverId: String,
    val serverName: String,
    val fingerprint: String,
    /** True when mDNS/QR advertised the same fingerprint. */
    val matchesAdvertised: Boolean?,
    /** We had a different pin for this server id: the certificate changed. */
    val changedFrom: String?,
)

data class UiState(
    val stage: Stage = Stage.IDLE,
    val servers: List<DiscoveredServer> = emptyList(),
    val candidate: Candidate? = null,
    /** Server id + name confirmed for [candidate] after TOFU. */
    val trustedServerId: String? = null,
    val trust: TrustPrompt? = null,
    val busy: Boolean = false,
    val error: String? = null,
    val displayName: String = "",
    val savedServer: SavedServer? = null,
    val hasToken: Boolean = false,
    val killedLastTime: Boolean = false,
    val endedMessage: String? = null,
    val permissionsReady: Boolean = false,
    val askBatteryExemption: Boolean = false,
)

@OptIn(ExperimentalCoroutinesApi::class)
class SessionViewModel(app: Application) : AndroidViewModel(app) {

    private val store = PartyLineApp.store(app)
    private val discovery = NsdDiscovery(app)
    private var discoveryJob: Job? = null
    private var autoJoinTried = false

    private val _ui = MutableStateFlow(
        UiState(
            displayName = store.displayName,
            savedServer = store.server,
            hasToken = store.deviceToken != null,
            killedLastTime = store.sessionActive && IntercomService.current.value == null,
        ),
    )
    val ui: StateFlow<UiState> = _ui

    val session: StateFlow<IntercomSession?> = IntercomService.current
    val call: StateFlow<SessionState?> = IntercomService.current
        .flatMapLatest { it?.state ?: flowOf(null) }
        .stateIn(viewModelScope, SharingStarted.Eagerly, null)

    init {
        if (_ui.value.killedLastTime) store.sessionActive = false
        viewModelScope.launch {
            call.collect { s -> onCallState(s) }
        }
    }

    private fun onCallState(s: SessionState?) {
        if (s == null) {
            if (_ui.value.stage in setOf(Stage.CONNECTING, Stage.LIVE, Stage.RECONNECTING)) {
                _ui.update { it.copy(stage = Stage.IDLE, hasToken = store.deviceToken != null, savedServer = store.server) }
            }
            return
        }
        val stage = when (s.phase) {
            Phase.CONNECTING -> Stage.CONNECTING
            Phase.LIVE -> Stage.LIVE
            Phase.RECONNECTING -> Stage.RECONNECTING
            Phase.ENDED -> Stage.IDLE
        }
        val ended = when (s.endReason) {
            EndReason.KICKED -> "You were removed by the producer. Join again with a code."
            EndReason.REVOKED -> "This phone is no longer paired. Join again with a code."
            else -> null
        }
        _ui.update {
            it.copy(
                stage = stage,
                endedMessage = ended ?: it.endedMessage,
                hasToken = store.deviceToken != null,
                savedServer = store.server,
                askBatteryExemption = it.askBatteryExemption || (stage == Stage.LIVE && shouldAskBattery()),
            )
        }
        if (stage == Stage.IDLE) startDiscovery()
        if (s.endReason == EndReason.CERT_CHANGED) recheckSavedServer()
    }

    /**
     * The pinned cert no longer matches (renewal or a new host IP). Show the trust prompt again for
     * the saved server, with the fingerprint from mDNS TXT when discovery finds it within a few seconds.
     */
    private fun recheckSavedServer() {
        val saved = store.server ?: return
        if (_ui.value.trust != null || _ui.value.busy) return
        viewModelScope.launch {
            val seen = kotlinx.coroutines.withTimeoutOrNull(3_000) {
                _ui.first { ui -> ui.servers.any { it.serverId == saved.serverId } }
                    .servers.first { it.serverId == saved.serverId }
            }
            select(
                Candidate(seen?.name ?: saved.name, seen?.host ?: saved.host, seen?.port ?: saved.port,
                    saved.serverId, seen?.fingerprint),
            )
        }
    }

    // ---------------------------------------------------------------- launch / permissions

    fun onPermissionsReady() {
        _ui.update { it.copy(permissionsReady = true) }
        if (session.value != null) return
        // §6.1 + ANDROID.md 10: launch with saved token → session → crew screen, no code.
        if (!autoJoinTried && store.autoJoin && store.deviceToken != null && store.server != null) {
            autoJoinTried = true
            rejoin()
        } else {
            startDiscovery()
        }
    }

    fun rejoin() {
        val server = store.server ?: return startDiscovery()
        if (store.pinnedFingerprint(server.serverId) == null || store.deviceToken == null) return startDiscovery()
        stopDiscovery()
        _ui.update { it.copy(stage = Stage.CONNECTING, error = null, endedMessage = null) }
        IntercomService.start(getApplication(), server, null)
        watchServiceStart()
    }

    /** The service publishes its session within a moment; if it never does, fall back to discovery. */
    private fun watchServiceStart() {
        viewModelScope.launch {
            kotlinx.coroutines.delay(15_000)
            if (session.value == null && _ui.value.stage == Stage.CONNECTING) {
                _ui.update { it.copy(stage = Stage.DISCOVERING, error = "Could not start the intercom. Check the microphone permission.") }
                startDiscovery()
            }
        }
    }

    // ---------------------------------------------------------------- discovery

    fun startDiscovery() {
        if (discoveryJob?.isActive == true) return
        if (_ui.value.stage == Stage.IDLE) _ui.update { it.copy(stage = Stage.DISCOVERING) }
        discoveryJob = viewModelScope.launch {
            discovery.servers().collect { list -> _ui.update { it.copy(servers = list) } }
        }
    }

    fun stopDiscovery() {
        discoveryJob?.cancel()
        discoveryJob = null
    }

    fun pick(server: DiscoveredServer) = select(
        Candidate(server.name, server.host, server.port, server.serverId, server.fingerprint),
    )

    fun manual(address: String) {
        val trimmed = address.trim().removePrefix("https://").removeSuffix("/")
        if (trimmed.isEmpty()) return
        val (host, port) = splitHostPort(trimmed) ?: return _ui.update { it.copy(error = "Not an address: $address") }
        select(Candidate(host, host, port))
    }

    /** QR / deep link: `https://<ip>:8443/#join?code=<6 digits>&fp=<fp>&id=<server uuid>` (§1). */
    fun onQr(text: String): Boolean {
        val c = parseJoinLink(text) ?: run {
            _ui.update { it.copy(error = "That QR code is not a PartyLine join link") }
            return false
        }
        select(c)
        return true
    }

    fun select(c: Candidate) {
        _ui.update { it.copy(candidate = c, busy = true, error = null, trust = null, trustedServerId = null, stage = Stage.JOINING) }
        viewModelScope.launch {
            // Capture mode: accept any cert for this one unauthenticated GET, then decide.
            val tm = PinnedTrustManager(null)
            val endpoint = Endpoint(c.host, c.port)
            val info = try {
                ServerClient(endpoint, PinnedHttp.client(null, tm)).info()
            } catch (e: Exception) {
                _ui.update { it.copy(busy = false, error = "Cannot reach ${c.host}:${c.port} (${e.message ?: e.javaClass.simpleName})") }
                return@launch
            }
            val observed = tm.observed ?: info.fingerprint
            if (info.apiVersion != com.partyline.model.API_VERSION) {
                _ui.update { it.copy(busy = false, error = "Server speaks protocol v${info.apiVersion}; this app needs v1") }
                return@launch
            }
            val advertised = c.advertisedFp?.let(::normalizeFingerprint)
            val pinned = store.pinnedFingerprint(info.serverId)
            val candidate = c.copy(serverId = info.serverId, name = info.name.ifBlank { c.name })
            when {
                pinned == observed -> trusted(candidate, info.serverId)
                c.fromQr && advertised == observed -> {
                    // The QR is an out-of-band channel: it proves the fingerprint, also after a renewal.
                    store.pin(info.serverId, observed); trusted(candidate, info.serverId)
                }
                else -> _ui.update {
                    it.copy(
                        busy = false,
                        trust = TrustPrompt(
                            candidate, info.serverId, info.name.ifBlank { c.name }, observed,
                            matchesAdvertised = advertised?.let { a -> a == observed },
                            changedFrom = pinned,
                        ),
                    )
                }
            }
        }
    }

    fun acceptTrust() {
        val t = _ui.value.trust ?: return
        store.pin(t.serverId, t.fingerprint)
        trusted(t.candidate, t.serverId)
    }

    fun rejectTrust() = _ui.update { it.copy(trust = null, candidate = null, stage = Stage.DISCOVERING) }

    private fun trusted(c: Candidate, serverId: String) {
        _ui.update { it.copy(busy = false, trust = null, candidate = c, trustedServerId = serverId) }
        // Already paired with this server: no code needed.
        if (store.deviceToken != null && store.server?.serverId == serverId) {
            store.server = SavedServer(serverId, c.name, c.host, c.port)
            rejoin()
        }
    }

    fun cancelJoin() = _ui.update { it.copy(candidate = null, trustedServerId = null, error = null, stage = Stage.DISCOVERING) }

    fun join(code: String, name: String) {
        val c = _ui.value.candidate ?: return
        val serverId = _ui.value.trustedServerId ?: return
        val pin = store.pinnedFingerprint(serverId) ?: return
        val displayName = name.trim().take(40)
        if (code.length != 6 || displayName.isEmpty()) {
            _ui.update { it.copy(error = if (displayName.isEmpty()) "Type your name" else "The code has 6 digits") }
            return
        }
        store.displayName = displayName
        _ui.update { it.copy(busy = true, error = null, displayName = displayName) }
        viewModelScope.launch {
            val client = ServerClient(Endpoint(c.host, c.port), PinnedHttp.client(pin))
            try {
                val r = client.join(JoinRequest(code, store.deviceId, displayName, appVersion = BuildConfig.VERSION_NAME))
                store.deviceToken = r.deviceToken ?: error("Server returned no device token")
                val server = SavedServer(serverId, c.name, c.host, c.port)
                store.server = server
                stopDiscovery()
                _ui.update { it.copy(busy = false, stage = Stage.CONNECTING, candidate = null, hasToken = true, savedServer = server, endedMessage = null) }
                IntercomService.start(getApplication(), server, r)
                watchServiceStart()
            } catch (e: ApiException) {
                val msg = when (e.code) {
                    "invalid_code" -> "Wrong code. Check the code on the host screen."
                    "join_closed" -> "Joining is closed on this server. Ask the producer to open it."
                    "rate_limited" -> "Too many tries. Wait ${e.retryAfterSec ?: 300} s."
                    "version_unsupported" -> "This app is too old for the server."
                    else -> e.message
                }
                _ui.update { it.copy(busy = false, error = msg) }
            } catch (e: SSLHandshakeException) {
                val pinErr = generateSequence<Throwable>(e) { it.cause }.any { it is PinMismatchException }
                if (pinErr) select(c) else _ui.update { it.copy(busy = false, error = "Secure connection failed") }
            } catch (e: Exception) {
                _ui.update { it.copy(busy = false, error = "Join failed: ${e.message}") }
            }
        }
    }

    fun clearError() = _ui.update { it.copy(error = null) }
    fun dismissKilled() = _ui.update { it.copy(killedLastTime = false) }
    fun dismissEnded() = _ui.update { it.copy(endedMessage = null) }

    // ---------------------------------------------------------------- settings

    fun setAutoJoin(v: Boolean) { store.autoJoin = v }
    fun setTts(v: Boolean) { store.textToSpeech = v }
    val autoJoin get() = store.autoJoin
    val tts get() = store.textToSpeech

    fun leave() {
        session.value?.leave()
        _ui.update { it.copy(stage = Stage.IDLE) }
    }

    /** Forget the pairing: next join needs a code. */
    fun forgetServer() {
        session.value?.leave()
        store.forgetSession()
        store.server = null
        _ui.update { it.copy(hasToken = false, savedServer = null, stage = Stage.IDLE) }
        startDiscovery()
    }

    private fun shouldAskBattery(): Boolean {
        if (store.batteryPromptShown) return false
        val pm = getApplication<Application>().getSystemService(PowerManager::class.java)
        return !pm.isIgnoringBatteryOptimizations(getApplication<Application>().packageName)
    }

    fun batteryPromptHandled() {
        store.batteryPromptShown = true
        _ui.update { it.copy(askBatteryExemption = false) }
    }

    override fun onCleared() {
        stopDiscovery()
        super.onCleared()
    }

    companion object {
        /** Vendors known to kill foreground services (dontkillmyapp.com). */
        fun vendorHelpUrl(): String? {
            val m = Build.MANUFACTURER.lowercase()
            val slug = listOf("samsung", "xiaomi", "huawei", "oneplus", "oppo", "vivo", "realme", "meizu", "asus", "nokia", "sony")
                .firstOrNull { m.contains(it) } ?: return null
            return "https://dontkillmyapp.com/$slug"
        }

        fun splitHostPort(s: String): Pair<String, Int>? {
            if (s.startsWith("[")) { // [v6]:port
                val end = s.indexOf(']').takeIf { it > 0 } ?: return null
                val host = s.substring(1, end)
                val port = s.substring(end + 1).removePrefix(":").toIntOrNull() ?: 8443
                return host to port
            }
            val parts = s.split(':')
            return when (parts.size) {
                1 -> parts[0] to 8443
                2 -> parts[0] to (parts[1].toIntOrNull() ?: return null)
                else -> s to 8443 // bare IPv6
            }
        }

        /** QR / deep link: `https://<ip>:<port>/#join?code=…&fp=…&id=…`, or `#install&code=…` (same fields). */
        fun parseJoinLink(text: String): Candidate? {
            val uri = runCatching { URI(text.trim()) }.getOrNull() ?: return null
            if (uri.scheme != "https" || uri.host == null) return null
            val frag = uri.rawFragment ?: return null
            // `#join?code=…` (join QR) or `#install&code=…` (the host's "Get the app" QR).
            val kind = listOf("join", "install").firstOrNull { frag.startsWith(it) } ?: return null
            val query = frag.removePrefix(kind).trimStart('?', '&')
            val params = query.split('&').filter { it.contains('=') }
                .associate { it.substringBefore('=') to java.net.URLDecoder.decode(it.substringAfter('='), "UTF-8") }
            val host = uri.host.removePrefix("[").removeSuffix("]")
            return Candidate(
                name = host, host = host, port = if (uri.port > 0) uri.port else 8443,
                serverId = params["id"], advertisedFp = params["fp"], joinCode = params["code"], fromQr = true,
            )
        }
    }
}
