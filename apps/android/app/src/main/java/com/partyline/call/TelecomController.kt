package com.partyline.call

import android.content.Context
import android.net.Uri
import android.util.Log
import androidx.core.telecom.CallAttributesCompat
import androidx.core.telecom.CallControlResult
import androidx.core.telecom.CallControlScope
import androidx.core.telecom.CallEndpointCompat
import androidx.core.telecom.CallsManager
import com.partyline.audio.OutputRoute
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Core-Telecom self-managed call for the intercom session. The system then treats PartyLine
 * like a VoIP call: it survives Doze, a real incoming call holds it ([onHold]) and it is
 * resumed afterwards, and Bluetooth/wired routing goes through [CallEndpointCompat].
 */
class TelecomController(
    private val context: Context,
    private val scope: CoroutineScope,
    private val listener: Listener,
) {
    interface Listener {
        /** Telecom put us on hold (real call) or released the hold. */
        fun onHold(held: Boolean)
        /** System UI / Bluetooth device ended the call: leave the session. */
        fun onSystemDisconnect()
        /** Global mute toggled by the system (e.g. car kit, watch). */
        fun onSystemMute(muted: Boolean)
    }

    private val callsManager = CallsManager(context)
    private var callJob: Job? = null
    private var control: CallControlScope? = null

    private val _route = MutableStateFlow<OutputRoute?>(null)
    val route: StateFlow<OutputRoute?> = _route

    /**
     * Adds the call and waits until Telecom accepted it. Returns false when Telecom is
     * unavailable (registration refused, OEM quirk, timeout); the session then runs on the
     * foreground service alone and LiveKit manages audio itself.
     */
    suspend fun start(displayName: String): Boolean {
        if (callJob?.isActive == true) return true
        try {
            callsManager.registerAppWithTelecom(CallsManager.CAPABILITY_BASELINE)
        } catch (e: Exception) {
            Log.w(TAG, "Telecom registration failed", e)
            return false
        }
        val added = CompletableDeferred<Boolean>()
        val attributes = CallAttributesCompat(
            displayName = displayName,
            address = Uri.parse("partyline:intercom"),
            direction = CallAttributesCompat.DIRECTION_OUTGOING,
            callType = CallAttributesCompat.CALL_TYPE_AUDIO_CALL,
            callCapabilities = CallAttributesCompat.SUPPORTS_SET_INACTIVE,
        )
        callJob = scope.launch {
            try {
                callsManager.addCall(
                    attributes,
                    onAnswer = { },
                    onDisconnect = { _ ->
                        control = null
                        listener.onSystemDisconnect()
                    },
                    onSetActive = { listener.onHold(false) },
                    onSetInactive = { listener.onHold(true) },
                ) {
                    control = this
                    launch {
                        val result = setActive()
                        if (result is CallControlResult.Error) Log.w(TAG, "setActive failed: ${result.errorCode}")
                        added.complete(true)
                    }
                    launch { isMuted.collect { listener.onSystemMute(it) } }
                    launch {
                        combine(currentCallEndpoint, availableEndpoints) { cur, all -> cur to all }
                            .collect { (current, available) ->
                                _route.value = current.toRoute()
                                preferHeadset(current, available)
                            }
                    }
                    // Keep the call scope open until we disconnect.
                    launch { awaitCancellation() }
                }
            } catch (e: Exception) {
                Log.w(TAG, "addCall failed", e)
                added.complete(false)
            } finally {
                control = null
            }
        }
        val ok = withTimeoutOrNull(ADD_CALL_TIMEOUT_MS) { added.await() } ?: false
        if (!ok) stop()
        return ok
    }

    /** Bluetooth > wired > speaker. Earpiece is useless in a pocket with no headset. */
    private suspend fun CallControlScope.preferHeadset(current: CallEndpointCompat, available: List<CallEndpointCompat>) {
        val order = listOf(
            CallEndpointCompat.TYPE_BLUETOOTH,
            CallEndpointCompat.TYPE_WIRED_HEADSET,
            CallEndpointCompat.TYPE_SPEAKER,
        )
        val best = order.firstNotNullOfOrNull { t -> available.firstOrNull { it.type == t } } ?: return
        if (best.type != current.type && order.indexOf(best.type) < order.indexOf(current.type).let { if (it < 0) Int.MAX_VALUE else it }) {
            val r = requestEndpointChange(best)
            if (r is CallControlResult.Error) Log.w(TAG, "endpoint change failed: ${r.errorCode}")
        }
    }

    /** Hold/resume from our side is not needed; leave ends the call. */
    fun stop() {
        val c = control
        control = null
        val job = callJob
        callJob = null
        if (c != null) {
            scope.launch {
                runCatching { c.disconnect(android.telecom.DisconnectCause(android.telecom.DisconnectCause.LOCAL)) }
                job?.cancel()
            }
        } else {
            job?.cancel()
        }
    }

    private fun CallEndpointCompat.toRoute(): OutputRoute = when (type) {
        CallEndpointCompat.TYPE_BLUETOOTH -> OutputRoute.BLUETOOTH
        CallEndpointCompat.TYPE_WIRED_HEADSET -> OutputRoute.HEADSET
        CallEndpointCompat.TYPE_EARPIECE -> OutputRoute.EARPIECE
        else -> OutputRoute.SPEAKER
    }

    companion object {
        private const val TAG = "TelecomController"
        private const val ADD_CALL_TIMEOUT_MS = 6_000L
    }
}
