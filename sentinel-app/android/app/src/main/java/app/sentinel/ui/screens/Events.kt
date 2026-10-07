package app.sentinel.ui.screens

import androidx.compose.material.icons.rounded.Person
import app.sentinel.core.ListItem
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.combinedClickable
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
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Bolt
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.PlayArrow
import androidx.compose.material.icons.rounded.Search
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
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
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.sentinel.core.AppState
import app.sentinel.core.DAY
import app.sentinel.core.MINUTE
import app.sentinel.core.SearchQuery
import app.sentinel.core.SentinelEvent
import app.sentinel.core.fmtDay
import app.sentinel.core.fmtDuration
import app.sentinel.core.fmtTime
import app.sentinel.core.startOfDay
import app.sentinel.ui.components.Chip
import app.sentinel.ui.components.EmptyState
import app.sentinel.ui.components.EventPicture
import app.sentinel.ui.components.Gap
import app.sentinel.ui.components.LABELS
import app.sentinel.ui.components.LABEL_ORDER
import app.sentinel.ui.components.LabelChips
import app.sentinel.ui.components.Shimmer
import app.sentinel.ui.components.Toaster
import app.sentinel.ui.theme.C
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

private val RANGES = listOf("Today", "24 hours", "3 days", "7 days")
private val EXAMPLES = listOf("People today", "Person last night", "Cats this week", "Dogs yesterday", "People after 10pm")

