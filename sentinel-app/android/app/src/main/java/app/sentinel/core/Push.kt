package app.sentinel.core

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import app.sentinel.MainActivity
import app.sentinel.R
import app.sentinel.SentinelApp
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerialName
import okhttp3.Request

@Serializable
data class FirebaseClient(
    @SerialName("api_key") val apiKey: String,
    @SerialName("app_id") val appId: String,
    @SerialName("project_id") val projectId: String,
    @SerialName("sender_id") val senderId: String,
)

@Serializable
data class PushPrefs(
    val alerts: Boolean = true,
    val status: Boolean = true,
    val motion: List<String> = emptyList(),
    /** The daily summary (null = on). */
    val summary: Boolean? = null,
) {
    val wantsSummary: Boolean get() = summary != false
}

/**
 * Notifications through Firebase Cloud Messaging. Sentinel hands the app its Firebase
 * config after login (nothing is built into the app), messages carry only a type,
 * camera and time, and pictures are fetched from Sentinel over the encrypted tunnel.
 */
object Push {
    const val CH_ALERTS = "alerts"
    const val CH_STATUS = "status"
    const val CH_MOTION = "motion"
    const val CH_SUMMARY = "summary"
    private const val PREFS = "push"

    fun channels(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = context.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CH_ALERTS, "Night alerts", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "People and animals seen at night, with the picture"
            enableVibration(true)
        })
        nm.createNotificationChannel(NotificationChannel(CH_STATUS, "Camera problems", NotificationManager.IMPORTANCE_DEFAULT).apply {
            description = "A camera stopped or started recording"
        })
        nm.createNotificationChannel(NotificationChannel(CH_MOTION, "Motion", NotificationManager.IMPORTANCE_DEFAULT).apply {
            description = "Any motion on the cameras you chose"
        })
        nm.createNotificationChannel(NotificationChannel(CH_SUMMARY, "Daily summary", NotificationManager.IMPORTANCE_LOW).apply {
            description = "Once a day: who was seen yesterday, and whether every camera recorded"
        })
    }

    /** Starts Firebase with the config Sentinel gave us (remembered for when a push wakes the app). */
    fun init(context: Context, cfg: FirebaseClient?): Boolean {
        val sp = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val c = cfg ?: sp.getString("config", null)?.let { runCatching { Engine.json.decodeFromString<FirebaseClient>(it) }.getOrNull() } ?: return false
        if (cfg != null) sp.edit().putString("config", Engine.json.encodeToString(cfg)).apply()
        val existing = FirebaseApp.getApps(context).firstOrNull { it.name == FirebaseApp.DEFAULT_APP_NAME }
        if (existing != null) {
            if (existing.options.applicationId == c.appId) return true
            return false // a different project: takes effect after the app restarts
        }
        FirebaseApp.initializeApp(
            context,
            FirebaseOptions.Builder().setApiKey(c.apiKey).setApplicationId(c.appId).setProjectId(c.projectId).setGcmSenderId(c.senderId).build(),
        )
        return true
    }

    suspend fun token(): String? = runCatching { FirebaseMessaging.getInstance().token.await() }.getOrNull()

    fun canNotify(context: Context) =
        Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    fun summaryIntent(context: Context, date: String): PendingIntent {
        val uri = Uri.parse("sentinel://summary?date=$date")
        val i = Intent(Intent.ACTION_VIEW, uri, context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        return PendingIntent.getActivity(context, uri.hashCode(), i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    fun openIntent(context: Context, cam: String?, t: Long?): PendingIntent {
        val uri = if (cam != null) Uri.parse("sentinel://camera?id=$cam" + (t?.let { "&t=$it" } ?: "")) else Uri.parse("sentinel://home")
        val i = Intent(Intent.ACTION_VIEW, uri, context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        return PendingIntent.getActivity(context, uri.hashCode(), i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }
}

class SentinelMessagingService : FirebaseMessagingService() {
    private val app get() = application as SentinelApp

    override fun onNewToken(token: String) {
        runBlocking { withTimeoutOrNull(15_000) { app.state.registerPush(token) } }
    }

    override fun onMessageReceived(msg: RemoteMessage) {
        val d = msg.data
        val cam = d["camera"]
        val name = d["name"] ?: cam ?: "Sentinel"
        val t = d["t"]?.toLongOrNull() ?: System.currentTimeMillis()
        val nm = NotificationManagerCompat.from(this)
        if (!Push.canNotify(this)) return
        val b = NotificationCompat.Builder(this, Push.CH_ALERTS)
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(0xFF8B5CF6.toInt())
            .setAutoCancel(true)
            .setWhen(t)
            .setShowWhen(true)
        val id: Int
        when (d["type"]) {
            "alert" -> {
                val what = d["what"] ?: "Motion"
                b.setChannelId(Push.CH_ALERTS).setContentTitle("$what · $name").setContentText("${fmtTimeSec(t)} · tap to watch")
                    .setPriority(NotificationCompat.PRIORITY_HIGH).setCategory(NotificationCompat.CATEGORY_ALARM)
                    .setContentIntent(Push.openIntent(this, cam, t - 3000))
                id = "alert/$cam/${d["event"]}/$what".hashCode()
                nm.notifySafe(id, b.build()) // text first, the picture follows
                fetch("api/alerts/picture?camera=$cam&t=$t")?.let { bmp ->
                    b.setLargeIcon(bmp).setStyle(NotificationCompat.BigPictureStyle().bigPicture(bmp).bigLargeIcon(null as Bitmap?)).setOnlyAlertOnce(true)
                    nm.notifySafe(id, b.build())
                }
            }
            "summary" -> {
                val date = d["date"] ?: ""
                val text = d["text"] ?: ""
                b.setChannelId(Push.CH_SUMMARY).setContentTitle("Yesterday on your cameras").setContentText(text)
                    .setStyle(NotificationCompat.BigTextStyle().bigText(text))
                    .setContentIntent(Push.summaryIntent(this, date))
                nm.notifySafe("summary".hashCode(), b.build())
            }
            "motion" -> {
                b.setChannelId(Push.CH_MOTION).setContentTitle("Motion · $name").setContentText("${fmtTimeSec(t)} · tap to watch")
                    .setContentIntent(Push.openIntent(this, cam, t - 3000)).setGroup("motion-$cam")
                id = "motion/$cam".hashCode()
                fetch("api/cameras/$cam/snapshot.jpg?t=$t")?.let { bmp ->
                    b.setLargeIcon(bmp).setStyle(NotificationCompat.BigPictureStyle().bigPicture(bmp).bigLargeIcon(null as Bitmap?))
                }
                nm.notifySafe(id, b.build())
            }
            "status" -> {
                val down = d["state"] == "down"
                b.setChannelId(Push.CH_STATUS)
                    .setContentTitle(if (down) "$name isn't recording" else "$name is recording again")
                    .setContentText(d["text"] ?: "")
                    .setStyle(NotificationCompat.BigTextStyle().bigText(d["text"] ?: ""))
                    .setContentIntent(Push.openIntent(this, null, null))
                id = "status/$cam".hashCode()
                nm.notifySafe(id, b.build())
            }
            "test" -> {
                b.setChannelId(Push.CH_STATUS).setContentTitle("Sentinel notifications work").setContentText("You'll get alerts on this phone.")
                    .setContentIntent(Push.openIntent(this, null, null))
                nm.notifySafe("test".hashCode(), b.build())
            }
        }
    }

    /** Fetches an image from Sentinel through the tunnel (the push may have just woken the app). */
    private fun fetch(path: String): Bitmap? = runBlocking {
        withTimeoutOrNull(15_000) {
            app.state.auth.first { it is Auth.LoggedIn || it is Auth.LoggedOut || it is Auth.NoServer }
            if (app.state.auth.value !is Auth.LoggedIn) return@withTimeoutOrNull null
            runCatching {
                val client = app.engine.http.newBuilder().callTimeout(14, TimeUnit.SECONDS).build()
                client.newCall(Request.Builder().url(app.engine.url(path)).build()).execute().use { r ->
                    if (r.isSuccessful) r.body?.bytes()?.let { BitmapFactory.decodeByteArray(it, 0, it.size) } else null
                }
            }.getOrNull()
        }.also {
            // Woken in the background just for this: don't keep the connection alive.
            val visible = androidx.lifecycle.ProcessLifecycleOwner.get().lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.STARTED)
            if (!visible) app.engine.onBackground()
        }
    }

    private fun NotificationManagerCompat.notifySafe(id: Int, n: android.app.Notification) {
        runCatching { notify(id, n) }
    }
}
