package com.partyline.store

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import androidx.core.content.edit
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.partyline.model.TalkMode
import java.util.UUID

/** Where the saved server lives. [host] is an IP or hostname, never a URL. */
data class SavedServer(val serverId: String, val name: String, val host: String, val port: Int)

/**
 * Keystore-backed EncryptedSharedPreferences: device id, device token, the saved server and
 * the pinned certificate fingerprint per server id (TOFU), plus a few user preferences.
 */
class SecureStore(context: Context) {

    private val prefs: SharedPreferences = open(context)

    val deviceId: String
        get() = prefs.getString(K_DEVICE_ID, null) ?: UUID.randomUUID().toString().also {
            prefs.edit(commit = true) { putString(K_DEVICE_ID, it) }
        }

    var deviceToken: String?
        get() = prefs.getString(K_TOKEN, null)
        set(v) = prefs.edit(commit = true) { if (v == null) remove(K_TOKEN) else putString(K_TOKEN, v) }

    var server: SavedServer?
        get() {
            val id = prefs.getString(K_SRV_ID, null) ?: return null
            val host = prefs.getString(K_SRV_HOST, null) ?: return null
            return SavedServer(id, prefs.getString(K_SRV_NAME, "") ?: "", host, prefs.getInt(K_SRV_PORT, 8443))
        }
        set(v) = prefs.edit(commit = true) {
            if (v == null) {
                remove(K_SRV_ID); remove(K_SRV_HOST); remove(K_SRV_NAME); remove(K_SRV_PORT)
            } else {
                putString(K_SRV_ID, v.serverId); putString(K_SRV_HOST, v.host)
                putString(K_SRV_NAME, v.name); putInt(K_SRV_PORT, v.port)
            }
        }

    fun pinnedFingerprint(serverId: String): String? = prefs.getString(K_PIN + serverId, null)

    fun pin(serverId: String, fingerprint: String) =
        prefs.edit(commit = true) { putString(K_PIN + serverId, fingerprint.lowercase()) }

    var displayName: String
        get() = prefs.getString(K_NAME, "") ?: ""
        set(v) = prefs.edit { putString(K_NAME, v) }

    var talkMode: TalkMode?
        get() = prefs.getString(K_TALK_MODE, null)?.let { if (it == "latch") TalkMode.LATCH else TalkMode.PTT }
        set(v) = prefs.edit { if (v == null) remove(K_TALK_MODE) else putString(K_TALK_MODE, v.wire) }

    var autoJoin: Boolean
        get() = prefs.getBoolean(K_AUTO_JOIN, true)
        set(v) = prefs.edit { putBoolean(K_AUTO_JOIN, v) }

    var textToSpeech: Boolean
        get() = prefs.getBoolean(K_TTS, false)
        set(v) = prefs.edit { putBoolean(K_TTS, v) }

    /** Voice isolation on the mic; on by default, remembered per device. */
    var voiceIsolation: Boolean
        get() = prefs.getBoolean(K_VOICE_ISOLATION, true)
        set(v) = prefs.edit { putBoolean(K_VOICE_ISOLATION, v) }

    var batteryPromptShown: Boolean
        get() = prefs.getBoolean(K_BATTERY_PROMPT, false)
        set(v) = prefs.edit { putBoolean(K_BATTERY_PROMPT, v) }

    /** True while a session is live; still true on next launch means the process was killed. */
    var sessionActive: Boolean
        get() = prefs.getBoolean(K_SESSION_ACTIVE, false)
        set(v) = prefs.edit(commit = true) { putBoolean(K_SESSION_ACTIVE, v) }

    /** Clears credentials after `kicked` / `revoked`; keeps device id, name and pins. */
    fun forgetSession() {
        deviceToken = null
        sessionActive = false
    }

    private companion object {
        const val TAG = "SecureStore"
        const val K_DEVICE_ID = "deviceId"
        const val K_TOKEN = "deviceToken"
        const val K_SRV_ID = "server.id"
        const val K_SRV_HOST = "server.host"
        const val K_SRV_NAME = "server.name"
        const val K_SRV_PORT = "server.port"
        const val K_PIN = "pin."
        const val K_NAME = "displayName"
        const val K_TALK_MODE = "talkMode"
        const val K_AUTO_JOIN = "autoJoin"
        const val K_TTS = "tts"
        const val K_VOICE_ISOLATION = "voiceIsolation"
        const val K_BATTERY_PROMPT = "batteryPromptShown"
        const val K_SESSION_ACTIVE = "sessionActive"

        @Suppress("DEPRECATION")
        fun open(context: Context): SharedPreferences = try {
            val key = MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build()
            EncryptedSharedPreferences.create(
                context, "partyline_secure", key,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
            )
        } catch (e: Exception) {
            // Broken keystore on some devices (or restored backup with a lost key). Losing the
            // token only costs a re-join with a code, so fall back rather than crash.
            Log.e(TAG, "Encrypted prefs unavailable, falling back", e)
            context.getSharedPreferences("partyline_fallback", Context.MODE_PRIVATE)
        }
    }
}
