package app.sentinel.ui.screens

import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.material.icons.rounded.VisibilityOff
import androidx.compose.material.icons.rounded.HelpOutline
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.AutoAwesome
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.Edit
import androidx.compose.material.icons.rounded.Face
import androidx.compose.material.icons.rounded.Person
import androidx.compose.material.icons.rounded.PersonOff
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.foundation.text.BasicTextField
import app.sentinel.core.AppState
import app.sentinel.core.FaceGroup
import app.sentinel.core.FaceInfo
import app.sentinel.core.FaceStatus
import app.sentinel.core.PersonInfo
import app.sentinel.core.SentinelEvent
import app.sentinel.core.fmtDay
import app.sentinel.core.fmtTime
import app.sentinel.ui.components.Backdrop
import app.sentinel.ui.components.EmptyState
import app.sentinel.ui.components.EventPicture
import app.sentinel.ui.components.FaceAction
import app.sentinel.ui.components.FaceViewer
import app.sentinel.ui.components.GlassCard
import app.sentinel.ui.components.GradientButton
import app.sentinel.ui.components.LabelChips
import app.sentinel.ui.components.NamePick
import app.sentinel.ui.components.NamePicker
import app.sentinel.ui.components.RoundIcon
import app.sentinel.ui.components.Shimmer
import app.sentinel.ui.components.SubtleButton
import app.sentinel.ui.components.Toaster
import app.sentinel.ui.theme.C
import coil3.compose.AsyncImage
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** Faces the viewer is showing, and where they come from (for its actions). */
private data class Viewing(val faces: List<FaceInfo>, val index: Int, val group: FaceGroup? = null)

