package app.sentinel.core

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

// Mirrors Sentinel's JSON API (sentinel/frontend/src/lib/api.ts).

@Serializable
data class StreamInfo(
    @SerialName("video_codec") val videoCodec: String = "",
    val width: Int = 0,
    val height: Int = 0,
    val fps: Double = 0.0,
    @SerialName("audio_codec") val audioCodec: String = "",
)

@Serializable
data class RecStatus(
    val state: String = "starting",
    val since: Long = 0,
    @SerialName("last_error") val lastError: String? = null,
    @SerialName("restarts_24h") val restarts24h: Int = 0,
    @SerialName("bitrate_kbps") val bitrateKbps: Double = 0.0,
    @SerialName("last_write") val lastWrite: Long = 0,
    val audio: Boolean = false,
    val stream: StreamInfo = StreamInfo(),
)

@Serializable
data class MotionStatus(val state: String = "", val active: Boolean = false, val score: Double = 0.0, val error: String? = null)

@Serializable
data class Box(val x: Double = 0.0, val y: Double = 0.0, val w: Double = 0.0, val h: Double = 0.0)

/** Someone or something seen in an event: "person", "cat" or "dog". */
@Serializable
data class DetectedObject(val label: String, val score: Double = 0.0, val box: Box = Box(), val t: Long = 0)

@Serializable
data class SentinelEvent(
    val id: String,
    val camera: String,
    val start: Long,
    val end: Long,
    val peak: Double = 0.0,
    val thumb: Boolean = false,
    /** Who was seen, people first; empty with [scan] "done" = plain motion. */
    val labels: List<String> = emptyList(),
    val objects: List<DetectedObject> = emptyList(),
    /** "" not checked yet, "scanning", "done", or "none" (couldn't be checked). */
    val scan: String = "",
    /** A picture of who was seen (snap.jpg). */
    val snap: Boolean = false,
    /** Who the people were, when recognised (by face, or the same day by their clothes). */
    val who: List<Who> = emptyList(),
) {
    /** Motion still going on (Sentinel sends end = 0). */
    val ongoing: Boolean get() = end == 0L
    fun endOr(now: Long): Long = if (ongoing) now else end
    val checked: Boolean get() = scan == "done" || scan == "none"
    fun has(label: String) = label in labels
    /** The moment worth jumping to: where someone was seen, else the start. */
    val bestTime: Long get() = objects.firstOrNull()?.t ?: start
}

@Serializable
data class DetectionStatus(
    val enabled: Boolean = false,
    val error: String? = null,
    val backlog: Int = 0,
    val scanned: Int = 0,
    val found: Int = 0,
    @SerialName("avg_ms") val avgMs: Long = 0,
)

@Serializable
data class SearchQuery(
    val labels: List<String>? = null,
    val motion: Boolean = false,
    val cameras: List<String>? = null,
    val from: Long = 0,
    val to: Long = 0,
    val chips: List<String> = emptyList(),
)

@Serializable
data class SearchResult(val query: SearchQuery = SearchQuery(), val events: List<SentinelEvent> = emptyList())

@Serializable
data class CamDay(
    val id: String,
    val name: String,
    val counts: Map<String, Int> = emptyMap(),
    val recorded: Double = 0.0,
    val missing: Long = 0,
    @SerialName("first_person") val firstPerson: Long = 0,
    @SerialName("last_person") val lastPerson: Long = 0,
)

@Serializable
data class DaySummary(
    val date: String = "",
    val from: Long = 0,
    val to: Long = 0,
    val totals: Map<String, Int> = emptyMap(),
    val cameras: List<CamDay> = emptyList(),
    /** Per hour: motion, person, cat, dog. */
    val hours: List<List<Int>> = emptyList(),
    val highlights: List<SentinelEvent> = emptyList(),
    val pending: Int = 0,
    val problems: Int = 0,
    val text: String = "",
)

@Serializable
data class CamStorage(
    val bytes: Long = 0,
    val count: Int = 0,
    val oldest: Long = 0,
    val newest: Long = 0,
    @SerialName("rate_bph") val rateBph: Long = 0,
    @SerialName("uptime_24h") val uptime24h: Double = 0.0,
)

@Serializable
data class CameraStatus(
    val id: String,
    val name: String,
    val enabled: Boolean = true,
    val record: Boolean = true,
    val audio: Boolean = true,
    val occasional: Boolean = false,
    @SerialName("retain_days") val retainDays: Double = 0.0,
    @SerialName("motion_retain_days") val motionRetainDays: Double = 0.0,
    val recorder: RecStatus? = null,
    val motion: MotionStatus? = null,
    val storage: CamStorage = CamStorage(),
    @SerialName("last_event") val lastEvent: SentinelEvent? = null,
) {
    /** Recording state the way the web UI shows it. */
    val state: String
        get() = when {
            !enabled -> "disabled"
            !record -> "not-recording"
            else -> recorder?.state ?: "starting"
        }
    val aspect: Float
        get() = recorder?.stream?.let { if (it.width > 0 && it.height > 0) it.width.toFloat() / it.height else null } ?: (16f / 9f)
    val hasAudio: Boolean get() = audio && (recorder?.stream?.audioCodec?.isNotEmpty() == true)
}

@Serializable
data class Disk(val total: Long = 0, val free: Long = 0, val used: Long = 0)

