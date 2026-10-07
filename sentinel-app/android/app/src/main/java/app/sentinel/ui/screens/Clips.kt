package app.sentinel.ui.screens

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.CloudUpload
import androidx.compose.material.icons.rounded.Delete
import androidx.compose.material.icons.rounded.Download
import androidx.compose.material.icons.rounded.Edit
import androidx.compose.material.icons.rounded.ErrorOutline
import androidx.compose.material.icons.rounded.Movie
import androidx.compose.material.icons.rounded.NotificationsActive
import androidx.compose.material.icons.rounded.PushPin
import androidx.compose.material.icons.rounded.Share
import androidx.compose.material.icons.outlined.PushPin
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.media3.ui.PlayerView
import app.sentinel.core.AppState
import app.sentinel.core.Clip
import app.sentinel.core.Gallery
import app.sentinel.core.fmtBytes
import app.sentinel.core.fmtDayTime
import app.sentinel.core.fmtDuration
import app.sentinel.media.ClipPlayer
import app.sentinel.ui.components.EmptyState
import app.sentinel.ui.components.Gap
import app.sentinel.ui.components.ProgressBar
import app.sentinel.ui.components.RoundIcon
import app.sentinel.ui.components.Shimmer
import app.sentinel.ui.components.SubtleButton
import app.sentinel.ui.components.Toaster
import app.sentinel.ui.theme.C
import coil3.compose.AsyncImage
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** Saved clips: watch, save to the phone, share, rename, pin, delete. */
@Composable
fun ClipsScreen(state: AppState, padding: PaddingValues) {
    var clips by remember { mutableStateOf<List<Clip>?>(null) }
    var open by remember { mutableStateOf<Clip?>(null) }
    var failed by remember { mutableStateOf<Clip?>(null) }
    val scope = rememberCoroutineScope()

    suspend fun load() {
        runCatching { state.api.clips() }.onSuccess { clips = it.sortedWith(compareByDescending<Clip> { c -> c.pinned }.thenByDescending { c -> c.created }) }
    }
    LaunchedEffect(Unit) {
        while (true) {
            state.awaitVisible()
            load()
            // Faster while a clip is being saved, to show its progress.
            delay(if (clips?.any { it.status == "saving" || it.status == "queued" } == true) 1500 else 15_000)
        }
    }

    val list = clips
    LazyVerticalGrid(
        columns = GridCells.Adaptive(165.dp),
        contentPadding = PaddingValues(start = 14.dp, end = 14.dp, top = padding.calculateTopPadding() + 8.dp, bottom = padding.calculateBottomPadding() + 16.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
        modifier = Modifier.fillMaxSize(),
    ) {
        item(span = { GridItemSpan(maxLineSpan) }) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Clips", style = MaterialTheme.typography.headlineMedium, modifier = Modifier.weight(1f))
                if (list != null) Text("${list.size} · ${fmtBytes(list.sumOf { it.size })}", color = C.TextDim, fontSize = 13.sp)
            }
        }
        if (list == null) items(4) { Shimmer(Modifier.fillMaxWidth().aspectRatio(16f / 11f).clip(RoundedCornerShape(16.dp))) }
        else if (list.isEmpty()) item(span = { GridItemSpan(maxLineSpan) }) {
            EmptyState(Icons.Rounded.Movie, "No clips yet", "Open a camera, tap Clip, drag the handles on the timeline and save. Clips are cut without re-encoding, so they're full quality.")
        }
        items(list ?: emptyList(), key = { it.id }) { c ->
            ClipCard(state, c, Modifier.animateItem()) {
                when (c.status) {
                    "ready" -> open = c
                    "failed" -> failed = c
                }
            }
        }
    }

    open?.let { c ->
        ClipViewer(state, c, onClose = { open = null }, onChanged = { scope.launch { load() } })
    }
    // A clip that couldn't be saved: why, and (admins) remove it.
    failed?.let { c ->
        AlertDialog(
            onDismissRequest = { failed = null },
            title = { Text("“${c.name}” wasn't saved") },
            text = { Text(c.error?.takeIf { it.isNotBlank() } ?: "Sentinel couldn't save this clip.") },
            confirmButton = {
                if (state.isAdmin) TextButton({
                    failed = null
                    scope.launch {
                        runCatching { state.api.deleteClip(c.id) }.onSuccess { Toaster.show("Clip removed"); load() }.onFailure { Toaster.error(it.message ?: "Couldn't remove it") }
                    }
                }) { Text("Remove", color = C.RoseLight) }
                else TextButton({ failed = null }) { Text("OK", color = C.Cyan) }
            },
            dismissButton = { if (state.isAdmin) TextButton({ failed = null }) { Text("Keep", color = C.TextDim) } },
            containerColor = C.Ink850,
        )
    }
}