/**
 * People Sentinel recognises (by face on any camera, and the same day by their clothes),
 * and faces it doesn't know yet: tap a face to see it large and name it there; tick faces
 * to name several at once.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun PeopleScreen(state: AppState, onBack: () -> Unit, openCamera: (String, Long) -> Unit, openPerson: (String) -> Unit) {
    var people by remember { mutableStateOf<List<PersonInfo>?>(null) }
    var status by remember { mutableStateOf<FaceStatus?>(null) }
    var groups by remember { mutableStateOf<List<FaceGroup>?>(null) }
    var tab by rememberSaveable { mutableStateOf<String?>(null) }
    var picked by remember { mutableStateOf(setOf<String>()) }
    var out by remember { mutableStateOf(setOf<String>()) }
    var viewing by remember { mutableStateOf<Viewing?>(null) }
    val scope = rememberCoroutineScope()
    val admin = state.isAdmin

    suspend fun load() {
        runCatching { state.api.people() }.onSuccess { people = it.people; status = it.status; state.peopleCache = it.people }
        if (admin) runCatching { state.api.unknownFaces() }.onSuccess { g -> groups = g; val all = g.flatMap { it.ids }.toSet(); picked = picked.filter { it in all }.toSet() }
        else groups = emptyList()
    }
    LaunchedEffect(Unit) {
        while (true) {
            state.awaitVisible()
            load()
            delay(30_000)
        }
    }
    val acts = remember { FaceActs(state) { scope.launch { load() } } }
    val g = groups.orEmpty()
    val toName = g.sumOf { it.size }
    val current = tab ?: if (!admin || (people.orEmpty().isNotEmpty() && toName == 0)) "known" else "name"
    val multi = g.filter { it.size > 1 }
    val maybe = g.filter { it.size == 1 && it.suggest != null }
    val once = g.filter { it.size == 1 && it.suggest == null }.flatMap { it.faces }

    Backdrop {
        Column(Modifier.fillMaxSize().statusBarsPadding()) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                RoundIcon(Icons.AutoMirrored.Rounded.ArrowBack, "Back", size = 40.dp, background = Color(0x10FFFFFF), onClick = onBack)
                Text("People", style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f).padding(horizontal = 12.dp))
            }
            if (admin) Row(Modifier.padding(horizontal = 14.dp).clip(RoundedCornerShape(14.dp)).background(C.Glass).padding(4.dp)) {
                listOf("name" to "To name · $toName", "known" to "Known · ${people?.size ?: 0}").forEach { (k, label) ->
                    Text(
                        label, color = if (current == k) Color.White else C.TextDim, fontSize = 14.sp, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center,
                        modifier = Modifier.weight(1f).clip(RoundedCornerShape(10.dp)).background(if (current == k) Color(0x22FFFFFF) else Color.Transparent).clickable { tab = k }.padding(vertical = 9.dp),
                    )
                }
            }
            status?.let { st ->
                val note = when {
                    !st.enabled -> st.error?.let { "Face recognition isn't working: $it" } ?: "Face recognition is off (Sentinel Settings)."
                    st.backlog > 0 -> "Looking for faces in ${st.backlog} earlier events…"
                    else -> null
                }
                if (note != null) Text(note, color = if (st.enabled) C.TextFaint else C.Amber, fontSize = 12.sp, modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp))
            }
            Box(Modifier.weight(1f)) {
                if (current == "known") KnownGrid(state, people, openPerson)
                else LazyVerticalGrid(
                    GridCells.Adaptive(96.dp),
                    contentPadding = PaddingValues(start = 14.dp, end = 14.dp, top = 10.dp, bottom = 120.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                    modifier = Modifier.fillMaxSize(),
                ) {
                    val full: androidx.compose.foundation.lazy.grid.LazyGridItemSpanScope.() -> GridItemSpan = { GridItemSpan(maxLineSpan) }
                    if (groups == null) items(12) { Shimmer(Modifier.aspectRatio(1f).clip(RoundedCornerShape(16.dp))) }
                    else if (g.isEmpty()) item(span = full) {
                        EmptyState(Icons.Rounded.Face, "Everyone has a name", "New faces show up here as people walk past the cameras.")
                    }
                    multi.forEach { grp ->
                        item(key = "g-${grp.ids.first()}", span = full) {
                            GroupCard(state, grp, people.orEmpty(), out, { id -> out = if (id in out) out - id else out + id }, acts) { i -> viewing = Viewing(grp.faces, i, grp) }
                        }
                    }
                    if (maybe.isNotEmpty()) {
                        item(key = "maybe-title", span = full) {
                            Column(Modifier.padding(top = 10.dp)) {
                                Text("Might be someone you know · ${maybe.size}", color = C.Text, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
                                Text("Each looks like someone you named, but not enough to be sure.", color = C.TextFaint, fontSize = 12.sp)
                            }
                        }
                        items(maybe, key = { "m-${it.ids.first()}" }) { grp ->
                            val s = grp.suggest!!
                            Column(Modifier.clip(RoundedCornerShape(16.dp)).background(C.Ink850).border(1.dp, C.GlassBorder, RoundedCornerShape(16.dp))) {
                                FaceTile(state, grp.faces.first(), onOpen = { viewing = Viewing(maybe.map { it.faces.first() }, maybe.indexOf(grp)) })
                                Text("${s.name}?", color = C.Text, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth().padding(top = 6.dp))
                                Row(Modifier.padding(6.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                    Icon(Icons.Rounded.Check, "Yes, ${s.name}", tint = C.Emerald, modifier = Modifier.weight(1f).clip(RoundedCornerShape(10.dp)).background(C.Emerald.copy(alpha = 0.15f)).clickable { acts.name(grp.ids, NamePick(person = s.person, label = s.name)) }.padding(6.dp))
                                    Icon(Icons.Rounded.Close, "Not ${s.name}", tint = C.TextDim, modifier = Modifier.weight(1f).clip(RoundedCornerShape(10.dp)).background(Color(0x12FFFFFF)).clickable { acts.not(grp.ids, s.person, s.name) }.padding(6.dp))
                                }
                            }
                        }
                    }
                    if (once.isNotEmpty()) {
                        item(key = "once-title", span = full) {
                            Column(Modifier.padding(top = 10.dp)) {
                                Text("Seen once · ${once.size}", color = C.Text, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
                                Text("Tap a face to see it large. Tick the ones of one person, then name them together.", color = C.TextFaint, fontSize = 12.sp)
                            }
                        }
                        items(once, key = { "o-${it.id}" }) { f ->
                            FaceTile(state, f, picked = f.id in picked, onToggle = { picked = if (f.id in picked) picked - f.id else picked + f.id }) {
                                viewing = Viewing(once, once.indexOf(f))
                            }
                        }
                    }
                }
                // Selection bar
                androidx.compose.animation.AnimatedVisibility(picked.isNotEmpty(), Modifier.align(Alignment.BottomCenter), enter = slideInVertically { it }, exit = slideOutVertically { it }) {
                    Column(
                        Modifier.fillMaxWidth().clip(RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp)).background(C.Ink850).border(1.dp, C.GlassBorder, RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp))
                            .navigationBarsPadding().padding(14.dp),
                    ) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text("${picked.size} selected", color = C.Text, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                            Icon(Icons.Rounded.Close, "Clear", tint = C.TextDim, modifier = Modifier.size(36.dp).clip(CircleShape).clickable { picked = emptySet() }.padding(8.dp))
                        }
                        Row(Modifier.horizontalScroll(rememberScrollState()).padding(bottom = 8.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            SmallAction("Don't know them", Icons.Rounded.HelpOutline, C.Text) { acts.stranger(picked.toList()) { picked = emptySet() } }
                            SmallAction("Don't name", Icons.Rounded.VisibilityOff, C.Text) { acts.hide(picked.toList()) { picked = emptySet() } }
                            SmallAction("Not faces", Icons.Rounded.Close, C.RoseLight) { acts.junk(picked.toList()) { picked = emptySet() } }
                        }
                        NamePicker(people.orEmpty(), "Name them…", state = state) { p -> acts.name(picked.toList(), p) { picked = emptySet() } }
                    }
                }
            }
        }
    }

    viewing?.let { v ->
        FaceViewer(
            state, v.faces, v.index, onClose = { viewing = null }, people = people.orEmpty(),
            title = v.group?.let { "Likely the same person · ${it.size} faces" },
            onName = { f, p -> acts.name(listOf(f.id), p) { viewing = null } },
            actions = { f ->
                val m = g.find { it.size == 1 && it.suggest != null && it.ids.first() == f.id }?.suggest
                buildList {
                    if (m != null) {
                        add(FaceAction("Yes, ${m.name}", Icons.Rounded.Check) { acts.name(listOf(it.id), NamePick(person = m.person, label = m.name)) { viewing = null } })
                        add(FaceAction("Not ${m.name}", Icons.Rounded.PersonOff) { acts.not(listOf(it.id), m.person, m.name) { viewing = null } })
                    }
                    if (v.group != null) add(FaceAction(if (f.id in out) "Put back in the group" else "Not the same person", Icons.Rounded.PersonOff) { out = if (it.id in out) out - it.id else out + it.id })
                    add(FaceAction("Someone I don't know", Icons.Rounded.HelpOutline) { acts.stranger(listOf(it.id)) { viewing = null } })
                    add(FaceAction("Don't name", Icons.Rounded.VisibilityOff) { acts.hide(listOf(it.id)) { viewing = null } })
                    add(FaceAction("Not a face", Icons.Rounded.Close, danger = true) { acts.junk(listOf(it.id)) { viewing = null } })
                }
            },
            onWatch = { viewing = null; openCamera(it.cam, it.t - 3000) },
        )
    }
}

/** Naming and fixing faces, with a message and a reload after. */
private class FaceActs(val state: AppState, val reload: () -> Unit) {
    private val scope = kotlinx.coroutines.MainScope()
    private fun run(block: suspend () -> Unit, msg: String, after: () -> Unit, undo: List<String>? = null) {
        scope.launch {
            runCatching { block() }.onSuccess {
                if (undo != null) Toaster.show(msg, "Undo") {
                    scope.launch { runCatching { state.api.restoreFaces(undo) }.onSuccess { Toaster.show("Undone"); reload() }.onFailure { e -> Toaster.error(e.message ?: "Couldn't undo") } }
                } else Toaster.show(msg)
                after()
                reload()
            }.onFailure { Toaster.error(it.message ?: "Couldn't save") }
        }
    }
    private fun n(ids: List<String>) = "${ids.size} face${if (ids.size == 1) "" else "s"}"
    fun name(ids: List<String>, p: NamePick, after: () -> Unit = {}) =
        run({ state.api.nameFaces(ids, person = p.person, name = p.name) }, "${n(ids)} named ${p.label}.", after, ids)
    fun not(ids: List<String>, person: String, name: String, after: () -> Unit = {}) = run({ state.api.notPerson(ids, person) }, "Not $name: Sentinel learns from it.", after)
    fun junk(ids: List<String>, after: () -> Unit = {}) = run({ state.api.notFaces(ids) }, "${n(ids)} ignored.", after, ids)
    fun hide(ids: List<String>, after: () -> Unit = {}) = run({ state.api.hideFaces(ids) }, "Hidden, with faces like them.", after, ids)
    fun stranger(ids: List<String>, after: () -> Unit = {}) = run({ state.api.strangerFaces(ids) }, "Kept as an unknown person.", after, ids)
}

