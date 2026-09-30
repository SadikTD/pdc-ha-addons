package app.sentinel.ui.components

import coil3.compose.LocalPlatformContext
import coil3.request.ImageRequest
import coil3.size.Size as CoilSize
import androidx.compose.ui.layout.layout
import androidx.compose.ui.unit.Constraints
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.Fullscreen
import androidx.compose.material.icons.rounded.FullscreenExit
import androidx.compose.material.icons.rounded.Person
import androidx.compose.material.icons.rounded.PlayCircle
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import app.sentinel.core.AppState
import app.sentinel.core.FaceInfo
import app.sentinel.core.PersonInfo
import app.sentinel.core.Box as NBox
import app.sentinel.core.fmtDay
import app.sentinel.core.fmtTimeSec
import app.sentinel.ui.theme.C
import coil3.compose.AsyncImage
import coil3.compose.AsyncImagePainter

/** Something to do with the face on screen. */
data class FaceAction(val label: String, val icon: ImageVector, val danger: Boolean = false, val onClick: (FaceInfo) -> Unit)

/** Naming: pick someone Sentinel knows, or a new name. */
data class NamePick(val person: String? = null, val name: String? = null, val label: String)

/**
 * A face in full quality: the frame it was taken from (straight from the recording), zoomed
 * in on the person with the face outlined; "Whole picture" zooms out. Swipe for the other
 * faces; name the face (or do something else with it) underneath.
 */
