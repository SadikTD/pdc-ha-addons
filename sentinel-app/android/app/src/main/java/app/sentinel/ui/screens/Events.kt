package app.sentinel.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Bolt
import androidx.compose.material.icons.rounded.PlayArrow
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.sentinel.core.AppState
import app.sentinel.core.DAY
import app.sentinel.core.SentinelEvent
import app.sentinel.core.fmtDay
import app.sentinel.core.fmtDuration
import app.sentinel.core.fmtTime
import app.sentinel.core.startOfDay
import app.sentinel.ui.components.Chip
import app.sentinel.ui.components.EmptyState
import app.sentinel.ui.components.Gap
import app.sentinel.ui.components.Shimmer
import app.sentinel.ui.theme.C
import coil3.compose.AsyncImage
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

private val RANGES = listOf("Today", "24 hours", "3 days", "7 days")

/** Motion events with thumbnails, by day, filterable by camera and time range. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun EventsScreen(state: AppState, padding: PaddingValues, openCamera: (String, Long?) -> Unit) {
    val status by state.status.collectAsStateWithLifecycle()
    val prefs by state.prefs.collectAsStateWithLifecycle()
    val cams = state.orderedCameras(status, prefs)
    val names = cams.associate { it.id to it.name }
    val aspects = cams.associate { it.id to it.aspect }
    var range by rememberSaveable { mutableIntStateOf(1) }
    var camFilter by rememberSaveable { mutableStateOf<String?>(null) }
    var size by rememberSaveable { mutableIntStateOf(0) }
    var events by remember { mutableStateOf<List<SentinelEvent>?>(null) }
    var refreshing by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    suspend fun load() {
        val now = state.serverNow()
        val from = when (range) {
            0 -> startOfDay(now)
            1 -> now - DAY
            2 -> now - 3 * DAY
            else -> now - 7 * DAY
        }
        runCatching { state.api.events(camFilter?.let { listOf(it) } ?: emptyList(), from, null, 800) }
            .onSuccess { events = it.sortedByDescending { e -> e.start } }
    }
    LaunchedEffect(range, camFilter) {
        events = null
        while (true) {
            load()
            delay(20_000)
        }
    }

    val minPeak = when (size) { 1 -> 3.0; 2 -> 10.0; else -> 0.0 }
    val list = events?.filter { it.peak >= minPeak }
    val grouped = list?.groupBy { startOfDay(it.start) }?.toSortedMap(compareByDescending { it })

    PullToRefreshBox(refreshing, onRefresh = { scope.launch { refreshing = true; load(); refreshing = false } }, modifier = Modifier.fillMaxSize()) {
        LazyVerticalGrid(
            columns = GridCells.Adaptive(165.dp),
            contentPadding = PaddingValues(start = 14.dp, end = 14.dp, top = padding.calculateTopPadding() + 8.dp, bottom = padding.calculateBottomPadding() + 16.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
            modifier = Modifier.fillMaxSize(),
        ) {
            item(span = { GridItemSpan(maxLineSpan) }) {
                Column {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("Events", style = MaterialTheme.typography.headlineMedium, modifier = Modifier.weight(1f))
                        if (list != null) Text("${list.size}${if ((events?.size ?: 0) >= 800) "+" else ""} motion${if (list.size == 1) "" else "s"}", color = C.TextDim, fontSize = 13.sp)
                    }
                    Gap(12.dp)
                    Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        RANGES.forEachIndexed { i, r -> Chip(r, range == i) { range = i } }
                        Chip(listOf("Any size", "Medium+", "Large")[size], size > 0) { size = (size + 1) % 3 }
                    }
                    Gap(8.dp)
                    Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Chip("All cameras", camFilter == null) { camFilter = null }
                        cams.forEach { c -> Chip(c.name, camFilter == c.id) { camFilter = if (camFilter == c.id) null else c.id } }
                    }
                }
            }
            if (list == null) {
                items(6) { Shimmer(Modifier.fillMaxWidth().aspectRatio(16f / 11f).clip(RoundedCornerShape(16.dp))) }
            } else if (list.isEmpty()) {
                item(span = { GridItemSpan(maxLineSpan) }) {
                    EmptyState(Icons.Rounded.Bolt, "No motion", "Nothing moved on ${if (camFilter != null) names[camFilter] ?: "this camera" else "your cameras"} in this time.")
                }
            }
            grouped?.forEach { (day, evs) ->
                item(span = { GridItemSpan(maxLineSpan) }, key = "day-$day") {
                    Row(Modifier.padding(top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text(fmtDay(day, state.serverNow()), style = MaterialTheme.typography.titleMedium)
                        Text("  ${evs.size}", color = C.TextFaint, fontSize = 13.sp)
                    }
                }
                items(evs, key = { "${it.camera}/${it.id}" }) { e ->
                    EventCard(state, e, names[e.camera] ?: e.camera, aspects[e.camera] ?: (16f / 9f)) { openCamera(e.camera, e.start - 2000) }
                }
            }
        }
    }
}

@Composable
private fun EventCard(state: AppState, e: SentinelEvent, camName: String, aspect: Float, onClick: () -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    Column(Modifier.scale(if (pressed) 0.97f else 1f).clip(RoundedCornerShape(16.dp)).clickable(interaction, null, onClick = onClick)) {
        Box(Modifier.fillMaxWidth().aspectRatio(aspect.coerceIn(1.2f, 2f)).clip(RoundedCornerShape(16.dp)).background(C.Ink800).border(1.dp, C.GlassBorder, RoundedCornerShape(16.dp))) {
            AsyncImage(state.api.thumbUrl(e), null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
            Box(Modifier.fillMaxWidth().height(40.dp).align(Alignment.BottomCenter).background(Brush.verticalGradient(listOf(Color.Transparent, Color(0xAA000000)))))
            Row(Modifier.align(Alignment.BottomStart).padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Rounded.PlayArrow, null, tint = Color.White, modifier = Modifier.size(16.dp))
                Text(if (e.ongoing) "now" else fmtDuration(e.end - e.start), color = Color.White, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
            }
            if (e.ongoing) Text(
                "LIVE", color = Color.Black, fontSize = 10.sp, fontWeight = FontWeight.Bold,
                modifier = Modifier.align(Alignment.TopEnd).padding(8.dp).clip(RoundedCornerShape(6.dp)).background(C.Amber).padding(horizontal = 6.dp, vertical = 2.dp),
            )
            // Motion strength
            Box(Modifier.align(Alignment.BottomEnd).padding(10.dp).size(width = 36.dp, height = 4.dp).clip(CircleShape).background(Color(0x55FFFFFF))) {
                Box(Modifier.fillMaxSize().fillMaxWidth((e.peak.toFloat() / 25f).coerceIn(0.08f, 1f)).clip(CircleShape).background(C.Amber))
            }
        }
        Row(Modifier.padding(top = 7.dp, start = 2.dp, end = 2.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(camName, color = C.Text, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            Text(fmtTime(e.start), color = C.TextDim, fontSize = 12.sp)
        }
    }
}
