package app.sentinel.ui.screens

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.Edit
import androidx.compose.material.icons.rounded.Face
import androidx.compose.material.icons.rounded.Person
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.sentinel.core.AppState
import app.sentinel.core.FaceGroup
import app.sentinel.core.FaceInfo
import app.sentinel.core.FaceStatus
import app.sentinel.core.PersonInfo
import app.sentinel.core.fmtDay
import app.sentinel.core.fmtTime
import app.sentinel.ui.components.Chip
import app.sentinel.ui.components.EmptyState
import app.sentinel.ui.components.Gap
import app.sentinel.ui.components.GlassCard
import app.sentinel.ui.components.GradientButton
import app.sentinel.ui.components.SectionTitle
import app.sentinel.ui.components.Shimmer
import app.sentinel.ui.components.SubtleButton
import app.sentinel.ui.components.Toaster
import app.sentinel.ui.theme.C
import coil3.compose.AsyncImage
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * People Sentinel recognises (by face on any camera, and the same day by their clothes),
 * and, for admins, faces it doesn't know yet, grouped by likeness: name a group once and
 * Sentinel recognises them from then on.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun PeopleScreen(state: AppState, onBack: () -> Unit, openCamera: (String, Long) -> Unit) {
    var people by remember { mutableStateOf<List<PersonInfo>?>(null) }
    var status by remember { mutableStateOf<FaceStatus?>(null) }
    var groups by remember { mutableStateOf<List<FaceGroup>?>(null) }
    var open by remember { mutableStateOf<PersonInfo?>(null) }
    val scope = rememberCoroutineScope()
    val admin = state.isAdmin
    val cams = state.status.value?.cameras.orEmpty().associate { it.id to it.name }

    suspend fun load() {
        runCatching { state.api.people() }.onSuccess { people = it.people; status = it.status; state.peopleCache = it.people }
        if (admin) runCatching { state.api.unknownFaces() }.onSuccess { groups = it }
    }
    LaunchedEffect(Unit) {
        while (true) {
            state.awaitVisible()
            load()
            delay(30_000)
        }
    }

    SubPage("People", onBack) {
        item {
            Text(
                "Sentinel recognises the people you name: by face on any camera, and on the same day by their clothes when a camera only sees them from above.",
                color = C.TextDim, fontSize = 13.sp,
            )
        }
        status?.let { st ->
            if (!st.enabled) item {
                Text(st.error?.let { "Face recognition isn't working: $it" } ?: "Face recognition is off (Sentinel Settings).", color = C.Amber, fontSize = 13.sp)
            } else if (st.backlog > 0) item {
                Text("Looking for faces in ${st.backlog} earlier events with people…", color = C.TextFaint, fontSize = 12.sp)
            }
        }
        item { SectionTitle("Known people", Modifier.padding(top = 6.dp)) }
        item {
            val list = people
            when {
                list == null -> Shimmer(Modifier.fillMaxWidth().padding(vertical = 4.dp).size(width = 1.dp, height = 120.dp).clip(RoundedCornerShape(18.dp)))
                list.isEmpty() -> Text(
                    if (admin) "Nobody yet. Name someone below and Sentinel starts recognising them." else "Nobody yet. An admin can name people in the app or on the Sentinel page.",
                    color = C.TextDim, fontSize = 13.sp,
                )
                else -> FlowRow(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    list.forEach { p -> PersonTile(state, p, cams) { open = p } }
                }
            }
        }
        if (admin) {
            item { SectionTitle("Who is this?", Modifier.padding(top = 10.dp)) }
            item {
                Text("Faces seen but not known yet, grouped by likeness (most seen first). Tap a face that doesn't belong to take it out, then name the group.", color = C.TextFaint, fontSize = 12.sp)
            }
            val g = groups
            if (g == null) item { Shimmer(Modifier.fillMaxWidth().size(width = 1.dp, height = 140.dp).clip(RoundedCornerShape(18.dp))) }
            else if (g.isEmpty()) item {
                EmptyState(Icons.Rounded.Face, "No new faces", if ((status?.faces ?: 0) > 0) "Every clear face seen so far has a name." else "Faces appear here as people walk past the cameras facing them.")
            }
            else {
                g.filter { it.size > 1 || it.suggest != null }.forEach { grp ->
                    item(key = grp.ids.first()) {
                        GroupCard(state, grp, people.orEmpty(), cams) { msg ->
                            Toaster.show(msg)
                            scope.launch { load() }
                        }
                    }
                }
                val once = g.filter { it.size == 1 && it.suggest == null }.mapNotNull { it.faces.firstOrNull() }
                if (once.isNotEmpty()) item(key = "once") {
                    Singles(state, once, people.orEmpty()) { msg ->
                        Toaster.show(msg)
                        scope.launch { load() }
                    }
                }
            }
        }
    }
    open?.let { p ->
        PersonSheet(state, p, admin, cams, onClose = { open = null }, onChanged = { scope.launch { load() } }, openCamera = openCamera)
    }
}

