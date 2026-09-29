package app.sentinel.core

import java.io.IOException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

class ApiException(message: String, val code: Int = 0, val offline: Boolean = false) : IOException(message)

/** Sentinel's API, through the engine's local proxy. */
class Api(private val engine: Engine) {
    private val jsonType = "application/json".toMediaType()

    /** Fires when Sentinel says the login is no longer valid (signed out elsewhere). */
    val unauthorized = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
    val onUnauthorized: SharedFlow<Unit> get() = unauthorized

    private suspend fun call(method: String, path: String, body: String? = null): String = withContext(Dispatchers.IO) {
        val req = Request.Builder().url(engine.url(path))
            .method(method, body?.toRequestBody(jsonType) ?: if (method == "GET" || method == "HEAD") null else "".toRequestBody(jsonType))
            .build()
        val resp = try {
            engine.http.newCall(req).execute()
        } catch (e: IOException) {
            throw ApiException("Can't reach Sentinel", offline = true)
        }
        resp.use {
            val text = it.body?.string() ?: ""
            if (!it.isSuccessful) {
                val obj = runCatching { Engine.json.decodeFromString<JsonObject>(text) }.getOrNull()
                val msg = obj?.get("error")?.jsonPrimitive?.content ?: "HTTP ${it.code}"
                val offline = obj?.get("offline") != null
                if (it.code == 401 && path != "app/login") unauthorized.tryEmit(Unit)
                throw ApiException(msg, it.code, offline)
            }
            text
        }
    }

    private suspend inline fun <reified T> get(path: String): T = Engine.json.decodeFromString(call("GET", path))

    private suspend inline fun <reified T, reified B> send(method: String, path: String, body: B): T =
        Engine.json.decodeFromString(call(method, path, Engine.json.encodeToString(body)))

    // Account
    suspend fun hello(): ServerInfo = get("app/hello")

    suspend fun login(username: String, password: String, device: String): LoginResponse =
        send("POST", "app/login", mapOf("username" to username, "password" to password, "device" to device))

    suspend fun me(): MeResponse = get("app/me")
    suspend fun logout() = runCatching { call("POST", "app/logout") }
    suspend fun setPush(token: String?, prefs: PushPrefs?): PushPrefs {
        val body = buildString {
            append("{")
            if (token != null) append("\"token\":").append(Engine.json.encodeToString(token))
            if (prefs != null) { if (token != null) append(","); append("\"prefs\":").append(Engine.json.encodeToString(prefs)) }
            append("}")
        }
        return Engine.json.decodeFromString<PushReply>(call("POST", "app/push", body)).prefs
    }
    suspend fun testPush(): Int = Engine.json.decodeFromString<Map<String, Int>>(call("POST", "app/push/test"))["sent"] ?: 0

    // Sentinel
    suspend fun status(): Status = get("api/status")
    suspend fun coverage(cam: String, from: Long, to: Long): List<Span> = get("api/recordings/$cam?from=$from&to=$to")
    suspend fun events(cameras: List<String> = emptyList(), from: Long? = null, to: Long? = null, limit: Int = 500, labels: List<String> = emptyList()): List<SentinelEvent> {
        val q = buildList {
            if (cameras.isNotEmpty()) add("cameras=${cameras.joinToString(",")}")
            if (labels.isNotEmpty()) add("labels=${labels.joinToString(",")}")
            if (from != null) add("from=$from")
            if (to != null) add("to=$to")
            add("limit=$limit")
        }.joinToString("&")
        return get("api/events?$q")
    }

    /** Plain questions: "person on the roof last night", "cats yesterday after 10pm". */
    suspend fun search(q: String, limit: Int = 500): SearchResult = get("api/search?q=${java.net.URLEncoder.encode(q, "UTF-8")}&limit=$limit")
    suspend fun summary(date: String? = null): DaySummary = get("api/summary" + (date?.let { "?date=$it" } ?: ""))
    /** "That's not a person": removes the label, and the camera learns the spot (admins). */
    suspend fun wrongLabel(e: SentinelEvent, label: String): SentinelEvent =
        Engine.json.decodeFromString(call("POST", "api/events/${e.camera}/${e.id}/wrong", """{"label":"$label"}"""))

