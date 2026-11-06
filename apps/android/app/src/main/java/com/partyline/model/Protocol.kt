package com.partyline.model

import kotlinx.serialization.EncodeDefault
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/** PROTOCOL.md v1 objects (§3.4) and REST bodies (§2). Field names match the wire exactly. */

const val API_VERSION = 1

val ProtocolJson = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
    encodeDefaults = false
    coerceInputValues = true
    isLenient = true
}

@Serializable
enum class TalkMode {
    @SerialName("ptt") PTT,
    @SerialName("latch") LATCH;

    val wire: String get() = if (this == PTT) "ptt" else "latch"
}

@Serializable
data class Group(
    val id: String,
    val name: String,
    val color: String = "#888888",
    val sortOrder: Int = 0,
    val defaultTalkMode: TalkMode? = null,
)

@Serializable
data class LiveState(
    val online: Boolean = false,
    val rtcConnected: Boolean = false,
    val micLive: Boolean = false,
    val speakerMuted: Boolean = false,
    val talkMode: TalkMode = TalkMode.PTT,
    val talkTargets: List<String> = emptyList(),
    val speaking: Boolean = false,
    val battery: Int? = null,
    val charging: Boolean? = null,
    val headset: Boolean? = null,
    val outputRoute: String? = null,
    val rttMs: Double? = null,
)

@Serializable
data class Device(
    val id: String,
    val displayName: String = "",
    val platform: String = "",
    val appVersion: String = "",
    val groupId: String = "",
    val listenGroupIds: List<String> = emptyList(),
    val canTalkGroupIds: List<String> = emptyList(),
    val isAdmin: Boolean = false,
    val forcedTalkMode: TalkMode? = null,
    val adminMuted: Boolean = false,
    val createdAt: String? = null,
    val lastSeenAt: String? = null,
    val live: LiveState = LiveState(),
)

@Serializable
data class ServerInfo(
    val serverId: String,
    val name: String = "",
    val appVersion: String = "",
    val apiVersion: Int = API_VERSION,
    val joinCode: String? = null,
    val joinOpen: Boolean = true,
    val fingerprint: String = "",
    val failedJoinAttempts: Int = 0,
)

@Serializable
data class Settings(
    val crewCanBroadcast: Boolean = false,
    val defaultTalkMode: TalkMode = TalkMode.PTT,
    val quickReplies: List<String> = listOf("OK", "Standby", "Go", "Problem", "Can't hear"),
    /** Referenced by the routing algorithm in §5.1; not in the Settings type yet, default false. */
    val adminsHearEverything: Boolean = false,
)

@Serializable
data class Message(
    val id: String,
    val from: String,
    val to: String,
    val kind: String = "text",
    val text: String = "",
    val ts: String = "",
    val ackedBy: List<String>? = null,
)

// ---- REST (§2) ----

@Serializable
data class InfoResponse(
    val apiVersion: Int = API_VERSION,
    val serverId: String,
    val name: String = "",
    val appVersion: String = "",
    val fingerprint: String = "",
    val joinOpen: Boolean = true,
    val livekitUrl: String = "/rtc",
    val minClientVersion: String? = null,
)

@OptIn(ExperimentalSerializationApi::class)
@Serializable
data class JoinRequest(
    val joinCode: String,
    val deviceId: String,
    val displayName: String,
    @EncodeDefault val platform: String = "android",
    val appVersion: String,
    @EncodeDefault val apiVersion: Int = API_VERSION,
)

@OptIn(ExperimentalSerializationApi::class)
@Serializable
data class SessionRequest(val appVersion: String, @EncodeDefault val apiVersion: Int = API_VERSION)

/** Response of both /api/join (with deviceToken) and /api/session (without). */
@Serializable
data class SessionResponse(
    val deviceToken: String? = null,
    val livekitToken: String,
    val livekitUrl: String = "/rtc",
    val roomName: String = "partyline",
    val me: Device,
    val groups: List<Group> = emptyList(),
)

@Serializable
data class ApiErrorBody(val error: ApiErrorDetail)

@Serializable
data class ApiErrorDetail(val code: String, val message: String = "")

// ---- WebSocket (§3) ----

@OptIn(ExperimentalSerializationApi::class)
@Serializable
data class Envelope(
    val type: String,
    val id: String? = null,
    val ts: String? = null,
    @EncodeDefault val payload: JsonElement = JsonObject(emptyMap()),
)

@Serializable
data class Welcome(
    val me: Device,
    val devices: List<Device> = emptyList(),
    val groups: List<Group> = emptyList(),
    val server: ServerInfo? = null,
    val settings: Settings = Settings(),
    val livekitToken: String? = null,
    val roomName: String = "partyline",
    val messages: List<Message> = emptyList(),
)

@Serializable data class AckPayload(val replyTo: String)
@Serializable data class ErrorPayload(val replyTo: String? = null, val code: String = "", val message: String = "")
@Serializable data class DeviceRemoved(val deviceId: String)
@Serializable data class GroupsUpdated(val groups: List<Group>)
@Serializable data class MessageAcked(val messageId: String, val deviceId: String, val ts: String? = null)
@Serializable data class SignalPayload(val from: String, val to: String)
@Serializable data class TokenRefreshed(val livekitToken: String)
@Serializable data class AdminNotice(val kind: String, val text: String = "")
@Serializable data class Kicked(val reason: String = "")
@Serializable data class ServerShutdown(val reconnectAfterMs: Long = 3000)

// Client → server payloads (§3.1)

@Serializable data class AuthPayload(val deviceToken: String, val appVersion: String)

@Serializable
data class StateSet(
    val talkTargets: List<String>? = null,
    val listenGroupIds: List<String>? = null,
    val micLive: Boolean? = null,
    val speakerMuted: Boolean? = null,
    val talkMode: TalkMode? = null,
)

@Serializable
data class StatusPayload(
    val rtcConnected: Boolean,
    val speaking: Boolean,
    val battery: Int? = null,
    val charging: Boolean? = null,
    val headset: Boolean? = null,
    val rttMs: Int? = null,
    val outputRoute: String? = null,
)

@OptIn(ExperimentalSerializationApi::class)
@Serializable data class MessageSend(val to: String, val text: String, @EncodeDefault val kind: String = "text")
@Serializable data class MessageAck(val messageId: String)
@Serializable data class SignalSend(val to: String)

object Targets {
    const val ALL = "all"
    fun group(id: String) = "g:$id"
    fun device(id: String) = "d:$id"
    fun groupId(ref: String): String? = if (ref.startsWith("g:")) ref.substring(2) else null
    fun deviceId(ref: String): String? = if (ref.startsWith("d:")) ref.substring(2) else null
}