@Composable
private fun FaceTile(state: AppState, f: FaceInfo, picked: Boolean = false, dim: Boolean = false, ring: Boolean = true, onToggle: (() -> Unit)? = null, onOpen: () -> Unit) {
    Box(
        Modifier.aspectRatio(1f).clip(RoundedCornerShape(16.dp)).background(C.Ink850)
            .border(if (picked && ring) 2.dp else 1.dp, if (picked && ring) C.VioletLight else C.GlassBorder, RoundedCornerShape(16.dp)).clickable(onClick = onOpen),
    ) {
        AsyncImage(state.api.faceUrl(f.id), null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize().alpha(if (dim) 0.3f else 1f))
        if (dim) Text("Left out", color = Color.White, fontSize = 11.sp, fontWeight = FontWeight.Bold, modifier = Modifier.align(Alignment.Center))
        if (onToggle != null) Box(
            Modifier.align(Alignment.TopStart).padding(4.dp).size(30.dp).clip(CircleShape).clickable(onClick = onToggle).padding(4.dp),
            contentAlignment = Alignment.Center,
        ) {
            Box(
                Modifier.size(22.dp).clip(CircleShape).background(if (picked) C.Violet else Color(0x66000000)).border(2.dp, if (picked) C.VioletLight else Color.White.copy(alpha = 0.85f), CircleShape),
                contentAlignment = Alignment.Center,
            ) { if (picked) Icon(Icons.Rounded.Check, null, tint = Color.White, modifier = Modifier.size(14.dp)) }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun GroupCard(state: AppState, g: FaceGroup, people: List<PersonInfo>, out: Set<String>, toggle: (String) -> Unit, acts: FaceActs, open: (Int) -> Unit) {
    val cams = state.status.value?.cameras.orEmpty().associate { it.id to it.name }
    var all by remember { mutableStateOf(false) }
    val ids = g.ids.filter { it !in out }
    val shown = if (all) g.faces else g.faces.take(8)
    GlassCard(Modifier.fillMaxWidth()) {
        Column {
            Text("Likely the same person · ${g.size} faces", color = C.Text, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
            Text(
                "${g.cams.joinToString(", ") { cams[it] ?: it }} · last seen ${fmtDay(g.last, state.serverNow())} ${fmtTime(g.last)}${if (g.size - ids.size > 0) " · ${g.size - ids.size} left out" else ""}",
                color = C.TextFaint, fontSize = 12.sp,
            )
            androidx.compose.foundation.layout.Spacer(Modifier.height(10.dp))
            // Four to a row, always the same size (a flowing row wrapped early and stretched
            // the last face across the card).
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                shown.chunked(4).forEachIndexed { r, row ->
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        row.forEachIndexed { c, f ->
                            Box(Modifier.weight(1f)) {
                                FaceTile(state, f, picked = f.id !in out, dim = f.id in out, ring = false, onToggle = { toggle(f.id) }) { open(r * 4 + c) }
                            }
                        }
                        repeat(4 - row.size) { Box(Modifier.weight(1f)) }
                    }
                }
            }
            if (g.faces.size > shown.size) Text(
                "Show all ${g.faces.size}", color = C.VioletLight, fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
                modifier = Modifier.padding(top = 6.dp).clip(RoundedCornerShape(8.dp)).clickable { all = true }.padding(4.dp),
            )
            androidx.compose.foundation.layout.Spacer(Modifier.height(10.dp))
            g.suggest?.let { s ->
                GradientButton("This is ${s.name}", Modifier.fillMaxWidth(), enabled = ids.isNotEmpty(), icon = Icons.Rounded.AutoAwesome) { acts.name(ids, NamePick(person = s.person, label = s.name)) }
                androidx.compose.foundation.layout.Spacer(Modifier.height(8.dp))
            }
            NamePicker(people, if (g.suggest != null) "Or someone else…" else "Who is this? (${ids.size} faces)", state = state) { p -> acts.name(ids, p) }
            androidx.compose.foundation.layout.Spacer(Modifier.height(8.dp))
            Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                SmallAction("Someone I don't know", Icons.Rounded.HelpOutline, C.Text) { acts.stranger(ids) }
                SmallAction("Don't name", Icons.Rounded.VisibilityOff, C.Text) { acts.hide(ids) }
                SmallAction("Not faces", Icons.Rounded.Close, C.RoseLight) { acts.junk(ids) }
            }
        }
    }
}

@Composable
private fun KnownGrid(state: AppState, people: List<PersonInfo>?, openPerson: (String) -> Unit) {
    val cams = state.status.value?.cameras.orEmpty().associate { it.id to it.name }
    LazyVerticalGrid(
        GridCells.Adaptive(150.dp),
        contentPadding = PaddingValues(14.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
        modifier = Modifier.fillMaxSize(),
    ) {
        when {
            people == null -> items(6) { Shimmer(Modifier.aspectRatio(0.8f).clip(RoundedCornerShape(22.dp))) }
            people.isEmpty() -> item(span = { GridItemSpan(maxLineSpan) }) {
                EmptyState(Icons.Rounded.Person, "Nobody named yet", if (state.isAdmin) "Name a face under “To name” and Sentinel starts recognising that person." else "An admin can name people in the app or on the Sentinel page.")
            }
            else -> items(people.sortedBy { it.unnamed }, key = { it.id }) { p ->
                Column(Modifier.clip(RoundedCornerShape(22.dp)).background(C.Ink850).border(1.dp, C.GlassBorder, RoundedCornerShape(22.dp)).clickable { openPerson(p.id) }) {
                    Box(Modifier.fillMaxWidth().aspectRatio(1f)) {
                        if (p.cover != null) AsyncImage(state.api.faceUrl(p.cover), null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
                        else Icon(Icons.Rounded.Person, null, tint = C.TextFaint, modifier = Modifier.fillMaxSize().padding(36.dp))
                        Column(Modifier.align(Alignment.BottomStart).fillMaxWidth().background(Brush.verticalGradient(listOf(Color.Transparent, Color(0xDD000000)))).padding(10.dp)) {
                            if (p.unnamed) Text("NOT NAMED", color = C.Amber, fontSize = 9.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.sp)
                            Text(p.name, color = Color.White, fontSize = 17.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text("${p.sightings} events this week", color = Color.White.copy(alpha = 0.75f), fontSize = 11.sp)
                        }
                    }
                    Text(
                        p.last?.let { "Last: ${cams[it.cam] ?: it.cam}, ${fmtDay(it.t, state.serverNow())} ${fmtTime(it.t)}" } ?: "Not seen this week",
                        color = C.TextDim, fontSize = 11.sp, maxLines = 2, modifier = Modifier.padding(10.dp),
                    )
                }
            }
        }
    }
}

/** One person: where they were seen lately, and the faces taken for them. */
@Composable
fun PersonScreen(state: AppState, id: String, onBack: () -> Unit, openCamera: (String, Long) -> Unit) {
    var people by remember { mutableStateOf(state.peopleCache) }
    var faces by remember { mutableStateOf<List<FaceInfo>?>(null) }
    var events by remember { mutableStateOf<List<SentinelEvent>?>(null) }
    var viewing by remember { mutableStateOf<Int?>(null) }
    var renaming by remember { mutableStateOf(false) }
    var confirmForget by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val admin = state.isAdmin
    val cams = state.status.value?.cameras.orEmpty().associate { it.id to it.name }
    suspend fun load() {
        runCatching { state.api.people().people }.onSuccess { people = it; state.peopleCache = it }
        runCatching { state.api.personFaces(id, 300) }.onSuccess { faces = it }
        runCatching { state.api.personEvents(id) }.onSuccess { events = it }
    }
    LaunchedEffect(id) { load() }
    val acts = remember { FaceActs(state) { scope.launch { load() } } }
    val p = people.find { it.id == id }

    Backdrop {
        Column(Modifier.fillMaxSize().statusBarsPadding()) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                RoundIcon(Icons.AutoMirrored.Rounded.ArrowBack, "Back", size = 40.dp, background = Color(0x10FFFFFF), onClick = onBack)
                Text(p?.name ?: "", style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f).padding(horizontal = 12.dp), maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (admin && p != null) RoundIcon(Icons.Rounded.Edit, "Rename", size = 40.dp, background = Color(0x10FFFFFF)) { renaming = true }
            }
            LazyVerticalGrid(
                GridCells.Adaptive(96.dp),
                contentPadding = PaddingValues(start = 14.dp, end = 14.dp, top = 6.dp, bottom = 40.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
                modifier = Modifier.fillMaxSize().navigationBarsPadding(),
            ) {
                item(span = { GridItemSpan(maxLineSpan) }) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        if (p?.cover != null) AsyncImage(state.api.faceUrl(p.cover), null, contentScale = ContentScale.Crop, modifier = Modifier.size(92.dp).clip(RoundedCornerShape(24.dp)))
                        Column(Modifier.padding(start = 14.dp)) {
                            Text(p?.name ?: "…", style = MaterialTheme.typography.headlineSmall)
                            p?.let {
                                Text("${it.sightings} events this week · ${it.faces} known faces", color = C.TextDim, fontSize = 13.sp)
                                it.last?.let { l -> Text("Last seen: ${cams[l.cam] ?: l.cam}, ${fmtDay(l.t, state.serverNow())} ${fmtTime(l.t)}", color = C.TextFaint, fontSize = 12.sp) }
                            }
                        }
                    }
                }
                item(span = { GridItemSpan(maxLineSpan) }) { Text("Recent sightings", color = C.Text, fontSize = 16.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 12.dp)) }
                item(span = { GridItemSpan(maxLineSpan) }) {
                    val ev = events
                    when {
                        ev == null -> Shimmer(Modifier.fillMaxWidth().height(120.dp).clip(RoundedCornerShape(16.dp)))
                        ev.isEmpty() -> Text("No events with ${p?.name ?: "them"} this week.", color = C.TextDim, fontSize = 13.sp)
                        else -> Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            ev.forEach { e ->
                                Column(Modifier.width(200.dp).clip(RoundedCornerShape(16.dp)).clickable { openCamera(e.camera, e.bestTime - 3000) }) {
                                    Box(Modifier.fillMaxWidth().aspectRatio(16f / 9f).clip(RoundedCornerShape(16.dp))) {
                                        EventPicture(state.api, e, Modifier.matchParentSize())
                                        LabelChips(e.labels, Modifier.align(Alignment.BottomStart).padding(6.dp), small = true, who = e.who)
                                    }
                                    Text("${cams[e.camera] ?: e.camera} · ${fmtDay(e.start, state.serverNow())} ${fmtTime(e.start)}", color = C.TextDim, fontSize = 12.sp, modifier = Modifier.padding(top = 5.dp, start = 2.dp))
                                }
                            }
                        }
                    }
                }
                item(span = { GridItemSpan(maxLineSpan) }) {
                    Column(Modifier.padding(top = 12.dp)) {
                        Text("Faces · ${faces?.size ?: 0}", color = C.Text, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
                        Text(if (admin) "Tap a face to check it; take out any that isn't ${p?.name ?: "them"}." else "Tap a face to see it large.", color = C.TextFaint, fontSize = 12.sp)
                    }
                }
                val list = faces
                if (list == null) items(8) { Shimmer(Modifier.aspectRatio(1f).clip(RoundedCornerShape(16.dp))) }
                else items(list, key = { it.id }) { f ->
                    Box {
                        FaceTile(state, f) { viewing = list.indexOf(f) }
                        Text(
                            if (f.by == "you") "Named" else "${(f.sim * 100).toInt()}%", color = Color.White, fontSize = 9.sp, fontWeight = FontWeight.Bold,
                            modifier = Modifier.align(Alignment.BottomEnd).padding(5.dp).clip(RoundedCornerShape(6.dp)).background(if (f.by == "you") C.Emerald else Color(0x99000000)).padding(horizontal = 5.dp, vertical = 2.dp),
                        )
                    }
                }
                if (admin && p != null) item(span = { GridItemSpan(maxLineSpan) }) {
                    SubtleButton("Forget ${p.name}", Modifier.fillMaxWidth().padding(top = 16.dp), tint = C.RoseLight) { confirmForget = true }
                }
            }
        }
    }
    viewing?.let { i ->
        val list = faces.orEmpty()
        FaceViewer(
            state, list, i, onClose = { viewing = null }, people = if (admin) people else emptyList(), title = p?.name,
            onName = if (admin) ({ f, pick -> acts.name(listOf(f.id), pick) { if (pick.person != id) viewing = null } }) else null,
            actions = { if (admin && p != null) listOf(FaceAction("Not ${p.name}", Icons.Rounded.PersonOff, danger = true) { f -> acts.not(listOf(f.id), p.id, p.name) { viewing = null } }) else emptyList() },
            onWatch = { viewing = null; openCamera(it.cam, it.t - 3000) },
        )
    }
    if (renaming && p != null) {
        var name by remember { mutableStateOf(p.name) }
        AlertDialog(
            onDismissRequest = { renaming = false },
            title = { Text("Rename") },
            text = {
                BasicTextField(
                    name, { name = it }, singleLine = true, textStyle = TextStyle(color = C.Text, fontSize = 16.sp), cursorBrush = SolidColor(C.VioletLight),
                    modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(C.Glass).padding(12.dp),
                )
            },
            confirmButton = {
                TextButton({
                    renaming = false
                    scope.launch { runCatching { state.api.renamePerson(id, name.trim()) }.onSuccess { load() }.onFailure { Toaster.error(it.message ?: "Couldn't rename") } }
                }) { Text("Save", color = C.VioletLight) }
            },
            dismissButton = { TextButton({ renaming = false }) { Text("Cancel", color = C.TextDim) } },
            containerColor = C.Ink800,
        )
    }
    if (confirmForget && p != null) AlertDialog(
        onDismissRequest = { confirmForget = false },
        title = { Text("Forget ${p.name}?") },
        text = { Text("Their faces go back to “To name”. Nothing else is deleted.") },
        confirmButton = {
            TextButton({
                confirmForget = false
                scope.launch { runCatching { state.api.forgetPerson(id) }.onSuccess { onBack() }.onFailure { Toaster.error(it.message ?: "Couldn't do that") } }
            }) { Text("Forget", color = C.RoseLight) }
        },
        dismissButton = { TextButton({ confirmForget = false }) { Text("Cancel", color = C.TextDim) } },
        containerColor = C.Ink800,
    )
}

