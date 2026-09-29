package app.sentinel.core

import java.text.DateFormat
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale
import kotlin.math.abs
import kotlin.math.roundToLong

const val SECOND = 1000L
const val MINUTE = 60 * SECOND
const val HOUR = 60 * MINUTE
const val DAY = 24 * HOUR

private val timeFmt: DateFormat get() = DateFormat.getTimeInstance(DateFormat.SHORT)
private val timeSecFmt: DateFormat get() = DateFormat.getTimeInstance(DateFormat.MEDIUM)
private val dayFmt get() = SimpleDateFormat("EEE, d MMM", Locale.getDefault())

fun fmtTime(ms: Long): String = timeFmt.format(Date(ms))
fun fmtTimeSec(ms: Long): String = timeSecFmt.format(Date(ms))

fun startOfDay(ms: Long): Long = Calendar.getInstance().apply {
    timeInMillis = ms
    set(Calendar.HOUR_OF_DAY, 0); set(Calendar.MINUTE, 0); set(Calendar.SECOND, 0); set(Calendar.MILLISECOND, 0)
}.timeInMillis

fun fmtDay(ms: Long, now: Long = System.currentTimeMillis()): String {
    val d = startOfDay(ms)
    val today = startOfDay(now)
    return when (d) {
        today -> "Today"
        startOfDay(today - 1) -> "Yesterday"
        else -> dayFmt.format(Date(ms))
    }
}

fun fmtDayTime(ms: Long, now: Long = System.currentTimeMillis()): String = "${fmtDay(ms, now)} · ${fmtTime(ms)}"

fun fmtDuration(ms: Long): String {
    val s = (abs(ms) / 1000.0).roundToLong()
    if (s < 60) return "${s}s"
    val m = s / 60
    if (m < 60) return if (s % 60 != 0L) "${m}m ${s % 60}s" else "${m}m"
    val h = m / 60
    if (h < 48) return if (m % 60 != 0L) "${h}h ${m % 60}m" else "${h}h"
    return "${h / 24}d ${h % 24}h"
}

fun fmtAgo(ms: Long, now: Long = System.currentTimeMillis()): String {
    val d = now - ms
    if (d < 5_000) return "just now"
    return "${fmtDuration(d)} ago"
}

fun fmtBytes(b: Long): String = when {
    b < 1_000_000 -> "${b / 1000} KB"
    b < 1_000_000_000 -> "${b / 1_000_000} MB"
    b < 1_000_000_000_000 -> String.format(Locale.US, if (b < 10_000_000_000) "%.1f GB" else "%.0f GB", b / 1e9)
    else -> String.format(Locale.US, "%.2f TB", b / 1e12)
}

fun fmtBitrate(kbps: Double): String = if (kbps >= 1000) String.format(Locale.US, "%.1f Mbps", kbps / 1000) else "${kbps.roundToLong()} kbps"

/** Recording states as Sentinel names them. */
fun stateLabel(state: String): String = when (state) {
    "recording" -> "Recording"
    "starting" -> "Connecting"
    "stalled" -> "Stalled"
    "reconnecting" -> "Reconnecting"
    "offline" -> "Offline"
    "disabled" -> "Disabled"
    "not-recording" -> "Live only"
    else -> state.replaceFirstChar { it.uppercase() }
}
