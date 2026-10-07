package app.sentinel.core

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.IntentCompat
import androidx.core.content.pm.PackageInfoCompat
import app.sentinel.BuildConfig
import app.sentinel.MainActivity
import app.sentinel.R
import app.sentinel.SentinelApp
import app.sentinel.ui.components.Toaster
import java.io.File
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import okhttp3.OkHttpClient
import okhttp3.Request

/** A published version of the app. */
data class Release(val version: String, val notes: String, val url: String, val size: Long)

sealed interface Update {
    data object Idle : Update
    data object Checking : Update
    data class Downloading(val release: Release, val progress: Float) : Update
    data class Ready(val release: Release, val file: File) : Update
    data class Installing(val release: Release) : Update
    data class Failed(val message: String) : Update
}

/**
 * Keeps the app up to date by itself. Each time the app is opened it asks GitHub (where
 * every version is published) whether there's a newer one, downloads it with progress,
 * and installs it, waiting while a video is being watched. After the first update
 * (which Android asks to confirm once), Android 12+ installs the next ones without asking.
 * Only a version signed with the app's own key can be installed over it, so a tampered
 * download is refused by Android itself.
 */
object Updater {
    private const val RELEASES = "https://api.github.com/repos/SadikTD/pdc-ha-addons/releases?per_page=15"
    private const val TAG_PREFIX = "sentinel-app-v"
    private const val ASSET = "Sentinel.apk"
    const val CHANNEL = "updates"
    private const val NOTE_ID = 7001

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    // Straight to GitHub, not through the tunnel to Sentinel.
    private val http = OkHttpClient.Builder().connectTimeout(15, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS).build()

    private val _state = MutableStateFlow<Update>(Update.Idle)
    val state: StateFlow<Update> = _state.asStateFlow()

    /** Screens playing video (a camera, a clip) right now: installing waits for them. */
    val watching = MutableStateFlow(0)

    /** "Later" was tapped: nothing installs by itself until the app is opened again. */
    val postponed = MutableStateFlow(false)

    /** Up to date, as of this time (for the More page). */
    val checkedAt = MutableStateFlow(0L)

    private var job: Job? = null

    private fun prefs(c: Context) = c.getSharedPreferences("updates", Context.MODE_PRIVATE)

    /** The app came on screen: look for an update (at most every 5 minutes). */
    fun onAppOpen(c: Context) {
        postponed.value = false
        if (System.currentTimeMillis() - prefs(c).getLong("checked", 0) < 5 * 60_000L) return
        check(c, manual = false)
    }

    /** Looks for a newer version and downloads it. manual: from the More page (says how it went). */
    fun check(c: Context, manual: Boolean) {
        if (job?.isActive == true) return
        val s = _state.value
        if (s is Update.Ready && s.file.exists() || s is Update.Installing) return
        val app = c.applicationContext
        job = scope.launch {
            if (manual) _state.value = Update.Checking
            val r = runCatching { withContext(Dispatchers.IO) { latest(app) } }
            prefs(app).edit().putLong("checked", System.currentTimeMillis()).apply()
            val rel = r.getOrElse {
                // On its own, a failed check (no internet) is not worth bothering anyone about.
                _state.value = if (manual) Update.Failed("Couldn't check for updates. Check your internet connection.") else Update.Idle
                return@launch
            }
            if (rel == null || compareVersions(rel.version, BuildConfig.VERSION_NAME) <= 0) {
                checkedAt.value = System.currentTimeMillis()
                _state.value = Update.Idle
                if (manual) Toaster.show("Sentinel is up to date (${BuildConfig.VERSION_NAME})")
                return@launch
            }
            download(app, rel)
        }
    }

    private suspend fun download(c: Context, rel: Release) {
        val dir = File(c.filesDir, "updates").apply { mkdirs() }
        val file = File(dir, "Sentinel-${rel.version}.apk")
        dir.listFiles()?.forEach { if (it != file) it.delete() }
        _state.value = Update.Downloading(rel, 0f)
        val ok = runCatching {
            withContext(Dispatchers.IO) {
                if (!(file.exists() && file.length() == rel.size)) {
                    val part = File(dir, file.name + ".part")
                    http.newCall(Request.Builder().url(rel.url).build()).execute().use { resp ->
                        if (!resp.isSuccessful) error("HTTP ${resp.code}")
                        val body = resp.body ?: error("empty download")
                        val total = body.contentLength().takeIf { it > 0 } ?: rel.size
                        part.outputStream().use { out ->
                            body.byteStream().use { input ->
                                val buf = ByteArray(64 * 1024)
                                var done = 0L
                                var shown = 0f
                                while (true) {
                                    val n = input.read(buf)
                                    if (n < 0) break
                                    out.write(buf, 0, n)
                                    done += n
                                    val p = (done.toFloat() / total).coerceIn(0f, 1f)
                                    if (p - shown >= 0.01f) {
                                        shown = p
                                        _state.value = Update.Downloading(rel, p)
                                    }
                                }
                            }
                        }
                    }
                    if (!part.renameTo(file)) error("couldn't save the download")
                }
                // Only an update of this very app, newer than the one running.
                val info = c.packageManager.getPackageArchiveInfo(file.path, 0) ?: error("the download is damaged")
                val current = PackageInfoCompat.getLongVersionCode(c.packageManager.getPackageInfo(c.packageName, 0))
                if (info.packageName != c.packageName || PackageInfoCompat.getLongVersionCode(info) <= current) error("the download isn't a newer Sentinel")
            }
        }
        if (ok.isFailure) {
            file.delete()
            _state.value = Update.Failed("The update couldn't be downloaded (${ok.exceptionOrNull()?.message}). It will try again next time.")
            return
        }
        _state.value = Update.Ready(rel, file)
    }