/**
 * Motion events by day, with who was seen (people, cats, dogs), a search that
 * understands plain questions, and filters by kind, camera and time range.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun EventsScreen(state: AppState, padding: PaddingValues, openEvent: (ListItem) -> Unit) {
    val status by state.status.collectAsStateWithLifecycle()
    val prefs by state.prefs.collectAsStateWithLifecycle()
    val cams = state.orderedCameras(status, prefs)
    val names = cams.associate { it.id to it.name }
    val aspects = cams.associate { it.id to it.aspect }
    var range by rememberSaveable { mutableIntStateOf(1) }
    var camFilter by rememberSaveable { mutableStateOf<String?>(null) }
    var kind by rememberSaveable { mutableStateOf("all") } // all, person, cat, dog, motion
    var size by rememberSaveable { mutableIntStateOf(0) }
    var whoFilter by rememberSaveable { mutableStateOf<String?>(null) }
    // People Sentinel recognises (named on the People page), for the filter.
    var people by remember { mutableStateOf(state.peopleCache) }
    LaunchedEffect(Unit) { runCatching { state.api.people().people }.onSuccess { people = it; state.peopleCache = it } }
    var text by rememberSaveable { mutableStateOf("") }
    var asked by rememberSaveable { mutableStateOf("") }
    var parsed by remember { mutableStateOf<SearchQuery?>(null) }
    // Kept while an event is open, so coming back shows the list at once, where it was.
    val key = "$range|$camFilter|$asked"
    var events by remember { mutableStateOf(state.eventsCache[key]) }
    var lastFull by remember { mutableLongStateOf(0L) }
    val grid = rememberLazyGridState()
    var searching by remember { mutableStateOf(false) }
    var refreshing by remember { mutableStateOf(false) }
    var wrongFor by remember { mutableStateOf<SentinelEvent?>(null) }
    val scope = rememberCoroutineScope()
    val focus = LocalFocusManager.current

    suspend fun load() {
        if (asked.isNotBlank()) {
            searching = true
            runCatching { state.api.search(asked, 1000) }
                .onSuccess { events = it.events.sortedByDescending { e -> e.start }.also { l -> state.eventsCache[key] = l }; parsed = it.query }
                .onFailure { if (events == null) events = emptyList() }
            searching = false
            return
        }
        parsed = null
        val now = state.serverNow()
        val from = when (range) {
            0 -> startOfDay(now)
            1 -> now - DAY
            2 -> now - 3 * DAY
            else -> now - 7 * DAY
        }
        // The whole list now and then; in between only what's recent (new events, and
        // labels and people added to them in the minutes after). A week is 2,000+ events.
        val old = events
        val full = old == null || now - lastFull > 5 * MINUTE
        val since = if (full) from else maxOf(from, now - 15 * MINUTE)
        runCatching { state.api.events(camFilter?.let { listOf(it) } ?: emptyList(), since, null, LIMIT) }
            .onSuccess { got ->
                val merged = if (full || old == null) got else {
                    val fresh = got.mapTo(HashSet()) { "${it.camera}/${it.id}" }
                    old.filter { it.start < since && "${it.camera}/${it.id}" !in fresh } + got
                }
                events = merged.sortedByDescending { e -> e.start }.also { l -> state.eventsCache[key] = l }
                if (full) lastFull = now
            }
    }
    LaunchedEffect(range, camFilter, asked) {
        events = state.eventsCache[key]
        lastFull = 0L
        while (true) {
            state.awaitVisible()
            load()
            delay(20_000)
        }
    }
    fun ask(q: String) {
        text = q
        asked = q.trim()
        focus.clearFocus()
    }

    // Worked out only when the list or a filter changes (not on every status refresh).
    val sized = remember(events, size) {
        val minPeak = when (size) { 1 -> 3.0; 2 -> 10.0; else -> 0.0 }
        events?.filter { it.peak >= minPeak }
    }
    val counts = remember(sized) {
        val c = mutableMapOf("all" to (sized?.size ?: 0), "motion" to 0, "person" to 0, "cat" to 0, "dog" to 0)
        sized?.forEach { e -> if (e.labels.isEmpty()) { if (e.scan == "done") c["motion"] = c["motion"]!! + 1 } else e.labels.forEach { c[it] = (c[it] ?: 0) + 1 } }
        c
    }
    val list = remember(sized, kind, whoFilter) {
        sized?.filter {
            when (kind) {
                "all" -> true
                "motion" -> it.scan == "done" && it.labels.isEmpty()
                else -> kind in it.labels
            } && (whoFilter == null || it.who.any { w -> w.person == whoFilter })
        }
    }
    // Back-to-back motion on one camera is one activity (a person walking through
    // trips the detector several times).
    val activities = remember(list) { list?.let { groupActivities(it) } }
    val grouped = remember(activities) { activities?.groupBy { startOfDay(it.start) }?.toSortedMap(compareByDescending { it }) }
    val pending = status?.detection?.backlog ?: 0

    PullToRefreshBox(refreshing, onRefresh = { scope.launch { refreshing = true; load(); refreshing = false } }, modifier = Modifier.fillMaxSize()) {
        LazyVerticalGrid(
            columns = GridCells.Adaptive(165.dp),
            state = grid,
            contentPadding = PaddingValues(start = 14.dp, end = 14.dp, top = padding.calculateTopPadding() + 8.dp, bottom = padding.calculateBottomPadding() + 16.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
            modifier = Modifier.fillMaxSize(),
        ) {
            item(span = { GridItemSpan(maxLineSpan) }) {
                Column {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("Events", style = MaterialTheme.typography.headlineMedium, modifier = Modifier.weight(1f))
                        if (activities != null) Text(
                            "${activities.size} activit${if (activities.size == 1) "y" else "ies"} · ${list?.size ?: 0}${if ((events?.size ?: 0) >= LIMIT) "+" else ""} events",
                            color = C.TextDim, fontSize = 13.sp,
                        )
                    }
                    Gap(12.dp)
                    // Search
                    Row(
                        Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(C.Glass).border(1.dp, C.GlassBorder, RoundedCornerShape(16.dp)).padding(horizontal = 12.dp, vertical = 11.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        if (searching) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = C.VioletLight)
                        else Icon(Icons.Rounded.Search, null, tint = C.TextDim, modifier = Modifier.size(20.dp))
                        Box(Modifier.weight(1f).padding(horizontal = 10.dp)) {
                            if (text.isEmpty()) Text("Search: \"person on the roof last night\"", color = C.TextFaint, fontSize = 14.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            BasicTextField(
                                text, { text = it },
                                singleLine = true,
                                textStyle = TextStyle(color = C.Text, fontSize = 14.sp),
                                cursorBrush = SolidColor(C.VioletLight),
                                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                                keyboardActions = KeyboardActions(onSearch = { ask(text) }),
                                modifier = Modifier.fillMaxWidth(),
                            )
                        }
                        if (text.isNotEmpty()) Icon(Icons.Rounded.Close, "Clear search", tint = C.TextDim, modifier = Modifier.size(20.dp).clip(CircleShape).combinedClickable(onClick = { ask("") }))
                    }
                    Gap(8.dp)
                    Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                        val q = parsed
                        if (asked.isNotBlank() && q != null) {
                            Text("Showing", color = C.TextFaint, fontSize = 12.sp)
                            q.chips.forEach { c ->
                                Text(c, color = C.VioletLight, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.clip(CircleShape).background(C.Violet.copy(alpha = 0.16f)).padding(horizontal = 10.dp, vertical = 4.dp))
                            }
                        } else {
                            Text("Try", color = C.TextFaint, fontSize = 12.sp)
                            EXAMPLES.forEach { ex ->
                                Text(ex, color = C.TextDim, fontSize = 12.sp, modifier = Modifier.clip(CircleShape).background(C.Glass).border(1.dp, C.GlassBorder, CircleShape).combinedClickable(onClick = { ask(ex) }).padding(horizontal = 10.dp, vertical = 4.dp))
                            }
                        }
                    }
                    Gap(10.dp)
                    // Who
                    Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Chip("All ${counts["all"]}", kind == "all") { kind = "all" }
                        LABEL_ORDER.forEach { l ->
                            val s = LABELS.getValue(l)
                            Chip("${s.plural} ${counts[l]}", kind == l, icon = s.icon) { kind = if (kind == l) "all" else l }
                        }
                        Chip("Motion only ${counts["motion"]}", kind == "motion", icon = Icons.Rounded.Bolt) { kind = if (kind == "motion") "all" else "motion" }
                    }
                    if (people.isNotEmpty()) {
                        Gap(8.dp)
                        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            people.forEach { p ->
                                val n = sized?.count { e -> e.who.any { it.person == p.id } }
                                Chip("${p.name}${if (n != null) " $n" else ""}", whoFilter == p.id, icon = Icons.Rounded.Person) { whoFilter = if (whoFilter == p.id) null else p.id }
                            }
                        }
                    }
                    if (asked.isBlank()) {
                        Gap(8.dp)
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
                    if (pending > 0) {
                        Gap(8.dp)
                        Text("$pending older events are still being checked for people and animals", color = C.TextFaint, fontSize = 12.sp)
                    }
                }
            }
            if (list == null) {
                items(6) { Shimmer(Modifier.fillMaxWidth().aspectRatio(16f / 11f).clip(RoundedCornerShape(16.dp))) }
            } else if (list.isEmpty()) {
                item(span = { GridItemSpan(maxLineSpan) }) {
                    EmptyState(
                        Icons.Rounded.Bolt,
                        when {
                            asked.isNotBlank() -> "Nothing found"
                            kind == "all" -> "No motion"
                            kind == "motion" -> "No plain motion"
                            else -> "No ${LABELS.getValue(kind).plural.lowercase()}"
                        },
                        if (asked.isNotBlank()) "Try fewer words, another day, or all cameras." else "Nothing matching on ${if (camFilter != null) names[camFilter] ?: "this camera" else "your cameras"} in this time.",
                    )
                }
            }
            grouped?.forEach { (day, evs) ->
                item(span = { GridItemSpan(maxLineSpan) }, key = "day-$day") {
                    Row(Modifier.padding(top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text(fmtDay(day, state.serverNow()), style = MaterialTheme.typography.titleMedium)
                        Text("  ${evs.size}", color = C.TextFaint, fontSize = 13.sp)
                    }
                }
                items(evs, key = { "${it.first.camera}/${it.first.id}" }) { a ->
                    EventCard(
                        state, a, names[a.first.camera] ?: a.first.camera, aspects[a.first.camera] ?: (16f / 9f),
                        watched = a.first.id == state.lastWatched,
                        onLongClick = if (state.isAdmin && a.shown.labels.isNotEmpty()) ({ wrongFor = a.shown }) else null,
                    ) {
                        // The player steps through this list; the list marks what was watched.
                        state.eventList = activities.orEmpty().map { x -> ListItem(x.first.camera, x.first.id, x.shown.bestTime - 2000) }
                        state.lastWatched = a.first.id
                        openEvent(ListItem(a.first.camera, a.first.id, a.shown.bestTime - 2000))
                    }
                }
            }
        }
    }
    wrongFor?.let { e ->
        AlertDialog(
            onDismissRequest = { wrongFor = null },
            title = { Text("Wrong label?") },
            text = { Text("If Sentinel got it wrong, remove the label. The camera learns that spot, so the same lookalike (laundry, a coat) isn't called a person again.") },
            confirmButton = {
                Column(horizontalAlignment = Alignment.End) {
                    e.labels.forEach { l ->
                        TextButton({
                            wrongFor = null
                            scope.launch {
                                runCatching { state.api.wrongLabel(e, l) }
                                    .onSuccess { n -> events = events?.map { if (it.id == n.id) n else it }; Toaster.show("Removed. Thanks, Sentinel learns from this.") }
                                    .onFailure { Toaster.error(it.message ?: "Couldn't remove it") }
                            }
                        }) { Text("Not a ${LABELS[l]?.name?.lowercase() ?: l}", color = C.RoseLight) }
                    }
                }
            },
            dismissButton = { TextButton({ wrongFor = null }) { Text("Cancel", color = C.TextDim) } },
            containerColor = C.Ink800,
        )
    }
}

private const val LIMIT = 3000

/** Motion on one camera with less than 90 s between events. */
private data class Activity(val events: List<SentinelEvent>) {
    val first get() = events.first() // the newest
    val start get() = events.minOf { it.start }
    val end get() = if (events.any { it.ongoing }) 0L else events.maxOf { it.end }
    val peak get() = events.maxOf { it.peak }
    val ongoing get() = events.any { it.ongoing }
    /** Who was seen in any of them. */
    val labels get() = LABEL_ORDER.filter { l -> events.any { l in it.labels } }
    /** The recognised people in any of them (by face beats by clothing). */
    val who get() = events.flatMap { it.who }.sortedBy { if (it.by == "face") 0 else 1 }.distinctBy { it.person }
    /** The event whose picture is shown: someone seen (a person first), else the newest. */
    val shown get() = LABEL_ORDER.firstNotNullOfOrNull { l -> events.firstOrNull { l in it.labels && it.snap } } ?: first
    val checked get() = events.all { it.checked }
}

