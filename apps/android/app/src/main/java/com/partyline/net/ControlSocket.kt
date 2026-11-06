package com.partyline.net

import android.os.SystemClock
import android.util.Log
import com.partyline.model.AuthPayload
import com.partyline.model.ProtocolCodec
import com.partyline.model.ServerEvent
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.atomic.AtomicInteger

/**
 * The control WebSocket `/api/ws` (§3): auth first, ping every 15 s, reconnect with backoff
 * 1, 2, 4, 8, 15, 15… s (§6.6). Decoded server messages come out of [events].
 */
class ControlSocket(
    private val scope: CoroutineScope,
    /** Called before every attempt so a rediscovered address or a new pin is picked up. */
    private val connection: () -> Pair<Endpoint, OkHttpClient>,
    private val deviceToken: () -> String?,
    private val appVersion: String,
) {
    sealed interface State {
        data object Idle : State
        data class Connecting(val attempt: Int) : State
        /** Socket open and `welcome` received. */
        data object Connected : State
        data class Waiting(val attempt: Int, val retryInMs: Long, val lastError: String?) : State
    }

    private val _state = MutableStateFlow<State>(State.Idle)
    val state: StateFlow<State> = _state

    private val _events = MutableSharedFlow<ServerEvent>(extraBufferCapacity = 256)
    val events: SharedFlow<ServerEvent> = _events

    /** WebSocket ping → pong round trip, our `rttMs` for `status`. */
    private val _rttMs = MutableStateFlow<Double?>(null)
    val rttMs: StateFlow<Double?> = _rttMs

    /** Consecutive attempts that failed before `welcome`; the session rediscovers via NSD on ≥ 2. */
    private val _failures = MutableStateFlow(0)
    val failures: StateFlow<Int> = _failures

    private val idCounter = AtomicInteger(0)
    private var loop: Job? = null
    @Volatile private var socket: WebSocket? = null
    @Volatile private var nextDelayOverrideMs: Long? = null
    @Volatile private var kickNow: CompletableDeferred<Unit>? = null

    fun nextId(): String = "a-${idCounter.incrementAndGet()}"

    fun start() {
        if (loop?.isActive == true) return
        loop = scope.launch { runLoop() }
    }

    fun stop() {
        loop?.cancel()
        loop = null
        socket?.close(1000, "leave")
        socket = null
        _state.value = State.Idle
    }

    /** Sends a pre-encoded envelope. Returns false while not connected (caller resyncs on welcome). */
    fun send(text: String): Boolean {
        val ws = socket ?: return false
        if (_state.value != State.Connected) return false
        return ws.send(text)
    }

    /** `server.shutdown`: wait this long before the next attempt instead of the backoff. */
    fun reconnectAfter(ms: Long) { nextDelayOverrideMs = ms }

    /** Skip the remaining backoff (network came back, address changed). */
    fun retryNow() { kickNow?.complete(Unit) }

    private suspend fun runLoop() {
        var attempt = 0
        while (scope.isActive) {
            attempt++
            _state.value = State.Connecting(attempt)
            val result = runOnce()
            if (result.gotWelcome) {
                attempt = 0
                _failures.value = 0
            } else {
                _failures.value = _failures.value + 1
            }
            val delayMs = nextDelayOverrideMs ?: backoffFor(attempt)
            nextDelayOverrideMs = null
            _state.value = State.Waiting(attempt, delayMs, result.error)
            val kick = CompletableDeferred<Unit>().also { kickNow = it }
            withTimeoutOrNull(delayMs) { kick.await() }
            kickNow = null
        }
    }

    private class RunResult(val gotWelcome: Boolean, val error: String?)

    private suspend fun runOnce(): RunResult {
        val token = deviceToken() ?: return RunResult(false, "no_token")
        val (endpoint, http) = connection()
        val closed = CompletableDeferred<String?>()
        var gotWelcome = false
        var lastPong = SystemClock.elapsedRealtime()
        var pingSentAt = 0L

        val listener = object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                webSocket.send(ProtocolCodec.encode("auth", AuthPayload(token, appVersion)))
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                val event = try {
                    ProtocolCodec.decode(text)
                } catch (e: Exception) {
                    Log.w(TAG, "Undecodable message: ${text.take(200)}", e)
                    return
                }
                when (event) {
                    is ServerEvent.Pong -> {
                        lastPong = SystemClock.elapsedRealtime()
                        if (pingSentAt > 0) _rttMs.value = (lastPong - pingSentAt).toDouble()
                    }
                    is ServerEvent.WelcomeEvent -> {
                        gotWelcome = true
                        lastPong = SystemClock.elapsedRealtime()
                        _state.value = State.Connected
                    }
                    else -> Unit
                }
                _events.tryEmit(event)
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null)
                closed.complete("closed $code $reason")
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                closed.complete("closed $code $reason")
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                Log.w(TAG, "WS failure: ${t.message}")
                closed.complete(t.message ?: t.javaClass.simpleName)
                if (t is PinMismatchException) _events.tryEmit(ServerEvent.Error(null, "pin_mismatch", t.message ?: ""))
            }
        }

        val ws = http.newWebSocket(Request.Builder().url(endpoint.wsUrl()).build(), listener)
        socket = ws
        val pinger = scope.launch {
            while (isActive) {
                delay(PING_INTERVAL_MS)
                if (_state.value != State.Connected) continue
                if (SystemClock.elapsedRealtime() - lastPong > PONG_TIMEOUT_MS) {
                    Log.w(TAG, "No pong for ${PONG_TIMEOUT_MS / 1000}s, reconnecting")
                    ws.cancel()
                    closed.complete("pong timeout")
                    break
                }
                pingSentAt = SystemClock.elapsedRealtime()
                ws.send(ProtocolCodec.encodeEmpty("ping"))
            }
        }
        // The server must answer auth within a few seconds; treat silence as a dead socket.
        val authWatch = scope.launch {
            delay(AUTH_TIMEOUT_MS)
            if (!gotWelcome) { ws.cancel(); closed.complete("no welcome") }
        }
        val error = try {
            closed.await()
        } finally {
            pinger.cancel()
            authWatch.cancel()
            ws.cancel()
            if (socket === ws) socket = null
        }
        return RunResult(gotWelcome, error)
    }

    companion object {
        private const val TAG = "ControlSocket"
        const val PING_INTERVAL_MS = 15_000L
        const val PONG_TIMEOUT_MS = 30_000L
        const val AUTH_TIMEOUT_MS = 8_000L

        /** Delay after the n-th consecutive failure (1-based): 1, 2, 4, 8, 15, 15… s. */
        fun backoffFor(failure: Int): Long = Backoff.delayFor(failure)
    }
}