    /** Whether Android lets Sentinel install its updates (a one-time switch in Settings). */
    fun canInstall(c: Context) = c.packageManager.canRequestPackageInstalls()

    /** Opens the one-time "Install unknown apps" switch for Sentinel. */
    fun allowInstalls(c: Context) {
        val i = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${c.packageName}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        runCatching { c.startActivity(i) }
    }

    /** Installs the downloaded update. The app closes; the new version tells the user it's done. */
    fun install(c: Context) {
        val r = _state.value as? Update.Ready ?: return
        val app = c.applicationContext
        _state.value = Update.Installing(r.release)
        // For the new version: what's new, and to come back on screen.
        prefs(app).edit().putString("notes_for", r.release.version).putString("notes", r.release.notes).putBoolean("reopen", true).commit()
        scope.launch {
            val res = runCatching {
                withContext(Dispatchers.IO) {
                    val pi = app.packageManager.packageInstaller
                    val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
                        setAppPackageName(app.packageName)
                        setSize(r.file.length())
                        setInstallReason(PackageManager.INSTALL_REASON_USER)
                        // Android 12+: no "Update this app?" question once Sentinel installed itself before.
                        if (Build.VERSION.SDK_INT >= 31) setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
                    }
                    val id = pi.createSession(params)
                    pi.openSession(id).use { s ->
                        s.openWrite(ASSET, 0, r.file.length()).use { out ->
                            r.file.inputStream().use { it.copyTo(out) }
                            s.fsync(out)
                        }
                        val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
                        val done = PendingIntent.getBroadcast(app, id, Intent(app, InstallResultReceiver::class.java).setPackage(app.packageName), flags)
                        s.commit(done.intentSender)
                    }
                }
            }
            if (res.isFailure) failed("Couldn't start installing: ${res.exceptionOrNull()?.message}")
        }
    }

    /** Closes the "didn't finish" message. */
    fun dismiss() {
        if (_state.value is Update.Failed) _state.value = Update.Idle
    }

    internal fun failed(msg: String) {
        prefs(app()).edit().putBoolean("reopen", false).apply()
        _state.value = Update.Failed(msg)
    }

    /** The user said no on Android's own "Update?" screen: ask again next time the app opens. */
    internal fun declined() {
        prefs(app()).edit().putBoolean("reopen", false).apply()
        val s = _state.value
        if (s is Update.Installing) {
            val f = File(File(app().filesDir, "updates"), "Sentinel-${s.release.version}.apk")
            _state.value = if (f.exists()) Update.Ready(s.release, f) else Update.Idle
        }
        postponed.value = true
    }

    private fun app(): Context = SentinelApp.instance

    /** The newest app release on GitHub with the APK attached. */
    private fun latest(c: Context): Release? {
        // Debug builds can be pointed at a test feed (files/update-feed-url), to try updates out.
        val feed = File(c.filesDir, "update-feed-url").takeIf { BuildConfig.DEBUG && it.exists() }?.readText()?.trim() ?: RELEASES
        val req = Request.Builder().url(feed).header("Accept", "application/vnd.github+json").build()
        val text = http.newCall(req).execute().use { if (it.isSuccessful) it.body?.string() else error("HTTP ${it.code}") } ?: return null
        val list = Engine.json.parseToJsonElement(text) as? JsonArray ?: return null
        return list.mapNotNull { el ->
            val o = el as? JsonObject ?: return@mapNotNull null
            val tag = o["tag_name"]?.jsonPrimitive?.content ?: return@mapNotNull null
            if (!tag.startsWith(TAG_PREFIX) || o["draft"]?.jsonPrimitive?.booleanOrNull == true || o["prerelease"]?.jsonPrimitive?.booleanOrNull == true) return@mapNotNull null
            val asset = o["assets"]?.jsonArray?.map { it.jsonObject }?.firstOrNull { it["name"]?.jsonPrimitive?.content == ASSET } ?: return@mapNotNull null
            Release(
                version = tag.removePrefix(TAG_PREFIX),
                notes = o["body"]?.jsonPrimitive?.content.orEmpty().trim(),
                url = asset["browser_download_url"]?.jsonPrimitive?.content ?: return@mapNotNull null,
                size = asset["size"]?.jsonPrimitive?.longOrNull ?: 0L,
            )
        }.maxWithOrNull { a, b -> compareVersions(a.version, b.version) }
    }

    /** "1.10.0" vs "1.9.2", by number. */
    fun compareVersions(a: String, b: String): Int {
        val x = a.split('.', '-').map { it.toIntOrNull() ?: 0 }
        val y = b.split('.', '-').map { it.toIntOrNull() ?: 0 }
        for (i in 0 until maxOf(x.size, y.size)) {
            val d = x.getOrElse(i) { 0 }.compareTo(y.getOrElse(i) { 0 })
            if (d != 0) return d
        }
        return 0
    }

    // ---- After an update: tell the user, once

    /** What's new in the version now running, if it was just installed by an update (shown once). */
    fun takeWhatsNew(c: Context): Pair<String, String>? {
        val p = prefs(c)
        val v = p.getString("notes_for", null) ?: return null
        if (v != BuildConfig.VERSION_NAME) return null
        val notes = p.getString("notes", "").orEmpty()
        p.edit().remove("notes_for").remove("notes").apply()
        return v to notes
    }

    fun channel(c: Context) {
        if (Build.VERSION.SDK_INT < 26) return
        c.getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(CHANNEL, "App updates", NotificationManager.IMPORTANCE_DEFAULT).apply { description = "When Sentinel has updated itself" },
        )
    }

    /** The new version runs for the first time: "Sentinel updated", and back on screen if it was. */
    internal fun onUpdated(c: Context) {
        val p = prefs(c)
        if (p.getBoolean("reopen", false)) {
            p.edit().putBoolean("reopen", false).apply()
            // Allowed on some phones only (Android limits apps starting themselves); the
            // notification below brings the user back otherwise.
            runCatching { c.startActivity(Intent(c, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
        }
        if (!Push.canNotify(c)) return
        channel(c)
        val notes = p.getString("notes", "").orEmpty()
        val lines = notes.lines().map { it.trim().removePrefix("-").removePrefix("•").removePrefix("*").trim() }.filter { it.isNotEmpty() && !it.startsWith("#") }
        val summary = lines.firstOrNull().orEmpty()
        val big = lines.take(5).joinToString(separator = "\n") { "• $it" }
        val open = PendingIntent.getActivity(c, NOTE_ID, Intent(c, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val n = NotificationCompat.Builder(c, CHANNEL)
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(0xFF8B5CF6.toInt())
            .setContentTitle("Sentinel updated to ${BuildConfig.VERSION_NAME}")
            .setContentText(summary.ifBlank { "Tap to see what's new" })
            .setStyle(NotificationCompat.BigTextStyle().bigText(big.ifBlank { "Tap to see what's new" }))
            .setContentIntent(open)
            .setAutoCancel(true)
            .build()
        runCatching { NotificationManagerCompat.from(c).notify(NOTE_ID, n) }
    }
}

/** Android's answer to an install: confirm (first time), done, or failed. */
class InstallResultReceiver : BroadcastReceiver() {
    override fun onReceive(c: Context, intent: Intent) {
        when (val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                // Android asks the user (the first time, or on older Android): show its screen.
                val confirm = IntentCompat.getParcelableExtra(intent, Intent.EXTRA_INTENT, Intent::class.java)
                if (confirm == null) Updater.failed("Android didn't let the update install.")
                else runCatching { c.startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }.onFailure { Updater.failed("Android didn't let the update install.") }
            }
            PackageInstaller.STATUS_SUCCESS -> {} // replaced: the new version takes over
            PackageInstaller.STATUS_FAILURE_ABORTED -> Updater.declined()
            else -> Updater.failed(
                when (status) {
                    PackageInstaller.STATUS_FAILURE_STORAGE -> "Not enough free space on the phone for the update."
                    PackageInstaller.STATUS_FAILURE_CONFLICT, PackageInstaller.STATUS_FAILURE_INCOMPATIBLE -> "This update doesn't fit the installed app (${intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: "conflict"})."
                    PackageInstaller.STATUS_FAILURE_BLOCKED -> "The phone blocked the update. Allow Sentinel to install apps, then try again."
                    else -> "The update didn't install (${intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: "unknown error"})."
                },
            )
        }
    }
}

/** Runs in the new version right after an update. */
class UpdatedReceiver : BroadcastReceiver() {
    override fun onReceive(c: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_MY_PACKAGE_REPLACED) Updater.onUpdated(c)
    }
}