private fun groupActivities(list: List<SentinelEvent>): List<Activity> {
    val out = ArrayList<Activity>()
    val open = HashMap<String, MutableList<SentinelEvent>>()
    // Newest first: an event joins its camera's current group if it ended within 90 s
    // of that group's oldest start.
    for (e in list.sortedByDescending { it.start }) {
        val g = open[e.camera]
        if (g != null && g.last().start - e.endOr(e.start) < 90_000 && g.first().start - e.start < 10 * 60_000) g += e
        else {
            val n = mutableListOf(e)
            open[e.camera] = n
            out += Activity(n)
        }
    }
    return out.sortedByDescending { it.first.start }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun EventCard(state: AppState, a: Activity, camName: String, aspect: Float, watched: Boolean, onLongClick: (() -> Unit)?, onClick: () -> Unit) {
    val e = a.shown
    val haptic = LocalHapticFeedback.current
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    Column(
        Modifier.scale(if (pressed) 0.97f else 1f).clip(RoundedCornerShape(16.dp)).combinedClickable(
            interaction, null, onClick = onClick,
            onLongClick = onLongClick?.let { f -> { haptic.performHapticFeedback(HapticFeedbackType.LongPress); f() } },
        ),
    ) {
        val ratio = aspect.coerceIn(1.2f, 2f)
        Box(Modifier.fillMaxWidth().aspectRatio(ratio).clip(RoundedCornerShape(16.dp)).border(if (watched) 2.dp else 1.dp, if (watched) C.VioletLight else C.GlassBorder, RoundedCornerShape(16.dp))) {
            // Boxes line up only when the card has the camera's shape.
            EventPicture(state.api, e, Modifier.fillMaxSize(), boxes = ratio == aspect)
            Box(Modifier.fillMaxWidth().height(44.dp).align(Alignment.BottomCenter).background(Brush.verticalGradient(listOf(Color.Transparent, Color(0xAA000000)))))
            Row(Modifier.align(Alignment.BottomStart).padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Rounded.PlayArrow, null, tint = Color.White, modifier = Modifier.size(16.dp))
                Text(if (a.ongoing) "now" else fmtDuration(a.end - a.start), color = Color.White, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
            }
            LabelChips(a.labels, Modifier.align(Alignment.TopStart).padding(7.dp), small = true, showMotion = true, checked = a.checked, who = a.who)
            Row(Modifier.align(Alignment.TopEnd).padding(7.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                if (a.events.size > 1) Text(
                    "×${a.events.size}", color = Color.White, fontSize = 10.sp, fontWeight = FontWeight.Bold,
                    modifier = Modifier.clip(RoundedCornerShape(6.dp)).background(Color(0xAA000000)).padding(horizontal = 5.dp, vertical = 2.dp),
                )
                if (a.ongoing) Text(
                    "LIVE", color = Color.Black, fontSize = 10.sp, fontWeight = FontWeight.Bold,
                    modifier = Modifier.clip(RoundedCornerShape(6.dp)).background(C.Amber).padding(horizontal = 5.dp, vertical = 2.dp),
                )
                else if (watched) Text(
                    "Last watched", color = Color.White, fontSize = 10.sp, fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.clip(RoundedCornerShape(6.dp)).background(C.Violet).padding(horizontal = 5.dp, vertical = 2.dp),
                )
            }
            // Motion strength
            Box(Modifier.align(Alignment.BottomEnd).padding(10.dp).size(width = 36.dp, height = 4.dp).clip(CircleShape).background(Color(0x55FFFFFF))) {
                Box(Modifier.fillMaxSize().fillMaxWidth((a.peak.toFloat() / 25f).coerceIn(0.08f, 1f)).clip(CircleShape).background(C.Amber))
            }
        }
        Row(Modifier.padding(top = 7.dp, start = 2.dp, end = 2.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(camName, color = C.Text, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            Text(if (a.events.size > 1) "${fmtTime(a.start)}–${fmtTime(if (a.ongoing) a.first.start else a.end)}" else fmtTime(a.start), color = C.TextDim, fontSize = 12.sp, maxLines = 1)
        }
    }
}