@Composable
private fun PersonTile(state: AppState, p: PersonInfo, cams: Map<String, String>, onClick: () -> Unit) {
    Column(
        Modifier.width(104.dp).clip(RoundedCornerShape(18.dp)).background(C.Glass).border(1.dp, C.GlassBorder, RoundedCornerShape(18.dp))
            .combinedClickableCompat(onClick).padding(10.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Avatar(state, p.cover, 64.dp)
        Gap(6.dp)
        Text(p.name, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text("${p.sightings} this week", color = C.TextFaint, fontSize = 11.sp)
        p.last?.let { Text(cams[it.cam] ?: it.cam, color = C.TextDim, fontSize = 10.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center) }
    }
}

@Composable
private fun Avatar(state: AppState, id: String?, size: Dp) {
    Box(Modifier.size(size).clip(CircleShape).background(Color(0x12FFFFFF)).border(2.dp, Color(0x22FFFFFF), CircleShape), contentAlignment = Alignment.Center) {
        if (id != null) AsyncImage(state.api.faceUrl(id), null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
        else Icon(Icons.Rounded.Person, null, tint = C.TextFaint, modifier = Modifier.size(size / 2))
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun FaceThumb(state: AppState, f: FaceInfo, dim: Boolean = false, badge: String? = null, badgeColor: Color = C.TextDim, onLongClick: (() -> Unit)? = null, onClick: () -> Unit) {
    val haptic = LocalHapticFeedback.current
    Box(
        Modifier.size(64.dp).clip(RoundedCornerShape(12.dp)).border(1.dp, C.GlassBorder, RoundedCornerShape(12.dp))
            .combinedClickable(onClick = onClick, onLongClick = onLongClick?.let { l -> { haptic.performHapticFeedback(HapticFeedbackType.LongPress); l() } }),
    ) {
        AsyncImage(state.api.faceUrl(f.id), null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize().alpha(if (dim) 0.25f else 1f))
        if (dim) Icon(Icons.Rounded.Close, null, tint = Color.White, modifier = Modifier.align(Alignment.Center).size(26.dp))
        if (badge != null) Text(
            badge, color = badgeColor, fontSize = 9.sp, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center,
            modifier = Modifier.align(Alignment.BottomCenter).fillMaxWidth().background(Color(0x99000000)),
        )
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun GroupCard(state: AppState, g: FaceGroup, people: List<PersonInfo>, cams: Map<String, String>, done: (String) -> Unit) {
    var left by remember(g.ids.first()) { mutableStateOf(setOf<String>()) }
    var name by remember(g.ids.first()) { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val ids = g.ids.filter { it !in left }
    fun save(person: String?, label: String) {
        if (ids.isEmpty()) return
        busy = true
        scope.launch {
            runCatching { state.api.nameFaces(ids, person = person, name = if (person == null) label else null) }
                .onSuccess { done("${ids.size} face${if (ids.size == 1) "" else "s"} named $label. Sentinel will recognise them from now on.") }
                .onFailure { Toaster.error(it.message ?: "Couldn't save") }
            busy = false
        }
    }
    GlassCard(Modifier.fillMaxWidth()) {
        Column {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                g.faces.forEach { f ->
                    FaceThumb(state, f, dim = f.id in left) { left = if (f.id in left) left - f.id else left + f.id }
                }
                if (g.size > g.faces.size) Box(Modifier.size(64.dp).clip(RoundedCornerShape(12.dp)).background(Color(0x12FFFFFF)), contentAlignment = Alignment.Center) {
                    Text("+${g.size - g.faces.size}", color = C.TextDim, fontSize = 13.sp)
                }
            }
            Gap(6.dp)
            val where = g.faces.map { cams[it.cam] ?: it.cam }.distinct().take(3).joinToString(", ")
            Text("${g.size} face${if (g.size == 1) "" else "s"} · $where${if (left.isNotEmpty()) " · ${left.size} taken out" else ""}", color = C.TextFaint, fontSize = 12.sp)
            Gap(10.dp)
            g.suggest?.let { s ->
                GradientButton("This is ${s.name}", Modifier.fillMaxWidth(), enabled = !busy && ids.isNotEmpty(), loading = busy, icon = Icons.Rounded.Check) { save(s.person, s.name) }
                Gap(8.dp)
            }
            Row(
                Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(C.Glass).border(1.dp, C.GlassBorder, RoundedCornerShape(14.dp)).padding(horizontal = 12.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(Modifier.weight(1f)) {
                    if (name.isEmpty()) Text(if (g.suggest != null) "Or someone else…" else "Who is this?", color = C.TextFaint, fontSize = 14.sp)
                    BasicTextField(
                        name, { name = it }, singleLine = true,
                        textStyle = TextStyle(color = C.Text, fontSize = 14.sp), cursorBrush = SolidColor(C.VioletLight),
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                        keyboardActions = KeyboardActions(onDone = { if (name.isNotBlank()) save(null, name.trim()) }),
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
                if (name.isNotBlank()) Text(
                    "Save", color = C.VioletLight, fontWeight = FontWeight.SemiBold, fontSize = 14.sp,
                    modifier = Modifier.clip(RoundedCornerShape(8.dp)).combinedClickableCompat { save(null, name.trim()) }.padding(horizontal = 8.dp, vertical = 4.dp),
                )
            }
            if (people.isNotEmpty()) {
                Gap(8.dp)
                Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    people.forEach { p -> Chip(p.name, false, icon = Icons.Rounded.Person) { save(p.id, p.name) } }
                }
            }
            Gap(8.dp)
            SubtleButton("Not a face", Modifier.fillMaxWidth(), icon = Icons.Rounded.Close, tint = C.TextDim) {
                busy = true
                scope.launch {
                    runCatching { state.api.notFaces(ids) }.onSuccess { done("Ignored. Similar ones won't show up again.") }.onFailure { Toaster.error(it.message ?: "Couldn't save") }
                    busy = false
                }
            }
        }
    }
}

/** Faces seen once: tap the ones of the same person, then name them together. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun Singles(state: AppState, faces: List<FaceInfo>, people: List<PersonInfo>, done: (String) -> Unit) {
    var picked by remember { mutableStateOf(setOf<String>()) }
    var name by remember { mutableStateOf("") }
    val scope = rememberCoroutineScope()
    fun save(person: String?, label: String) {
        val ids = picked.toList()
        if (ids.isEmpty()) return
        scope.launch {
            runCatching { state.api.nameFaces(ids, person = person, name = if (person == null) label else null) }
                .onSuccess { picked = emptySet(); name = ""; done("${ids.size} face${if (ids.size == 1) "" else "s"} named $label.") }
                .onFailure { Toaster.error(it.message ?: "Couldn't save") }
        }
    }
    GlassCard(Modifier.fillMaxWidth()) {
        Column {
            Text("Seen once", style = MaterialTheme.typography.titleSmall)
            Text("Tap the faces of one person (they may be seen from different angles), then name them together.", color = C.TextFaint, fontSize = 12.sp)
            Gap(10.dp)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                faces.forEach { f ->
                    Box(Modifier.border(2.dp, if (f.id in picked) C.VioletLight else Color.Transparent, RoundedCornerShape(14.dp)).padding(2.dp)) {
                        FaceThumb(state, f, badge = if (f.id in picked) "✓" else null, badgeColor = C.VioletLight) {
                            picked = if (f.id in picked) picked - f.id else picked + f.id
                        }
                    }
                }
            }
            if (picked.isNotEmpty()) {
                Gap(10.dp)
                Row(
                    Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(C.Glass).border(1.dp, C.GlassBorder, RoundedCornerShape(14.dp)).padding(horizontal = 12.dp, vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Box(Modifier.weight(1f)) {
                        if (name.isEmpty()) Text("Who is this? (${picked.size} picked)", color = C.TextFaint, fontSize = 14.sp)
                        BasicTextField(
                            name, { name = it }, singleLine = true,
                            textStyle = TextStyle(color = C.Text, fontSize = 14.sp), cursorBrush = SolidColor(C.VioletLight),
                            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                            keyboardActions = KeyboardActions(onDone = { if (name.isNotBlank()) save(null, name.trim()) }),
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                    if (name.isNotBlank()) Text(
                        "Save", color = C.VioletLight, fontWeight = FontWeight.SemiBold, fontSize = 14.sp,
                        modifier = Modifier.clip(RoundedCornerShape(8.dp)).combinedClickableCompat { save(null, name.trim()) }.padding(horizontal = 8.dp, vertical = 4.dp),
                    )
                }
                if (people.isNotEmpty()) {
                    Gap(8.dp)
                    Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        people.forEach { p -> Chip(p.name, false, icon = Icons.Rounded.Person) { save(p.id, p.name) } }
                    }
                }
                Gap(8.dp)
                SubtleButton("Not a face", Modifier.fillMaxWidth(), icon = Icons.Rounded.Close, tint = C.TextDim) {
                    val ids = picked.toList()
                    scope.launch {
                        runCatching { state.api.notFaces(ids) }.onSuccess { picked = emptySet(); done("Ignored.") }.onFailure { Toaster.error(it.message ?: "Couldn't save") }
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
private fun PersonSheet(state: AppState, p: PersonInfo, admin: Boolean, cams: Map<String, String>, onClose: () -> Unit, onChanged: () -> Unit, openCamera: (String, Long) -> Unit) {
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    var faces by remember { mutableStateOf<List<FaceInfo>?>(null) }
    var renaming by remember { mutableStateOf(false) }
    var newName by remember { mutableStateOf(p.name) }
    var confirmNot by remember { mutableStateOf<FaceInfo?>(null) }
    var confirmForget by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    LaunchedEffect(p.id) { faces = runCatching { state.api.personFaces(p.id) }.getOrDefault(emptyList()) }

    ModalBottomSheet(onDismissRequest = onClose, sheetState = sheet, containerColor = C.Ink850) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 18.dp).navigationBarsPadding().padding(bottom = 16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Avatar(state, p.cover, 56.dp)
                Column(Modifier.weight(1f).padding(horizontal = 12.dp)) {
                    Text(p.name, style = MaterialTheme.typography.titleLarge)
                    Text("${p.sightings} events this week · ${p.faces} faces", color = C.TextDim, fontSize = 12.sp)
                    p.last?.let { Text("Last: ${cams[it.cam] ?: it.cam}, ${fmtDay(it.t, state.serverNow())} ${fmtTime(it.t)}", color = C.TextFaint, fontSize = 12.sp) }
                }
                if (admin) Icon(Icons.Rounded.Edit, "Rename", tint = C.TextDim, modifier = Modifier.size(36.dp).clip(CircleShape).combinedClickableCompat { renaming = true }.padding(8.dp))
            }
            Gap(12.dp)
            Text(
                if (admin) "Faces taken for ${p.name}. Tap one to see that moment; press and hold one that isn't ${p.name} to take it out." else "Faces taken for ${p.name}. Tap one to see that moment.",
                color = C.TextFaint, fontSize = 12.sp,
            )
            Gap(10.dp)
            val list = faces
            if (list == null) Shimmer(Modifier.fillMaxWidth().size(width = 1.dp, height = 80.dp).clip(RoundedCornerShape(12.dp)))
            else FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                list.forEach { f ->
                    FaceThumb(
                        state, f,
                        badge = if (f.by == "you") "named" else "${(f.sim * 100).toInt()}%",
                        badgeColor = if (f.by == "you") C.Emerald else C.TextDim,
                        onLongClick = if (admin) ({ confirmNot = f }) else null,
                    ) { onClose(); openCamera(f.cam, f.t - 3000) }
                }
            }
            if (admin) {
                Gap(16.dp)
                SubtleButton("Forget ${p.name}", Modifier.fillMaxWidth(), tint = C.RoseLight) { confirmForget = true }
            }
        }
    }
    confirmNot?.let { f ->
        AlertDialog(
            onDismissRequest = { confirmNot = null },
            title = { Text("Not ${p.name}?") },
            text = { Text("This face is taken out, and Sentinel learns from it.") },
            confirmButton = {
                TextButton({
                    confirmNot = null
                    faces = faces?.filter { it.id != f.id }
                    scope.launch { runCatching { state.api.notPerson(listOf(f.id), p.id) }.onSuccess { onChanged() }.onFailure { Toaster.error(it.message ?: "Couldn't save") } }
                }) { Text("Not ${p.name}", color = C.RoseLight) }
            },
            dismissButton = { TextButton({ confirmNot = null }) { Text("Cancel", color = C.TextDim) } },
            containerColor = C.Ink800,
        )
    }
    if (renaming) AlertDialog(
        onDismissRequest = { renaming = false },
        title = { Text("Rename") },
        text = {
            BasicTextField(
                newName, { newName = it }, singleLine = true, textStyle = TextStyle(color = C.Text, fontSize = 16.sp), cursorBrush = SolidColor(C.VioletLight),
                modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(C.Glass).padding(12.dp),
            )
        },
        confirmButton = {
            TextButton({
                renaming = false
                scope.launch { runCatching { state.api.renamePerson(p.id, newName.trim()) }.onSuccess { onChanged(); onClose() }.onFailure { Toaster.error(it.message ?: "Couldn't rename") } }
            }) { Text("Save", color = C.VioletLight) }
        },
        dismissButton = { TextButton({ renaming = false }) { Text("Cancel", color = C.TextDim) } },
        containerColor = C.Ink800,
    )
    if (confirmForget) AlertDialog(
        onDismissRequest = { confirmForget = false },
        title = { Text("Forget ${p.name}?") },
        text = { Text("Their faces become unknown again. Nothing else is deleted.") },
        confirmButton = {
            TextButton({
                confirmForget = false
                scope.launch { runCatching { state.api.forgetPerson(p.id) }.onSuccess { onChanged(); onClose() }.onFailure { Toaster.error(it.message ?: "Couldn't do that") } }
            }) { Text("Forget", color = C.RoseLight) }
        },
        dismissButton = { TextButton({ confirmForget = false }) { Text("Cancel", color = C.TextDim) } },
        containerColor = C.Ink800,
    )
}

@OptIn(ExperimentalFoundationApi::class)
private fun Modifier.combinedClickableCompat(onClick: () -> Unit): Modifier = this.combinedClickable(onClick = onClick)
