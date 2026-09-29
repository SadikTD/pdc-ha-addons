package app.sentinel.ui.screens

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.VolumeOff
import androidx.compose.material.icons.automirrored.rounded.VolumeUp
import androidx.compose.material.icons.rounded.GridView
import androidx.compose.material.icons.rounded.PowerSettingsNew
import androidx.compose.material.icons.rounded.VideocamOff
import androidx.compose.material.icons.rounded.ViewAgenda
import androidx.compose.material.icons.rounded.ViewModule
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.LifecycleStartEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.sentinel.core.AppState
import app.sentinel.core.CameraStatus
import app.sentinel.core.fmtAgo
import app.sentinel.media.LivePlayer
import app.sentinel.ui.components.ConnectionPill
import app.sentinel.ui.components.EmptyState
import app.sentinel.ui.components.PulsingDot
import app.sentinel.ui.components.RoundIcon
import app.sentinel.ui.components.Shimmer
import app.sentinel.ui.components.StatePill
import app.sentinel.ui.components.VideoSurface
import app.sentinel.ui.theme.C
import coil3.compose.AsyncImage
import kotlinx.coroutines.delay

@Composable
fun LiveScreen(state: AppState, contentPadding: PaddingValues, onOpen: (CameraStatus) -> Unit) {
    val status by state.status.collectAsStateWithLifecycle()
    val prefs by state.prefs.collectAsStateWithLifecycle()
    val conn by state.engine.state.collectAsStateWithLifecycle()
    val error by state.statusError.collectAsStateWithLifecycle()
    val cams = state.orderedCameras(status, prefs)
    var soundOn by remember { mutableStateOf<String?>(null) }
    val haptic = LocalHapticFeedback.current

    BoxWithConstraints(Modifier.fillMaxSize()) {
        val wide = maxWidth > 700.dp
        val cols = when {
            prefs.gridColumns > 0 -> prefs.gridColumns
            wide -> 3
            else -> 2
        }
        LazyVerticalGrid(
            columns = GridCells.Fixed(cols),
            contentPadding = PaddingValues(start = 14.dp, end = 14.dp, top = contentPadding.calculateTopPadding() + 8.dp, bottom = contentPadding.calculateBottomPadding() + 16.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
            modifier = Modifier.fillMaxSize(),
        ) {
            item(span = { GridItemSpan(maxLineSpan) }) {
                Row(Modifier.fillMaxWidth().padding(bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("Live", style = MaterialTheme.typography.headlineMedium)
                        val recs = cams.filter { it.enabled && it.record && !(it.occasional && it.recorder?.state != "recording") }
                        val ok = recs.count { it.recorder?.state == "recording" }
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            if (status != null) {
                                PulsingDot(if (ok == recs.size) C.Emerald else C.Amber, size = 7.dp)
                                Text("  $ok/${recs.size} recording", color = if (ok == recs.size) C.Emerald else C.Amber, fontSize = 13.sp, fontWeight = FontWeight.Medium)
                            } else if (error != null) {
                                Text(error ?: "", color = C.RoseLight, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            }
                        }
                    }
                    ConnectionPill(conn)
                    RoundIcon(
                        when (cols) { 1 -> Icons.Rounded.ViewAgenda; 2 -> Icons.Rounded.GridView; else -> Icons.Rounded.ViewModule },
                        "Layout",
                        Modifier.padding(start = 8.dp),
                        size = 38.dp,
                        background = Color(0x10FFFFFF),
                    ) {
                        haptic.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                        state.setPrefs { it.copy(gridColumns = if (cols >= 3) 1 else cols + 1) }
                    }
                }
            }
            if (status == null) {
                items(4) { Shimmer(Modifier.fillMaxWidth().aspectRatio(16f / 9f).clip(RoundedCornerShape(18.dp))) }
            } else if (cams.isEmpty()) {
                item(span = { GridItemSpan(maxLineSpan) }) {
                    EmptyState(Icons.Rounded.VideocamOff, "No cameras to show", "Cameras are added in Sentinel's Settings. Your account may also be limited to some cameras.")
                }
            }
            items(cams, key = { it.id }) { cam ->
                LiveTile(
                    cam = cam,
                    state = state,
                    dataSaver = prefs.dataSaver,
                    compact = cols >= 3,
                    soundOn = soundOn == cam.id,
                    onSound = { soundOn = if (soundOn == cam.id) null else cam.id },
                    onClick = { onOpen(cam) },
                    modifier = Modifier.animateItem(),
                )
            }
        }
    }
}

/**
 * One camera, live from its substream. The last frame shows instantly and the video
 * fades in over it once it plays; a camera seeing motion glows amber.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun LiveTile(
    cam: CameraStatus,
    state: AppState,
    dataSaver: Boolean,
    compact: Boolean,
    soundOn: Boolean,
    onSound: () -> Unit,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val api = state.api
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val motion = cam.motion?.active == true
    val live = cam.enabled && cam.state != "offline"
    val shape = RoundedCornerShape(if (compact) 14.dp else 18.dp)

    val glowT = rememberInfiniteTransition(label = "glow")
    val glowA by glowT.animateFloat(0.45f, 1f, infiniteRepeatable(tween(700), RepeatMode.Reverse), label = "ga")
    val borderColor by animateColorAsState(if (motion) C.Amber.copy(alpha = glowA) else C.GlassBorder, tween(300), label = "border")

    // Snapshot refresh: the poster before video starts, or the picture itself in data-saver mode.
    var bust by remember { mutableLongStateOf(System.currentTimeMillis() / 5000) }
    if (dataSaver) {
        LaunchedEffect(cam.id) {
            while (true) {
                delay(3000)
                bust = System.currentTimeMillis() / 3000
            }
        }
    }

    val player = remember(cam.id) { LivePlayer(context, state.engine.streamHttp) }
    DisposableEffect(player) { onDispose { player.release() } }
    val ui by player.ui.collectAsStateWithLifecycle()
    LifecycleStartEffect(cam.id, dataSaver, live) {
        if (!dataSaver && live) player.play(api.liveUrl(cam.id, hq = false))
        onStopOrDispose { player.stop() }
    }
    LaunchedEffect(soundOn) { player.muted = !soundOn }
    val videoAlpha by animateFloatAsState(if (ui.firstFrame && !dataSaver) 1f else 0f, tween(400), label = "va")

    Box(
        modifier
            .fillMaxWidth()
            .aspectRatio(cam.aspect.coerceIn(0.5f, 2.4f))
            .scale(if (pressed) 0.97f else 1f)
            .clip(shape)
            .background(C.Ink900)
            .border(if (motion) 2.dp else 1.dp, borderColor, shape)
            .combinedClickable(interaction, indication = null, onClick = onClick),
    ) {
        if (cam.enabled) {
            AsyncImage(
                model = if (dataSaver) api.snapshotUrl(cam.id, bust = bust) else api.latestUrl(cam.id),
                contentDescription = null,
                contentScale = ContentScale.Crop,
                modifier = Modifier.fillMaxSize(),
            )
            if (!dataSaver) VideoSurface(player.exo, Modifier.fillMaxSize().graphicsLayer { alpha = videoAlpha })
        } else {
            Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
                Icon(Icons.Rounded.PowerSettingsNew, null, tint = C.TextFaint)
                Text("Switched off", color = C.TextFaint, fontSize = 12.sp)
            }
        }
        // Scrims for legible labels.
        Box(Modifier.fillMaxWidth().height(56.dp).align(Alignment.BottomCenter).background(Brush.verticalGradient(listOf(Color.Transparent, Color(0xCC000000)))))
        Box(Modifier.fillMaxWidth().height(40.dp).background(Brush.verticalGradient(listOf(Color(0x66000000), Color.Transparent))))

        Row(Modifier.align(Alignment.TopStart).padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
            StatePill(if (cam.occasional && cam.state != "recording") "offline" else cam.state, compact = true)
        }
        if (motion) {
            Row(
                Modifier.align(Alignment.TopEnd).padding(8.dp).clip(CircleShape).background(C.Amber.copy(alpha = 0.9f)).padding(horizontal = 8.dp, vertical = 3.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) { Text("MOTION", color = Color.Black, fontSize = 10.sp, fontWeight = FontWeight.Bold, letterSpacing = 0.6.sp) }
        }
        Row(Modifier.align(Alignment.BottomStart).fillMaxWidth().padding(start = 10.dp, end = 6.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(cam.name, color = Color.White, fontWeight = FontWeight.SemiBold, fontSize = if (compact) 12.sp else 14.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (!compact) {
                    val ev = cam.lastEvent
                    Text(
                        when {
                            !cam.enabled -> "Disabled"
                            cam.occasional && cam.state != "recording" -> "Switched off"
                            ev != null -> "Motion ${fmtAgo(ev.start, state.serverNow())}"
                            else -> "No motion yet"
                        },
                        color = Color.White.copy(alpha = 0.65f),
                        fontSize = 11.sp,
                        maxLines = 1,
                    )
                }
            }
            if (cam.hasAudio && !dataSaver && !compact) {
                RoundIcon(if (soundOn) Icons.AutoMirrored.Rounded.VolumeUp else Icons.AutoMirrored.Rounded.VolumeOff, "Sound", size = 32.dp, background = if (soundOn) C.Violet.copy(alpha = 0.85f) else Color(0x33000000), onClick = onSound)
            }
        }
        if (cam.enabled && !dataSaver && ui.loading && !ui.firstFrame && live) {
            CircularProgressIndicator(Modifier.align(Alignment.Center).size(22.dp), strokeWidth = 2.dp, color = Color.White.copy(alpha = 0.7f))
        }
        if (cam.enabled && !live) {
            Icon(
                if (cam.occasional) Icons.Rounded.PowerSettingsNew else Icons.Rounded.VideocamOff,
                null,
                tint = C.TextFaint,
                modifier = Modifier.align(Alignment.Center).size(26.dp),
            )
        }
    }
}
