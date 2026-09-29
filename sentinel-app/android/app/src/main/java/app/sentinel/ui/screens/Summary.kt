package app.sentinel.ui.screens

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.KeyboardArrowLeft
import androidx.compose.material.icons.automirrored.rounded.KeyboardArrowRight
import androidx.compose.material.icons.rounded.AutoAwesome
import androidx.compose.material.icons.rounded.Bolt
import androidx.compose.material.icons.rounded.VerifiedUser
import androidx.compose.material.icons.rounded.Warning
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.sentinel.core.AppState
import app.sentinel.core.DaySummary
import app.sentinel.core.fmtTime
import app.sentinel.ui.components.EventPicture
import app.sentinel.ui.components.GlassCard
import app.sentinel.ui.components.LABELS
import app.sentinel.ui.components.LABEL_ORDER
import app.sentinel.ui.components.LabelChips
import app.sentinel.ui.components.MotionColor
import app.sentinel.ui.components.RoundIcon
import app.sentinel.ui.components.Shimmer
import app.sentinel.ui.theme.C
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlinx.coroutines.delay

/** One day at a glance: who was seen where, when it was busy, and whether every camera recorded. */
@Composable
fun SummaryScreen(state: AppState, date: String?, onBack: () -> Unit, openCamera: (String, Long?) -> Unit) {
    val today = LocalDate.now()
    var day by rememberSaveable { mutableStateOf(date?.let { runCatching { LocalDate.parse(it) }.getOrNull() } ?: today) }
    var sum by remember { mutableStateOf<DaySummary?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(day) {
        sum = null
        error = null
        while (true) {
            state.awaitVisible()
            runCatching { state.api.summary(day.toString()) }.onSuccess { sum = it; error = null }.onFailure { if (sum == null) error = it.message }
            if (day != today) break
            delay(30_000)
        }
    }
    val title = when (day) {
        today -> "Today"
        today.minusDays(1) -> "Yesterday"
        else -> day.format(DateTimeFormatter.ofPattern("EEE d MMM", Locale.getDefault()))
    }
    SubPage("Daily summary", onBack, action = {
        RoundIcon(Icons.AutoMirrored.Rounded.KeyboardArrowLeft, "Previous day", size = 38.dp, background = Color(0x10FFFFFF)) { day = day.minusDays(1) }
        Text(title, color = C.Text, fontSize = 14.sp, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center, modifier = Modifier.width(92.dp))
        RoundIcon(Icons.AutoMirrored.Rounded.KeyboardArrowRight, "Next day", size = 38.dp, background = Color(0x10FFFFFF), tint = if (day < today) Color.White else C.TextFaint) {
            if (day < today) day = day.plusDays(1)
        }
    }) {
        val s = sum
        if (s == null) {
            item {
                if (error != null) GlassCard(Modifier.fillMaxWidth()) { Text(error ?: "", color = C.RoseLight) }
                else Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    repeat(3) { Shimmer(Modifier.fillMaxWidth().height(90.dp).clip(RoundedCornerShape(20.dp))) }
                }
            }
            return@SubPage
        }
        item {
            GlassCard(Modifier.fillMaxWidth()) {
                Row {
                    Box(Modifier.size(38.dp).clip(RoundedCornerShape(12.dp)).background(C.Violet.copy(alpha = 0.16f)), contentAlignment = Alignment.Center) {
                        Icon(Icons.Rounded.AutoAwesome, null, tint = C.VioletLight, modifier = Modifier.size(20.dp))
                    }
                    Column(Modifier.padding(start = 12.dp)) {
                        Text(s.text, color = C.Text, fontSize = 15.sp, lineHeight = 21.sp)
                        if (s.pending > 0) Text("${s.pending} events still being checked for people and animals", color = C.TextFaint, fontSize = 12.sp, modifier = Modifier.padding(top = 4.dp))
                    }
                }
            }
        }
        item {
            val recorded = s.cameras.filter { it.recorded > 0 }
            val worst = recorded.minOfOrNull { it.recorded }
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    LABEL_ORDER.forEach { l ->
                        val st = LABELS.getValue(l)
                        val n = s.totals[l] ?: 0
                        Tile(st.icon, st.color, n.toString(), if (n == 1) st.name else st.plural, Modifier.weight(1f))
                    }
                }
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Tile(Icons.Rounded.Bolt, C.Amber, (s.totals["motion"] ?: 0).toString(), "Motion events", Modifier.weight(1f))
                    val ok = worst == null || worst >= 99
                    Tile(
                        if (ok) Icons.Rounded.VerifiedUser else Icons.Rounded.Warning, if (ok) C.Emerald else C.Amber,
                        worst?.let { if (it >= 99.95) "100%" else String.format(Locale.US, "%.1f%%", it) } ?: "—", "Recorded (worst camera)", Modifier.weight(1f),
                    )
                }
            }
        }
        item { HourChart("People and animals by hour", s, LABEL_ORDER.mapIndexed { i, l -> Triple(LABELS.getValue(l).plural, LABELS.getValue(l).color, i + 1) }) }
        item { HourChart("Motion events by hour", s, listOf(Triple("Motion", MotionColor, 0))) }
        if (s.highlights.isNotEmpty()) {
            item { Text("Highlights", color = C.Text, fontSize = 16.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 6.dp)) }
            s.highlights.chunked(2).forEach { row ->
                item {
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        row.forEach { e ->
                            Column(Modifier.weight(1f).clip(RoundedCornerShape(14.dp)).clickable { openCamera(e.camera, e.bestTime - 3000) }) {
                                Box(Modifier.fillMaxWidth().aspectRatio(16f / 9f).clip(RoundedCornerShape(14.dp))) {
                                    EventPicture(state.api, e, Modifier.matchParentSize())
                                    LabelChips(e.labels, Modifier.align(Alignment.BottomStart).padding(6.dp), small = true)
                                }
                                Row(Modifier.padding(top = 5.dp, start = 2.dp, end = 2.dp)) {
                                    Text(s.cameras.find { it.id == e.camera }?.name ?: e.camera, color = C.Text, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                                    Text(fmtTime(e.start), color = C.TextDim, fontSize = 12.sp)
                                }
                            }
                        }
                        if (row.size == 1) Box(Modifier.weight(1f))
                    }
                }
            }
        }
        item { Text("Cameras", color = C.Text, fontSize = 16.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 6.dp)) }
        s.cameras.forEach { c ->
            item {
                GlassCard(Modifier.fillMaxWidth(), onClick = { openCamera(c.id, if (c.lastPerson > 0) c.lastPerson - 3000 else null) }) {
                    Column {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(c.name, color = C.Text, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                            if (c.recorded > 0) Text(
                                if (c.recorded >= 99.95) "100%" else String.format(Locale.US, "%.1f%%", c.recorded),
                                color = when { c.recorded >= 99 -> C.Emerald; c.recorded >= 95 -> C.Amber; else -> C.RoseLight }, fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
                            )
                        }
                        Row(Modifier.padding(top = 6.dp), horizontalArrangement = Arrangement.spacedBy(14.dp), verticalAlignment = Alignment.CenterVertically) {
                            LABEL_ORDER.forEach { l ->
                                val st = LABELS.getValue(l)
                                val n = c.counts[l] ?: 0
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Icon(st.icon, st.plural, tint = if (n > 0) st.color else C.TextFaint, modifier = Modifier.size(15.dp))
                                    Text(" $n", color = if (n > 0) C.Text else C.TextFaint, fontSize = 13.sp)
                                }
                            }
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Icon(Icons.Rounded.Bolt, "Motion", tint = C.TextDim, modifier = Modifier.size(15.dp))
                                Text(" ${c.counts["motion"] ?: 0}", color = C.TextDim, fontSize = 13.sp)
                            }
                        }
                        if (c.firstPerson > 0) Text(
                            if (c.firstPerson == c.lastPerson) "Person seen at ${fmtTime(c.firstPerson)}" else "People seen ${fmtTime(c.firstPerson)} – ${fmtTime(c.lastPerson)}",
                            color = C.TextDim, fontSize = 12.sp, modifier = Modifier.padding(top = 4.dp),
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun Tile(icon: ImageVector, color: Color, value: String, label: String, modifier: Modifier) {
    Row(modifier.clip(RoundedCornerShape(18.dp)).background(C.Glass).border(1.dp, C.GlassBorder, RoundedCornerShape(18.dp)).padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(34.dp).clip(RoundedCornerShape(10.dp)).background(color.copy(alpha = 0.16f)), contentAlignment = Alignment.Center) {
            Icon(icon, null, tint = color, modifier = Modifier.size(18.dp))
        }
        Column(Modifier.padding(start = 10.dp)) {
            Text(value, color = C.Text, fontSize = 20.sp, fontWeight = FontWeight.SemiBold)
            Text(label, color = C.TextDim, fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

/** Events per hour as bars (stacked for several kinds); tap a bar for its numbers. */
@Composable
private fun HourChart(title: String, s: DaySummary, series: List<Triple<String, Color, Int>>) {
    var picked by remember { mutableStateOf<Int?>(null) }
    val totals = s.hours.map { h -> series.sumOf { h.getOrElse(it.third) { 0 } } }
    val top = niceMax(maxOf(1, totals.maxOrNull() ?: 1))
    GlassCard(Modifier.fillMaxWidth()) {
        Column {
            Text(title, color = C.Text, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
            if (series.size > 1) Row(Modifier.padding(top = 6.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                series.forEach { (name, color, _) ->
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Box(Modifier.size(9.dp).clip(RoundedCornerShape(2.dp)).background(color))
                        Text(" $name", color = C.TextDim, fontSize = 11.sp)
                    }
                }
            }
            val p = picked
            Text(
                if (p != null) "%02d:00–%02d:00 · ".format(p, (p + 1) % 24) + series.joinToString(" · ") { "${s.hours.getOrNull(p)?.getOrElse(it.third) { 0 } ?: 0} ${it.first.lowercase()}" }
                else "Tap a bar for the numbers · top of the chart = $top",
                color = if (p != null) C.Text else C.TextFaint, fontSize = 12.sp, modifier = Modifier.padding(top = 8.dp, bottom = 6.dp),
            )
            Canvas(
                Modifier.fillMaxWidth().height(110.dp).pointerInput(s) {
                    detectTapGestures { o -> picked = (o.x / size.width * 24).toInt().coerceIn(0, 23).let { if (it == picked) null else it } }
                },
            ) {
                val gap = 2.dp.toPx()
                val bw = (size.width - gap * 23) / 24
                drawRect(Color(0x1AFFFFFF), Offset(0f, size.height - 1), Size(size.width, 1f))
                for (i in 0 until 24) {
                    val h = s.hours.getOrNull(i) ?: continue
                    val x = i * (bw + gap)
                    if (picked == i) drawRect(Color(0x0FFFFFFF), Offset(x, 0f), Size(bw, size.height))
                    var y = size.height
                    val drawn = series.filter { h.getOrElse(it.third) { 0 } > 0 }
                    drawn.forEachIndexed { k, (_, color, idx) ->
                        val v = h.getOrElse(idx) { 0 }
                        val bh = maxOf(2f, v.toFloat() / top * size.height)
                        y -= bh
                        val r = if (k == drawn.lastIndex) CornerRadius(3.dp.toPx()) else CornerRadius.Zero
                        drawRoundRect(color, Offset(x, y), Size(bw, bh), r)
                        y -= gap
                    }
                }
            }
            Row(Modifier.fillMaxWidth().padding(top = 4.dp)) {
                listOf("00", "06", "12", "18", "24").forEachIndexed { i, t ->
                    Text(t, color = C.TextFaint, fontSize = 10.sp, modifier = Modifier.weight(1f), textAlign = when (i) { 0 -> TextAlign.Start; 4 -> TextAlign.End; else -> TextAlign.Center })
                }
            }
        }
    }
}

private fun niceMax(v: Int): Int {
    var p = 1
    while (p * 10 < v) p *= 10
    for (m in listOf(1, 2, 5, 10)) if (m * p >= v) return m * p
    return v
}