    suspend fun clips(): List<Clip> = get("api/clips")
    suspend fun createClip(camera: String, from: Long, to: Long, name: String): Clip =
        Engine.json.decodeFromString(call("POST", "api/clips", """{"camera":${Engine.json.encodeToString(camera)},"from":$from,"to":$to,"name":${Engine.json.encodeToString(name)}}"""))

    suspend fun renameClip(id: String, name: String): Clip = send("PATCH", "api/clips/$id", mapOf("name" to name))
    suspend fun pinClip(id: String, pinned: Boolean): Clip = Engine.json.decodeFromString(call("PATCH", "api/clips/$id", """{"pinned":$pinned}"""))
    suspend fun deleteClip(id: String) = call("DELETE", "api/clips/$id")
    suspend fun backupClip(id: String) = call("POST", "api/clips/$id/backup")

    suspend fun incidents(limit: Int = 300): List<Incident> = get("api/incidents?limit=$limit")
    suspend fun alerts(): List<AlertRecord> = get("api/alerts")
    suspend fun restartCamera(id: String) = call("POST", "api/cameras/$id/restart")

    // Users (admins)
    suspend fun users(): List<AppUser> = get("app/users")
    suspend fun createUser(u: UserInput): AppUser = send("POST", "app/users", u)
    suspend fun updateUser(id: String, u: UserInput): AppUser = send("PATCH", "app/users/$id", u)
    suspend fun deleteUser(id: String) = call("DELETE", "app/users/$id")
    suspend fun sessions(): List<AppSession> = get("app/sessions")
    suspend fun deleteSession(id: String) = call("DELETE", "app/sessions/$id")

    // URLs for the player and image loader
    fun snapshotUrl(cam: String, hq: Boolean = false, bust: Long = 0) = engine.url("api/cameras/$cam/snapshot.jpg?${if (hq) "hq=1&" else ""}t=$bust")
    fun latestUrl(cam: String) = engine.url("api/cameras/$cam/latest.jpg")
    fun thumbUrl(e: SentinelEvent, small: Boolean = false) = if (e.thumb) engine.url("api/events/${e.camera}/${e.id}/thumb.jpg${if (small) "?small=1" else ""}") else previewUrl(e.camera, e.start + 1000)
    fun snapUrl(e: SentinelEvent, small: Boolean = false) = engine.url("api/events/${e.camera}/${e.id}/snap.jpg${if (small) "?small=1" else ""}")
    /**
     * The best picture of an event: who was seen, else the moment motion started. small:
     * a 480 px copy for lists (a fifth of the bytes, which matters on mobile data).
     */
    fun pictureUrl(e: SentinelEvent, small: Boolean = true) = if (e.snap) snapUrl(e, small) else thumbUrl(e, small)
    /** Preview frames are cached per 2 s, so scrubbing reuses them. */
    fun previewUrl(cam: String, t: Long) = engine.url("api/preview/$cam/${t / 2000 * 2000}.jpg")
    fun vodUrl(cam: String, from: Long, to: Long) = engine.url("api/vod.m3u8?camera=$cam&from=$from&to=$to")
    /** Live video as fragmented MP4. FLAC audio comes straight from go2rtc (no ffmpeg), which starts faster. */
    fun liveUrl(cam: String, hq: Boolean) = engine.url("go2rtc/api/stream.mp4?src=${if (hq) cam else "${cam}_sub"}&mp4=flac")
    fun clipVideoUrl(id: String) = engine.url("api/clips/$id/video")
    fun clipThumbUrl(c: Clip) = engine.url("api/clips/${c.id}/thumb.jpg?v=${c.status}")
}
