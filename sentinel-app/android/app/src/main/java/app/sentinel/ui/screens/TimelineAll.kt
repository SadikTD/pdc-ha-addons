package app.sentinel.ui.screens

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.sentinel.core.AppState
import app.sentinel.core.CameraStatus
import app.sentinel.core.DAY
import app.sentinel.core.HOUR
import app.sentinel.core.SentinelEvent
import app.sentinel.core.Span
import app.sentinel.core.fmtDay
import app.sentinel.core.startOfDay
import app.sentinel.ui.components.Chip
import app.sentinel.ui.components.Gap
import app.sentinel.ui.components.GlassCard
import app.sentinel.ui.theme.C
import kotlin.math.roundToInt
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay

private data class DayData(val coverage: List<Span>, val events: List<SentinelEvent>)

/** Every camera's day on one timeline: footage, gaps and motion. Tap to play that moment. */
@Composable
fun TimelineScreen(state: AppState, padding: PaddingValues, openCamera: (String, Long?) -> Unit) {
    val status by state.status.collectAsStateWithLifecycle()
    val prefs by state.prefs.collectAsStateWithLifecycle()
    val cams = state.orderedCameras(status, prefs)
    var dayOffset by rememberSaveable { mutableIntStateOf(0) }
    val today = startOfDay(state.serverNow())
    val dayStart = startOfDay(today - dayOffset * DAY + HOUR) // DST-safe
    val dayEnd = startOfDay(dayStart + DAY + 2 * HOUR)
    var data by remember { mutableStateOf<Map<String, DayData>>(emptyMap()) }

    LaunchedEffect(dayStart, cams.map { it.id }) {
        data = emptyMap()
        while (true) {
            state.awaitVisible()
            data = coroutineScope {
                cams.map { c ->
                    async {
                        val cov = runCatching { state.api.coverage(c.id, dayStart, dayEnd) }.getOrDefault(emptyList())
                        val ev = runCatching { state.api.events(listOf(c.id), dayStart, dayEnd, 1000) }.getOrDefault(emptyList())
                        c.id to DayData(cov, ev)
                    }
                }.awaitAll().toMap()
            }
            delay(60_000)
        }
    }

    LazyColumn(
        contentPadding = PaddingValues(start = 14.dp, end = 14.dp, top = padding.calculateTopPadding() + 8.dp, bottom = padding.calculateBottomPadding() + 16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
        modifier = Modifier.fillMaxSize(),
    ) {
        item {
            Text("Timeline", style = MaterialTheme.typography.headlineMedium)
            Gap(4.dp)
            Text("Every camera's day: footage, gaps in red, motion in amber. Tap a moment to play it.", color = C.TextDim, fontSize = 13.sp)
            Gap(12.dp)
            Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                (0..6).forEach { i -> Chip(fmtDay(today - i * DAY + HOUR, state.serverNow()), dayOffset == i) { dayOffset = i } }
            }
        }
        item { HourAxis() }
        items(cams, key = { it.id }) { c ->
            DayRow(c, data[c.id], dayStart, dayEnd, state.serverNow()) { t -> openCamera(c.id, t) }
        }
    }
}

@Composable
private fun HourAxis() {
    val measurer = rememberTextMeasurer()
    val style = TextStyle(color = C.TextFaint, fontSize = 10.sp)
    Canvas(Modifier.fillMaxWidth().height(16.dp).padding(horizontal = 14.dp)) {
        for (h in 0..24 step 3) {
            val x = size.width * h / 24f
            val m = measurer.measure(if (h == 24) "" else "%02d".format(h), style)
            drawText(m, topLeft = Offset((x - m.size.width / 2f).coerceIn(0f, size.width - m.size.width), 0f))
        }
    }
}

@Composable
private fun DayRow(cam: CameraStatus, d: DayData?, dayStart: Long, dayEnd: Long, now: Long, onTap: (Long) -> Unit) {
    val len = (dayEnd - dayStart).toFloat()
    val until = minOf(now, dayEnd)
    val recorded = d?.coverage?.sumOf { (minOf(it.e, until) - maxOf(it.s, dayStart)).coerceAtLeast(0) } ?: 0
    val pct = if (until > dayStart) (recorded * 100.0 / (until - dayStart)).roundToInt().coerceIn(0, 100) else 0
    GlassCard(Modifier.fillMaxWidth(), padding = PaddingValues(14.dp)) {
        Column {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(cam.name, style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
                if (d != null) {
                    app.sentinel.ui.components.LABEL_ORDER.forEach { l ->
                        val n = d.events.count { l in it.labels }
                        if (n > 0) {
                            val st = app.sentinel.ui.components.LABELS.getValue(l)
                            androidx.compose.material3.Icon(st.icon, st.plural, tint = st.color, modifier = Modifier.size(14.dp))
                            Text("$n  ", color = C.Text, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                        }
                    }
                    Text("${d.events.size} motion", color = C.Amber, fontSize = 12.sp)
                    Text("  ·  ", color = C.TextFaint, fontSize = 12.sp)
                    Text("$pct% recorded", color = if (pct >= 99) C.Emerald else if (pct > 80) C.Amber else C.RoseLight, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                }
            }
            Gap(10.dp)
            Canvas(
                Modifier.fillMaxWidth().height(34.dp).pointerInput(dayStart) {
                    detectTapGestures { p -> onTap((dayStart + p.x / size.width * len).toLong().coerceAtMost(now - 5_000)) }
                },
            ) {
                val w = size.width
                val h = size.height
                fun x(t: Long) = ((t - dayStart) / len * w).coerceIn(0f, w)
                val r = CornerRadius(5.dp.toPx())
                val top = h * 0.42f
                val th = h * 0.58f
                drawRoundRect(C.Ink800, Offset(0f, top), Size(w, th), r)
                if (until > dayStart) drawRoundRect(C.Rose.copy(alpha = 0.18f), Offset(0f, top), Size(x(until), th), r)
                val band = Brush.horizontalGradient(listOf(C.Violet.copy(alpha = 0.85f), C.Cyan.copy(alpha = 0.75f)), 0f, w)
                d?.coverage?.forEach { s ->
                    val a = x(s.s)
                    val b = x(minOf(s.e, until))
                    if (b > a) drawRect(band, Offset(a, top), Size(maxOf(b - a, 1f), th))
                }
                d?.events?.forEach { e ->
                    if (app.sentinel.ui.components.mainLabel(e) != null) return@forEach
                    val a = x(e.start)
                    drawRect(C.Amber.copy(alpha = 0.6f), Offset(a, h * 0.08f), Size(maxOf(x(e.endOr(now)) - a, 1.5f), h * 0.22f))
                }
                // People and animals: taller marks in their colour, over the motion.
                d?.events?.forEach { e ->
                    val l = app.sentinel.ui.components.mainLabel(e) ?: return@forEach
                    val a = x(e.start)
                    drawRect(C.Ink950, Offset(a - 1f, 0f), Size(maxOf(x(e.endOr(now)) - a, 3f) + 2f, h * 0.38f))
                    drawRect(app.sentinel.ui.components.LABELS.getValue(l).color, Offset(a, 0f), Size(maxOf(x(e.endOr(now)) - a, 3f), h * 0.36f))
                }
                for (hh in 3 until 24 step 3) drawLine(Color(0x22FFFFFF), Offset(w * hh / 24f, top), Offset(w * hh / 24f, h), 1f)
                if (now in dayStart..dayEnd) drawLine(C.Emerald, Offset(x(now), 0f), Offset(x(now), h), 2.dp.toPx())
            }
        }
    }
}
