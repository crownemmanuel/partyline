package com.partyline.model

import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.serializer
import java.time.Instant

/** Every server → client message from PROTOCOL §3.3, decoded. */
sealed interface ServerEvent {
    data class WelcomeEvent(val welcome: Welcome) : ServerEvent
    data class Ack(val replyTo: String) : ServerEvent
    data class Error(val replyTo: String?, val code: String, val message: String) : ServerEvent
    data object Pong : ServerEvent
    data class DeviceUpsert(val device: Device) : ServerEvent
    data class DeviceRemovedEvent(val deviceId: String) : ServerEvent
    data class GroupsUpdatedEvent(val groups: List<Group>) : ServerEvent
    data class ServerUpdated(val server: ServerInfo) : ServerEvent
    data class SettingsUpdated(val settings: Settings) : ServerEvent
    data class MessageEvent(val message: Message) : ServerEvent
    data class MessageAckedEvent(val acked: MessageAcked) : ServerEvent
    data class Signal(val from: String, val to: String) : ServerEvent
    data class TokenRefreshedEvent(val livekitToken: String) : ServerEvent
    data class AdminNoticeEvent(val notice: AdminNotice) : ServerEvent
    data class KickedEvent(val reason: String) : ServerEvent
    data class ShutdownEvent(val reconnectAfterMs: Long) : ServerEvent
    data class Unknown(val type: String) : ServerEvent
}

object ProtocolCodec {

    /** Decodes one WebSocket text frame. Throws on malformed JSON or a malformed known payload. */
    fun decode(text: String): ServerEvent {
        val env = ProtocolJson.decodeFromString(Envelope.serializer(), text)
        val p = env.payload
        return when (env.type) {
            "welcome" -> ServerEvent.WelcomeEvent(p.decode())
            "ack" -> ServerEvent.Ack(p.decode<AckPayload>().replyTo)
            "error" -> p.decode<ErrorPayload>().let { ServerEvent.Error(it.replyTo, it.code, it.message) }
            "pong" -> ServerEvent.Pong
            "device.upsert" -> ServerEvent.DeviceUpsert(p.decode())
            "device.removed" -> ServerEvent.DeviceRemovedEvent(p.decode<DeviceRemoved>().deviceId)
            "groups.updated" -> ServerEvent.GroupsUpdatedEvent(p.decode<GroupsUpdated>().groups)
            "server.updated" -> ServerEvent.ServerUpdated(p.decode())
            "settings.updated" -> ServerEvent.SettingsUpdated(p.decode())
            "message" -> ServerEvent.MessageEvent(p.decode())
            "message.acked" -> ServerEvent.MessageAckedEvent(p.decode())
            "signal" -> p.decode<SignalPayload>().let { ServerEvent.Signal(it.from, it.to) }
            "token.refreshed" -> ServerEvent.TokenRefreshedEvent(p.decode<TokenRefreshed>().livekitToken)
            "admin.notice" -> ServerEvent.AdminNoticeEvent(p.decode())
            "kicked" -> ServerEvent.KickedEvent(p.decode<Kicked>().reason)
            "server.shutdown" -> ServerEvent.ShutdownEvent(p.decode<ServerShutdown>().reconnectAfterMs)
            else -> ServerEvent.Unknown(env.type)
        }
    }

    fun <T> encode(type: String, serializer: KSerializer<T>, payload: T, id: String? = null): String {
        val element = ProtocolJson.encodeToJsonElement(serializer, payload)
        return ProtocolJson.encodeToString(
            Envelope.serializer(),
            Envelope(type = type, id = id, ts = Instant.now().toString(), payload = element),
        )
    }

    inline fun <reified T> encode(type: String, payload: T, id: String? = null): String =
        encode(type, serializer<T>(), payload, id)

    fun encodeEmpty(type: String, id: String? = null): String = ProtocolJson.encodeToString(
        Envelope.serializer(),
        Envelope(type = type, id = id, ts = Instant.now().toString(), payload = JsonObject(emptyMap())),
    )

    private inline fun <reified T> JsonElement.decode(): T = ProtocolJson.decodeFromJsonElement(serializer<T>(), this)
}