@Serializable
data class StorageStatus(
    val disk: Disk = Disk(),
    val used: Long = 0,
    @SerialName("rate_bph") val rateBph: Long = 0,
    @SerialName("capacity_days") val capacityDays: Double = 0.0,
    @SerialName("min_free_gb") val minFreeGb: Double = 0.0,
    val clips: Long = 0,
)

@Serializable
data class ClockStatus(
    val synced: Boolean = true,
    @SerialName("offset_ms") val offsetMs: Long = 0,
    val server: String = "",
    val error: String? = null,
    val jumps: Int = 0,
)

@Serializable
data class OnOff(val enabled: Boolean = false, val active: Boolean = false, val connected: Boolean = false, val mode: String = "", val error: String = "")

@Serializable
data class Status(
    val version: String = "",
    @SerialName("uptime_ms") val uptimeMs: Long = 0,
    val now: Long = 0,
    val cameras: List<CameraStatus> = emptyList(),
    val storage: StorageStatus = StorageStatus(),
    val clock: ClockStatus = ClockStatus(),
    val live: Boolean = true,
    val alerts: OnOff = OnOff(),
    val drive: OnOff = OnOff(),
    val mqtt: OnOff = OnOff(),
    val health: Boolean = true,
    val detection: DetectionStatus? = null,
)

@Serializable
data class Span(val s: Long, val e: Long)

@Serializable
data class ClipBackup(val state: String = "", val progress: Double = 0.0, val error: String? = null)

@Serializable
data class Clip(
    val id: String,
    val name: String,
    val camera: String,
    @SerialName("camera_name") val cameraName: String = "",
    val from: Long,
    val to: Long,
    val created: Long = 0,
    val status: String = "ready",
    val progress: Double = 0.0,
    val error: String? = null,
    val size: Long = 0,
    val pinned: Boolean = false,
    val alert: Boolean = false,
    val backup: ClipBackup? = null,
)

@Serializable
data class Incident(val t: Long, val level: String, val camera: String? = null, val message: String)

@Serializable
data class AlertRecord(
    val id: String,
    val camera: String,
    @SerialName("camera_name") val cameraName: String = "",
    val at: Long,
    val status: String,
    val error: String? = null,
)

@Serializable
data class AppUser(
    val id: String,
    val username: String,
    val name: String = "",
    val admin: Boolean = false,
    val cameras: List<String> = emptyList(),
    val disabled: Boolean = false,
    val created: Long = 0,
    @SerialName("last_login") val lastLogin: Long = 0,
) {
    val display: String get() = name.ifBlank { username }
}

@Serializable
data class AppSession(
    val id: String,
    @SerialName("user_id") val userId: String,
    val username: String = "",
    val device: String = "",
    val created: Long = 0,
    @SerialName("last_seen") val lastSeen: Long = 0,
    val addr: String = "",
    val via: String = "",
    val push: Boolean = false,
)

@Serializable
data class ServerInfo(val id: String = "", val name: String = "Sentinel", val version: String = "")

@Serializable
data class LoginResponse(val token: String, val user: AppUser, val server: ServerInfo)

@Serializable
data class MeResponse(val user: AppUser, val server: ServerInfo, val push: FirebaseClient? = null, val prefs: PushPrefs = PushPrefs())

@Serializable
data class PushReply(val prefs: PushPrefs = PushPrefs())

@Serializable
data class Found(val id: String, val name: String = "Sentinel", val version: String = "", val addr: String = "")

@Serializable
data class TunnelState(
    val state: String = "idle",
    val path: String? = null,
    val addr: String? = null,
    @SerialName("rtt_ms") val rttMs: Long = 0,
    val error: String? = null,
    val since: Long = 0,
)

@Serializable
data class UserInput(
    val username: String? = null,
    val name: String? = null,
    val password: String? = null,
    val admin: Boolean? = null,
    val cameras: List<String>? = null,
    val disabled: Boolean? = null,
)

/** A recognised person in an event: by "face", or the same day by "clothing". */
@Serializable
data class Who(val person: String, val name: String, val by: String = "face")

@Serializable
data class LastSeen(val cam: String, val event: String, val t: Long)

@Serializable
data class PersonInfo(
    val id: String,
    val name: String,
    val created: Long = 0,
    val faces: Int = 0,
    val sightings: Int = 0,
    val last: LastSeen? = null,
    val cover: String? = null,
)

@Serializable
data class FaceStatus(val enabled: Boolean = false, val error: String? = null, val backlog: Int = 0, val done: Int = 0, val faces: Int = 0)

@Serializable
data class PeopleResponse(val people: List<PersonInfo> = emptyList(), val status: FaceStatus = FaceStatus())

@Serializable
data class FaceInfo(
    val id: String,
    val cam: String,
    val event: String,
    val t: Long,
    val q: Double = 0.0,
    val by: String? = null,
    val sim: Double = 0.0,
    val person: String? = null,
)

@Serializable
data class Suggestion(val person: String, val name: String)

@Serializable
data class FaceGroup(val faces: List<FaceInfo> = emptyList(), val size: Int = 0, val ids: List<String> = emptyList(), val suggest: Suggestion? = null)

@Serializable
data class NameFaces(val faces: List<String>, val person: String? = null, val name: String? = null)

@Serializable
data class NotPerson(val faces: List<String>, val person: String)

@Serializable
data class FaceIds(val faces: List<String>)