@Composable
fun FaceViewer(
    state: AppState,
    faces: List<FaceInfo>,
    start: Int,
    onClose: () -> Unit,
    people: List<PersonInfo> = emptyList(),
    title: String? = null,
    onName: ((FaceInfo, NamePick) -> Unit)? = null,
    actions: (FaceInfo) -> List<FaceAction> = { emptyList() },
    onWatch: ((FaceInfo) -> Unit)? = null,
) {
    if (faces.isEmpty()) return
    val pager = rememberPagerState(initialPage = start.coerceIn(0, faces.lastIndex)) { faces.size }
    var whole by remember { mutableStateOf(false) }
    val cams = state.status.value?.cameras.orEmpty().associate { it.id to it.name }
    Dialog(onDismissRequest = onClose, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        Column(Modifier.fillMaxSize().background(Color.Black)) {
            val f = faces[pager.currentPage.coerceIn(0, faces.lastIndex)]
            // Top bar
            Row(Modifier.fillMaxWidth().statusBarsPadding().padding(horizontal = 10.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                RoundIcon(Icons.Rounded.Close, "Close", size = 40.dp, background = Color(0x22FFFFFF), onClick = onClose)
                Column(Modifier.weight(1f).padding(horizontal = 10.dp)) {
                    Text(title ?: (cams[f.cam] ?: f.cam), color = Color.White, fontWeight = FontWeight.SemiBold, fontSize = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(
                        "${if (title != null) "${cams[f.cam] ?: f.cam} · " else ""}${fmtDay(f.t, state.serverNow())} · ${fmtTimeSec(f.t)}${if (faces.size > 1) " · ${pager.currentPage + 1} of ${faces.size}" else ""}",
                        color = Color.White.copy(alpha = 0.6f), fontSize = 12.sp,
                    )
                }
                RoundIcon(if (whole) Icons.Rounded.FullscreenExit else Icons.Rounded.Fullscreen, if (whole) "Close-up" else "Whole picture", size = 40.dp, background = Color(0x22FFFFFF)) { whole = !whole }
            }
            // Picture (swipe for the others)
            HorizontalPager(pager, Modifier.weight(1f).fillMaxWidth(), key = { faces[it].id }) { page -> Stage(state, faces[page], whole) }
            // What to do
            Column(Modifier.fillMaxWidth().background(C.Ink950).navigationBarsPadding().padding(14.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    AsyncImage(state.api.faceUrl(f.id), null, contentScale = ContentScale.Crop, modifier = Modifier.size(48.dp).clip(RoundedCornerShape(12.dp)))
                    Column(Modifier.weight(1f).padding(horizontal = 12.dp)) {
                        Text(f.name ?: "Unknown", color = C.Text, fontWeight = FontWeight.SemiBold, fontSize = 16.sp)
                        Text(
                            when (f.by) {
                                "you" -> "Named by you"
                                "face" -> "Recognised (${(f.sim * 100).toInt()}% alike)"
                                else -> "Not known yet"
                            } + " · clarity ${(f.q * 100).toInt()}%",
                            color = C.TextDim, fontSize = 12.sp,
                        )
                    }
                }
                if (onName != null) {
                    Spacer(Modifier.height(10.dp))
                    NamePicker(people, placeholder = if (f.name != null) "Someone else? Type or pick" else "Who is this?", resetKey = f.id, state = state) { onName(f, it) }
                }
                Spacer(Modifier.height(8.dp))
                Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    actions(f).forEach { a -> ActionChip(a.label, a.icon, if (a.danger) C.RoseLight else C.Text) { a.onClick(f) } }
                    if (onWatch != null) ActionChip("Watch this moment", Icons.Rounded.PlayCircle, C.Text) { onWatch(f) }
                }
            }
        }
    }
}

@Composable
private fun ActionChip(text: String, icon: ImageVector, tint: Color, onClick: () -> Unit) {
    Row(
        Modifier.clip(CircleShape).border(1.dp, C.GlassBorder, CircleShape).clickable(onClick = onClick).padding(horizontal = 14.dp, vertical = 9.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, null, tint = tint, modifier = Modifier.size(16.dp))
        Text("  $text", color = tint, fontSize = 13.sp, fontWeight = FontWeight.Medium)
    }
}

/** The frame, scaled and moved so the person (or the whole picture) fills the stage. */
@Composable
private fun Stage(state: AppState, f: FaceInfo, whole: Boolean) {
    var stage by remember { mutableStateOf(IntSize.Zero) }
    var img by remember { mutableStateOf(IntSize.Zero) }
    var failed by remember { mutableStateOf(false) }
    val density = LocalDensity.current
    Box(Modifier.fillMaxSize().onSizeChanged { stage = it }.clip(RoundedCornerShape(0.dp))) {
        if (failed) {
            Column(Modifier.align(Alignment.Center), horizontalAlignment = Alignment.CenterHorizontally) {
                AsyncImage(state.api.faceUrl(f.id), null, contentScale = ContentScale.Crop, modifier = Modifier.size(220.dp).clip(RoundedCornerShape(24.dp)))
                Text("The recording of this moment is gone; this is the saved face.", color = C.TextDim, fontSize = 12.sp, modifier = Modifier.padding(12.dp))
            }
            return@Box
        }
        val r = if (whole || img == IntSize.Zero) NBox(0.0, 0.0, 1.0, 1.0) else closeUp(f, img)
        val z = if (img == IntSize.Zero || stage == IntSize.Zero) 1f else minOf(stage.width / (r.w * img.width), stage.height / (r.h * img.height)).toFloat()
        val tx = if (img == IntSize.Zero) 0f else (stage.width / 2f - ((r.x + r.w / 2) * img.width * z).toFloat())
        val ty = if (img == IntSize.Zero) 0f else (stage.height / 2f - ((r.y + r.h / 2) * img.height * z).toFloat())
        val az by animateFloatAsState(z, tween(450), label = "z")
        val ax by animateFloatAsState(tx, tween(450), label = "x")
        val ay by animateFloatAsState(ty, tween(450), label = "y")
        if (img == IntSize.Zero) {
            AsyncImage(state.api.faceUrl(f.id), null, contentScale = ContentScale.Crop, modifier = Modifier.align(Alignment.Center).size(200.dp).clip(RoundedCornerShape(24.dp)))
            CircularProgressIndicator(Modifier.align(Alignment.Center), color = Color.White.copy(alpha = 0.7f))
        }
        with(density) {
            // Laid out at the picture's own size from the stage's top-left corner (a plain
            // oversized child would be centred), then scaled and moved into place.
            val iw = maxOf(img.width, 1)
            val ih = maxOf(img.height, 1)
            Box(
                Modifier.layout { m, _ ->
                    val pl = m.measure(Constraints.fixed(iw, ih))
                    layout(0, 0) { pl.place(0, 0) }
                }
                    .graphicsLayer {
                        transformOrigin = TransformOrigin(0f, 0f)
                        scaleX = az; scaleY = az
                        translationX = ax; translationY = ay
                        alpha = if (img == IntSize.Zero) 0f else 1f
                    },
            ) {
                // Full resolution: the loader would otherwise size the picture to its box.
                val ctx = LocalPlatformContext.current
                val request = remember(f.id) { ImageRequest.Builder(ctx).data(state.api.faceFrameUrl(f.id)).size(CoilSize.ORIGINAL).build() }
                AsyncImage(
                    request, null, contentScale = ContentScale.FillBounds, modifier = Modifier.fillMaxSize(),
                    onState = { s: AsyncImagePainter.State ->
                        when (s) {
                            is AsyncImagePainter.State.Success -> {
                                val sz = s.painter.intrinsicSize
                                img = IntSize(sz.width.toInt(), sz.height.toInt())
                            }
                            is AsyncImagePainter.State.Error -> failed = true
                            else -> {}
                        }
                    },
                )
                f.face?.let { fb ->
                    if (img != IntSize.Zero) Box(
                        Modifier.offset((fb.x * img.width).toFloat().toDp(), (fb.y * img.height).toFloat().toDp())
                            .size((fb.w * img.width).toFloat().toDp(), (fb.h * img.height).toFloat().toDp())
                            .border((3f / maxOf(az, 0.1f)).toDp(), Color(0xFFF472B6), RoundedCornerShape(10)),
                    )
                }
            }
        }
    }
}

/** The person with room around them (a few face-widths at least), kept in the frame. */
private fun closeUp(f: FaceInfo, img: IntSize): NBox {
    val b = f.box
    val fw = f.face?.w ?: (b.w / 3)
    val w = minOf(1.0, maxOf(b.w * 1.5, fw * 6))
    val h = minOf(1.0, maxOf(b.h * 1.2, fw * 6 * img.width / img.height))
    val cx = f.face?.let { it.x + it.w / 2 } ?: (b.x + b.w / 2)
    val cy = f.face?.let { minOf(it.y + it.h * 2, b.y + b.h / 2) } ?: (b.y + b.h / 2)
    return NBox((cx - w / 2).coerceIn(0.0, 1 - w), (cy - h / 2).coerceIn(0.0, 1 - h), w, h)
}

/**
 * Type a name: the people Sentinel knows (matching what's typed) are offered with their
 * pictures, and a new name can be added.
 */
@Composable
fun NamePicker(people: List<PersonInfo>, placeholder: String = "Who is this?", resetKey: Any? = null, state: AppState? = null, onPick: (NamePick) -> Unit) {
    var text by remember(resetKey) { mutableStateOf("") }
    val q = text.trim().lowercase()
    val matches = people.filter { q.isEmpty() || it.name.lowercase().contains(q) }
    val exact = people.any { it.name.lowercase() == q }
    Column {
        Row(
            Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(C.Glass).border(1.dp, C.GlassBorder, RoundedCornerShape(14.dp)).padding(horizontal = 12.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Icons.Rounded.Person, null, tint = C.TextFaint, modifier = Modifier.size(18.dp))
            Box(Modifier.weight(1f).padding(start = 8.dp)) {
                if (text.isEmpty()) Text(placeholder, color = C.TextFaint, fontSize = 14.sp)
                BasicTextField(
                    text, { text = it }, singleLine = true,
                    textStyle = TextStyle(color = C.Text, fontSize = 14.sp), cursorBrush = SolidColor(C.VioletLight),
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                    keyboardActions = KeyboardActions(onDone = {
                        val m = matches.firstOrNull()
                        when {
                            m != null && (exact || q.isNotEmpty()) -> onPick(NamePick(person = m.id, label = m.name))
                            q.isNotEmpty() -> onPick(NamePick(name = text.trim(), label = text.trim()))
                        }
                    }),
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }
        if (matches.isNotEmpty() || (q.isNotEmpty() && !exact)) {
            Spacer(Modifier.height(8.dp))
            Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                matches.forEach { p ->
                    Row(
                        Modifier.clip(CircleShape).background(C.Glass).border(1.dp, C.GlassBorder, CircleShape).clickable { onPick(NamePick(person = p.id, label = p.name)) }.padding(start = 3.dp, end = 12.dp, top = 3.dp, bottom = 3.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        if (p.cover != null && state != null) AsyncImage(state.api.faceUrl(p.cover), null, contentScale = ContentScale.Crop, modifier = Modifier.size(28.dp).clip(CircleShape))
                        else Icon(Icons.Rounded.Person, null, tint = C.TextDim, modifier = Modifier.size(28.dp).clip(CircleShape).background(Color(0x12FFFFFF)).padding(5.dp))
                        Text("  ${p.name}", color = C.Text, fontSize = 13.sp, fontWeight = FontWeight.Medium)
                    }
                }
                if (q.isNotEmpty() && !exact) Row(
                    Modifier.clip(CircleShape).background(C.Violet.copy(alpha = 0.2f)).clickable { onPick(NamePick(name = text.trim(), label = text.trim())) }.padding(horizontal = 12.dp, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(Icons.Rounded.Add, null, tint = C.VioletLight, modifier = Modifier.size(16.dp))
                    Text(" Add “${text.trim()}”", color = C.VioletLight, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                }
            }
        }
    }
}