@Composable
private fun ClipCard(state: AppState, c: Clip, modifier: Modifier, onClick: () -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    Column(modifier.scale(if (pressed) 0.97f else 1f).clip(RoundedCornerShape(16.dp)).clickable(interaction, null, onClick = onClick)) {
        Box(Modifier.fillMaxWidth().aspectRatio(16f / 10f).clip(RoundedCornerShape(16.dp)).background(C.Ink800).border(1.dp, C.GlassBorder, RoundedCornerShape(16.dp))) {
            AsyncImage(state.api.clipThumbUrl(c), null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
            Box(Modifier.fillMaxSize().background(Brush.verticalGradient(listOf(Color.Transparent, Color(0x88000000)))))
            when (c.status) {
                "saving", "queued" -> Column(Modifier.align(Alignment.Center), horizontalAlignment = Alignment.CenterHorizontally) {
                    CircularProgressIndicator(progress = { c.progress.toFloat().coerceIn(0.02f, 1f) }, color = C.Cyan, trackColor = Color(0x33FFFFFF), modifier = Modifier.size(40.dp))
                    Text(if (c.status == "queued") "Waiting…" else "Saving ${(c.progress * 100).toInt()}%", color = Color.White, fontSize = 12.sp, modifier = Modifier.padding(top = 6.dp))
                }
                "failed" -> Icon(Icons.Rounded.ErrorOutline, null, tint = C.RoseLight, modifier = Modifier.align(Alignment.Center).size(32.dp))
            }
            Row(Modifier.align(Alignment.TopEnd).padding(6.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                if (c.alert) Badge(Icons.Rounded.NotificationsActive, C.Amber)
                if (c.pinned) Badge(Icons.Rounded.PushPin, C.VioletLight)
                if (c.backup?.state == "done") Badge(Icons.Rounded.CloudUpload, C.Emerald)
            }
            Text(fmtDuration(c.to - c.from), color = Color.White, fontSize = 11.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.align(Alignment.BottomStart).padding(8.dp))
        }
        Text(c.name, color = C.Text, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 7.dp, start = 2.dp))
        Text("${c.cameraName.ifBlank { c.camera }} · ${fmtDayTime(c.from, state.serverNow())}", color = C.TextDim, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(start = 2.dp))
    }
}

@Composable
private fun Badge(icon: androidx.compose.ui.graphics.vector.ImageVector, color: Color) {
    Box(Modifier.size(24.dp).clip(CircleShape).background(Color(0x99000000)), contentAlignment = Alignment.Center) {
        Icon(icon, null, tint = color, modifier = Modifier.size(14.dp))
    }
}

@Composable
private fun ClipViewer(state: AppState, clip: Clip, onClose: () -> Unit, onChanged: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val player = remember(clip.id) { ClipPlayer(context, state.engine.streamHttp, state.api.clipVideoUrl(clip.id)) }
    DisposableEffect(player) {
        app.sentinel.core.Updater.watching.value++ // an app update waits while a clip plays
        onDispose { player.release(); app.sentinel.core.Updater.watching.value-- }
    }
    var c by remember { mutableStateOf(clip) }
    var progress by remember { mutableFloatStateOf(-1f) }
    var renaming by remember { mutableStateOf(false) }
    var confirmDelete by remember { mutableStateOf(false) }
    val auth by state.auth.collectAsStateWithLifecycle()
    val admin = state.isAdmin
    val fileName = Gallery.safeName(c.name)
    val saver = app.sentinel.ui.components.rememberGallerySaver()

    Dialog(onClose, DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        Box(Modifier.fillMaxSize().background(C.Ink950)) {
            Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding()) {
                Row(Modifier.fillMaxWidth().padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                    RoundIcon(Icons.AutoMirrored.Rounded.ArrowBack, "Close", size = 40.dp, background = Color(0x10FFFFFF), onClick = onClose)
                    Column(Modifier.weight(1f).padding(horizontal = 12.dp)) {
                        Text(c.name, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text("${c.cameraName} · ${fmtDayTime(c.from, state.serverNow())} · ${fmtBytes(c.size)}", color = C.TextDim, fontSize = 12.sp, maxLines = 1)
                    }
                }
                Box(Modifier.fillMaxWidth().weight(1f).background(Color.Black), contentAlignment = Alignment.Center) {
                    AndroidView(
                        factory = { ctx -> PlayerView(ctx).apply { this.player = player.exo; setShowNextButton(false); setShowPreviousButton(false); controllerShowTimeoutMs = 2500 } },
                        onRelease = { it.player = null },
                        modifier = Modifier.fillMaxSize(),
                    )
                }
                AnimatedVisibility(progress >= 0f) {
                    Column(Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) {
                        Text("Downloading ${(progress * 100).toInt()}%", color = C.TextDim, fontSize = 12.sp)
                        Gap(6.dp)
                        ProgressBar(progress, Modifier.fillMaxWidth())
                    }
                }
                Row(Modifier.fillMaxWidth().padding(12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    SubtleButton("Save", Modifier.weight(1f), icon = Icons.Rounded.Download) {
                        if (progress >= 0) return@SubtleButton
                        saver { progress = 0f; scope.launch {
                            Gallery.saveVideo(context, state.engine.streamHttp, state.api.clipVideoUrl(c.id), fileName) { progress = it }
                                .onSuccess { Toaster.show("Saved to Movies/Sentinel") }
                                .onFailure { Toaster.error(it.message ?: "Download failed") }
                            progress = -1f
                        } }
                    }
                    SubtleButton("Share", Modifier.weight(1f), icon = Icons.Rounded.Share) {
                        if (progress >= 0) return@SubtleButton
                        progress = 0f
                        scope.launch {
                            Gallery.cacheForShare(context, state.engine.streamHttp, state.api.clipVideoUrl(c.id), "$fileName.mp4") { progress = it }
                                .onSuccess { Gallery.share(context, it, "video/mp4", c.name) }
                                .onFailure { Toaster.error(it.message ?: "Download failed") }
                            progress = -1f
                        }
                    }
                }
                if (admin) Row(Modifier.fillMaxWidth().padding(start = 12.dp, end = 12.dp, bottom = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    RoundIcon(Icons.Rounded.Edit, "Rename", background = Color(0x10FFFFFF)) { renaming = true }
                    RoundIcon(if (c.pinned) Icons.Rounded.PushPin else Icons.Outlined.PushPin, if (c.pinned) "Unpin" else "Pin", tint = if (c.pinned) C.VioletLight else Color.White, background = Color(0x10FFFFFF)) {
                        scope.launch {
                            runCatching { state.api.pinClip(c.id, !c.pinned) }.onSuccess { c = it; onChanged(); Toaster.show(if (it.pinned) "Pinned: kept until you delete it" else "Unpinned") }
                        }
                    }
                    RoundIcon(Icons.Rounded.CloudUpload, "Back up to Google Drive", background = Color(0x10FFFFFF)) {
                        scope.launch {
                            runCatching { state.api.backupClip(c.id) }.onSuccess { Toaster.show("Backing up to Google Drive") }.onFailure { Toaster.error(it.message ?: "Backup failed") }
                        }
                    }
                    Box(Modifier.weight(1f))
                    RoundIcon(Icons.Rounded.Delete, "Delete", tint = C.RoseLight, background = C.Rose.copy(alpha = 0.12f)) { confirmDelete = true }
                }
            }
        }
    }

    if (renaming) {
        var name by remember { mutableStateOf(c.name) }
        AlertDialog(
            onDismissRequest = { renaming = false },
            title = { Text("Rename clip") },
            text = { OutlinedTextField(name, { name = it.take(80) }, singleLine = true) },
            confirmButton = {
                TextButton({
                    scope.launch {
                        runCatching { state.api.renameClip(c.id, name.trim()) }.onSuccess { c = it; onChanged() }.onFailure { Toaster.error(it.message ?: "Couldn't rename") }
                        renaming = false
                    }
                }) { Text("Save", color = C.Cyan) }
            },
            dismissButton = { TextButton({ renaming = false }) { Text("Cancel", color = C.TextDim) } },
            containerColor = C.Ink850,
        )
    }
    if (confirmDelete) {
        AlertDialog(
            onDismissRequest = { confirmDelete = false },
            title = { Text("Delete “${c.name}”?") },
            text = { Text("The clip is removed from Sentinel for everyone. Copies saved on phones stay.") },
            confirmButton = {
                TextButton({
                    scope.launch {
                        runCatching { state.api.deleteClip(c.id) }.onSuccess { Toaster.show("Clip deleted"); onChanged(); onClose() }.onFailure { Toaster.error(it.message ?: "Couldn't delete") }
                        confirmDelete = false
                    }
                }) { Text("Delete", color = C.RoseLight) }
            },
            dismissButton = { TextButton({ confirmDelete = false }) { Text("Cancel", color = C.TextDim) } },
            containerColor = C.Ink850,
        )
    }
}
