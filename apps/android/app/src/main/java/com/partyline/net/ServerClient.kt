package com.partyline.net

import com.partyline.model.ApiErrorBody
import com.partyline.model.InfoResponse
import com.partyline.model.JoinRequest
import com.partyline.model.Message
import com.partyline.model.ProtocolJson
import com.partyline.model.SessionRequest
import com.partyline.model.SessionResponse
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.KSerializer
import kotlinx.serialization.builtins.ListSerializer
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** A REST error from §2: `{"error":{"code","message"}}` plus the HTTP status. */
class ApiException(val status: Int, val code: String, override val message: String, val retryAfterSec: Long? = null) :
    IOException("$status $code: $message")

/** Address of a server; [host] may be an IPv4/IPv6 literal or a name. */
data class Endpoint(val host: String, val port: Int = 8443) {
    fun httpUrl(path: String): HttpUrl = HttpUrl.Builder().scheme("https").host(host).port(port)
        .encodedPath(if (path.startsWith("/")) path else "/$path").build()

    /** Base URL handed to LiveKit, which appends `/rtc` itself. */
    fun livekitUrl(livekitPath: String): String {
        if (livekitPath.startsWith("ws://") || livekitPath.startsWith("wss://")) return livekitPath.removeSuffix("/rtc")
        val h = if (host.contains(':')) "[$host]" else host
        return "wss://$h:$port" + livekitPath.removeSuffix("/").removeSuffix("/rtc")
    }

    fun wsUrl(): String = httpUrl("/api/ws").toString().replaceFirst("https://", "wss://")
}

class ServerClient(val endpoint: Endpoint, val http: OkHttpClient) {

    suspend fun info(): InfoResponse = execute(get("/api/info"), InfoResponse.serializer())

    suspend fun join(req: JoinRequest): SessionResponse =
        execute(post("/api/join", ProtocolJson.encodeToString(JoinRequest.serializer(), req)), SessionResponse.serializer())

    suspend fun session(deviceToken: String, req: SessionRequest): SessionResponse = execute(
        post("/api/session", ProtocolJson.encodeToString(SessionRequest.serializer(), req), deviceToken),
        SessionResponse.serializer(),
    )

    suspend fun messages(deviceToken: String, since: String?, limit: Int = 100): List<Message> {
        val url = endpoint.httpUrl("/api/messages").newBuilder()
            .apply { if (since != null) addQueryParameter("since", since) }
            .addQueryParameter("limit", limit.toString()).build()
        val req = Request.Builder().url(url).header("Authorization", "Bearer $deviceToken").get().build()
        return execute(req, ListSerializer(Message.serializer()))
    }

    private fun get(path: String) = Request.Builder().url(endpoint.httpUrl(path)).get().build()

    private fun post(path: String, json: String, token: String? = null) = Request.Builder()
        .url(endpoint.httpUrl(path))
        .post(json.toRequestBody(JSON))
        .apply { if (token != null) header("Authorization", "Bearer $token") }
        .build()

    private suspend fun <T> execute(request: Request, serializer: KSerializer<T>): T {
        val response = http.newCall(request).await()
        response.use { r ->
            val body = r.body?.string().orEmpty()
            if (!r.isSuccessful) throw parseError(r, body)
            return ProtocolJson.decodeFromString(serializer, body)
        }
    }

    private fun parseError(r: Response, body: String): ApiException {
        val detail = runCatching { ProtocolJson.decodeFromString(ApiErrorBody.serializer(), body).error }.getOrNull()
        return ApiException(
            status = r.code,
            code = detail?.code ?: "http_${r.code}",
            message = detail?.message ?: r.message,
            retryAfterSec = r.header("Retry-After")?.toLongOrNull(),
        )
    }

    companion object {
        private val JSON = "application/json; charset=utf-8".toMediaType()
    }
}

suspend fun Call.await(): Response = suspendCancellableCoroutine { cont ->
    enqueue(object : Callback {
        override fun onFailure(call: Call, e: IOException) { if (cont.isActive) cont.resumeWithException(e) }
        override fun onResponse(call: Call, response: Response) { cont.resume(response) }
    })
    cont.invokeOnCancellation { runCatching { cancel() } }
}