/** The faces in the event being watched, with who they are; tap one to see it large and name it. */
@Composable
fun EventPeopleStrip(state: AppState, cam: String, eventId: String?, openCamera: (String, Long) -> Unit) {
    var faces by remember { mutableStateOf<List<FaceInfo>>(emptyList()) }
    var viewing by remember { mutableStateOf<Int?>(null) }
    val scope = rememberCoroutineScope()
    suspend fun load() {
        faces = if (eventId == null) emptyList() else runCatching { state.api.eventFaces(cam, eventId) }.getOrDefault(emptyList())
    }
    LaunchedEffect(cam, eventId) { load() }
    val acts = remember { FaceActs(state) { scope.launch { load() } } }
    val shown = faces.filterIndexed { i, f -> f.person == null || faces.indexOfFirst { it.person == f.person } == i }.take(8)
    if (shown.isEmpty()) return
    Row(
        Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(vertical = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.Rounded.Face, null, tint = C.TextFaint, modifier = Modifier.size(18.dp))
        shown.forEachIndexed { i, f ->
            Row(
                Modifier.clip(CircleShape).background(C.Glass).border(1.dp, C.GlassBorder, CircleShape).clickable { viewing = i }.padding(start = 3.dp, end = 12.dp, top = 3.dp, bottom = 3.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                AsyncImage(state.api.faceUrl(f.id), null, contentScale = ContentScale.Crop, modifier = Modifier.size(30.dp).clip(CircleShape))
                Text("  ${f.name ?: "Who is this?"}", color = if (f.name != null) C.Text else C.VioletLight, fontSize = 13.sp, fontWeight = FontWeight.Medium)
            }
        }
    }
    viewing?.let { i ->
        val admin = state.isAdmin
        FaceViewer(
            state, shown, i, onClose = { viewing = null }, people = if (admin) state.peopleCache else emptyList(),
            onName = if (admin) ({ f, p -> acts.name(listOf(f.id), p) { viewing = null } }) else null,
            actions = { f ->
                if (!admin) emptyList() else buildList {
                    if (f.person != null) add(FaceAction("Not ${f.name}", Icons.Rounded.PersonOff, danger = true) { acts.not(listOf(it.id), it.person!!, it.name ?: "them") { viewing = null } })
                    add(FaceAction("Not a face", Icons.Rounded.Close, danger = true) { acts.junk(listOf(it.id)) { viewing = null } })
                }
            },
        )
    }
}

@Composable
private fun SmallAction(text: String, icon: ImageVector, tint: Color, onClick: () -> Unit) {
    Row(
        Modifier.clip(CircleShape).border(1.dp, C.GlassBorder, CircleShape).clickable(onClick = onClick).padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, null, tint = tint, modifier = Modifier.size(15.dp))
        Text("  $text", color = tint, fontSize = 13.sp, fontWeight = FontWeight.Medium)
    }
}
