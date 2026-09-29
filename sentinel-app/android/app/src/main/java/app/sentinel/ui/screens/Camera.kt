package app.sentinel.ui.screens

import android.content.pm.ActivityInfo
import android.content.res.Configuration
import android.util.Rational
import android.view.TextureView
import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
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
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.automirrored.rounded.VolumeOff
import androidx.compose.material.icons.automirrored.rounded.VolumeUp
import androidx.compose.material.icons.rounded.CameraAlt
import androidx.compose.material.icons.rounded.ContentCut
import androidx.compose.material.icons.rounded.Event
import androidx.compose.material.icons.rounded.Forward10
import androidx.compose.material.icons.rounded.Fullscreen
import androidx.compose.material.icons.rounded.FullscreenExit
import androidx.compose.material.icons.rounded.Pause
import androidx.compose.material.icons.rounded.PictureInPictureAlt
import androidx.compose.material.icons.rounded.PlayArrow
import androidx.compose.material.icons.rounded.Replay10
import androidx.compose.material.icons.rounded.SensorsOff
import androidx.compose.material.icons.rounded.SkipNext
import androidx.compose.material.icons.rounded.SkipPrevious
import androidx.compose.material.icons.rounded.Hd
import androidx.compose.material.icons.rounded.Sd
import androidx.compose.material.icons.rounded.Share
import androidx.compose.material.icons.rounded.Speed
import androidx.compose.material.icons.rounded.TipsAndUpdates
import androidx.compose.material.icons.rounded.ZoomIn
import androidx.compose.material.icons.rounded.ZoomOut
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TimePicker
import androidx.compose.material3.TimePickerDefaults
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.material3.rememberTimePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.lifecycle.compose.LifecycleStartEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.sentinel.core.AppState
import app.sentinel.core.CameraStatus
import app.sentinel.core.DAY
import app.sentinel.core.Gallery
import app.sentinel.core.HOUR
import app.sentinel.core.MINUTE
import app.sentinel.core.SentinelEvent
import app.sentinel.core.Span
import app.sentinel.core.fmtDay
import app.sentinel.core.fmtDuration
import app.sentinel.core.fmtTime
import app.sentinel.core.fmtTimeSec
import app.sentinel.media.LivePlayer
import app.sentinel.media.RecordingPlayer
import app.sentinel.ui.LocalActivity
import app.sentinel.ui.components.Backdrop
import app.sentinel.ui.components.ConnectionPill
import app.sentinel.ui.components.EmptyState
import app.sentinel.ui.components.Gap
import app.sentinel.ui.components.GradientButton
import app.sentinel.ui.components.PulsingDot
import app.sentinel.ui.components.RoundIcon
import app.sentinel.ui.components.StatePill
import app.sentinel.ui.components.Timeline
import app.sentinel.ui.components.TimelineState
import app.sentinel.ui.components.Toaster
import app.sentinel.ui.components.VideoSurface
import app.sentinel.ui.components.glass
import app.sentinel.ui.theme.C
import coil3.compose.AsyncImage
import coil3.request.ImageRequest
import coil3.request.crossfade
import java.util.Calendar
import kotlin.math.log2
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch

private val SPEEDS = listOf(1f, 2f, 4f, 8f, 16f, 0.5f)

@Composable
fun CameraScreen(state: AppState, id: String, t: Long?, onBack: () -> Unit, onOpenCamera: (String) -> Unit) {
    val status by state.status.collectAsStateWithLifecycle()
    val cam = status?.cameras?.find { it.id == id }
    if (cam == null) {
        Backdrop {
            if (status == null) CircularProgressIndicator(Modifier.align(Alignment.Center), color = C.Violet)
            else EmptyState(Icons.Rounded.SensorsOff, "Camera not found", "It may have been removed, or your account can't see it.", Modifier.align(Alignment.Center))
        }
        return
    }
    CameraContent(state, cam, t, onBack, onOpenCamera)
}

@Composable
private fun CameraContent(state: AppState, cam: CameraStatus, startAt: Long?, onBack: () -> Unit, onOpenCamera: (String) -> Unit) {
    val context = LocalContext.current
    val activity = LocalActivity.current
    val view = LocalView.current
    val scope = rememberCoroutineScope()
    val api = state.api
    val prefs by state.prefs.collectAsStateWithLifecycle()
    val conn by state.engine.state.collectAsStateWithLifecycle()
    val landscape = LocalConfiguration.current.orientation == Configuration.ORIENTATION_LANDSCAPE
    val inPip = activity.inPip

    val sub = remember(cam.id) { LivePlayer(context, state.engine.streamHttp) }
    val main = remember(cam.id) { LivePlayer(context, state.engine.streamHttp) }
    val rec = remember(cam.id) { RecordingPlayer(context, state.engine.http) { from, to -> api.vodUrl(cam.id, from, to) } }
    DisposableEffect(cam.id) {
        rec.nowProvider = state::serverNow
        onDispose { sub.release(); main.release(); rec.release() }
    }
    val subUi by sub.ui.collectAsStateWithLifecycle()
    val mainUi by main.ui.collectAsStateWithLifecycle()
    val recUi by rec.ui.collectAsStateWithLifecycle()

    var live by remember { mutableStateOf(startAt == null) }
    var playTime by remember { mutableLongStateOf(startAt ?: state.serverNow()) }
    var muted by remember { mutableStateOf(true) }
    var speed by remember { mutableFloatStateOf(1f) }
    var hd by remember { mutableStateOf(!prefs.dataSaver) }
    var clipRange by remember { mutableStateOf<Pair<Long, Long>?>(null) }
    var savingClip by remember { mutableStateOf(false) }
    var showGoTo by remember { mutableStateOf(false) }
    var controlsVisible by remember { mutableStateOf(true) }
    var lastTouch by remember { mutableLongStateOf(System.currentTimeMillis()) }
    var texture by remember { mutableStateOf<TextureView?>(null) }
    val tl = remember { TimelineState() }

    fun goLive() {
        live = true
        rec.stop()
        speed = 1f
    }

    fun seekTo(t: Long) {
        lastTouch = System.currentTimeMillis()
        if (t >= state.serverNow() - 8_000) {
            goLive()
            return
        }
        playTime = t
        scope.launch {
            if (rec.seek(t)) live = false
            else Toaster.show("No recording at or after ${fmtTime(t)}")
        }
    }

    rec.onCaughtUp = { goLive() }

    // Start where we were asked to.
    LaunchedEffect(cam.id) { if (startAt != null) seekTo(startAt) }

    // Live players run only while live and the screen is visible (or in picture-in-picture).
    LifecycleStartEffect(live, cam.id, hd) {
        if (live) {
            sub.play(api.liveUrl(cam.id, hq = false))
            if (hd) main.play(api.liveUrl(cam.id, hq = true)) else main.stop()
        } else {
            sub.stop(); main.stop()
        }
        onStopOrDispose { if (!activity.inPip) { sub.stop(); main.stop() } }
    }
    // Back on a network after a switch: restart the live video at once.
    val reconnects by state.engine.reconnects.collectAsStateWithLifecycle()
    LaunchedEffect(reconnects) {
        if (reconnects > 0 && live) {
            delay(300)
            if (hd) main.retryNow() else sub.retryNow()
        }
    }
    // Once full quality plays, the substream isn't needed.
    LaunchedEffect(mainUi.firstFrame, hd) { if (hd && mainUi.firstFrame) sub.stop() }
    LaunchedEffect(muted, live) {
        sub.muted = muted; main.muted = muted; rec.muted = muted
    }
    LaunchedEffect(speed) { rec.rate = speed; rec.muted = muted || speed > 2f }

    // The playhead: live edge, or the recording's wall-clock time.
    LaunchedEffect(live) {
        while (true) {
            if (live) playTime = state.serverNow()
            else rec.time.takeIf { it > 0 }?.let { playTime = it }
            delay(if (live) 1000 else 200)
        }
    }

    // Footage and motion for the part of the timeline in view (and a bit either side).
    var coverage by remember { mutableStateOf<List<Span>>(emptyList()) }
    var events by remember { mutableStateOf<List<SentinelEvent>>(emptyList()) }
    suspend fun loadRange(center: Long, span: Long) {
        val from = center - 2 * span
        val to = minOf(center + 2 * span, state.serverNow() + MINUTE)
        runCatching { api.coverage(cam.id, from, to) }.onSuccess { coverage = it }
        runCatching { api.events(listOf(cam.id), from, to) }.onSuccess { events = it }
    }
    LaunchedEffect(cam.id) {
        snapshotFlow {
            val span = tl.span.toLong().coerceAtLeast(MINUTE)
            val c = if (tl.scrubbing) tl.scrubTime else playTime
            Triple(c / (span / 2), log2(span.toDouble()).toInt(), span)
        }.distinctUntilChanged { a, b -> a.first == b.first && a.second == b.second }.collectLatest { (bucket, _, span) ->
            delay(120)
            loadRange(bucket * (span / 2), span)
        }
    }
    LaunchedEffect(cam.id) {
        while (true) {
            delay(30_000)
            state.awaitVisible()
            loadRange(if (tl.scrubbing) tl.scrubTime else playTime, tl.span.toLong())
        }
    }
    // The last day's events for the quick list.
    var todayEvents by remember { mutableStateOf<List<SentinelEvent>>(emptyList()) }
    LaunchedEffect(cam.id) {
        while (true) {
            state.awaitVisible()
            runCatching { api.events(listOf(cam.id), state.serverNow() - DAY, null, 400) }.onSuccess { todayEvents = it.sortedByDescending { e -> e.start } }
            delay(60_000)
        }
    }
    // What the skip buttons and the quick list step through: all motion, people, or animals.
    var jump by rememberSaveable { mutableStateOf("all") }
    fun ofKind(e: SentinelEvent) = when (jump) {
        "person" -> e.has("person")
        "animal" -> e.has("cat") || e.has("dog")
        else -> true
    }
    val jumpName = when (jump) { "person" -> "person"; "animal" -> "animal"; else -> "motion" }

    // Picture-in-picture and screen-on while watching.
    val aspect = (if (live) (mainUi.videoAspect.takeIf { it > 0 } ?: subUi.videoAspect) else recUi.videoAspect).takeIf { it > 0 } ?: cam.aspect
    DisposableEffect(aspect) {
        activity.pipAspect = Rational((aspect * 1000).toInt().coerceIn(420, 2390), 1000)
        onDispose { activity.pipAspect = null }
    }
    DisposableEffect(prefs.keepScreenOn) {
        view.keepScreenOn = prefs.keepScreenOn
        onDispose { view.keepScreenOn = false }
    }
    // Fullscreen: landscape without system bars.
    DisposableEffect(landscape) {
        val ctl = WindowCompat.getInsetsController(activity.window, view)
        if (landscape) {
            ctl.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            ctl.hide(WindowInsetsCompat.Type.systemBars())
        } else ctl.show(WindowInsetsCompat.Type.systemBars())
        onDispose { ctl.show(WindowInsetsCompat.Type.systemBars()) }
    }
    DisposableEffect(Unit) { onDispose { activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED } }
    BackHandler(landscape) { activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_PORTRAIT }
    val playing = if (live) true else recUi.playing
    // Controls on the picture fade out while it plays and nobody touches it.
    LaunchedEffect(landscape, lastTouch, controlsVisible, playing) {
        if (controlsVisible && playing && !tl.scrubbing) {
            delay(if (landscape) 4000 else 3000)
            controlsVisible = false
        }
    }
    val loading = if (live) !(subUi.firstFrame || mainUi.firstFrame) || (subUi.loading && mainUi.loading && !mainUi.firstFrame) else recUi.loading
    val timelineCenter = if (tl.scrubbing) tl.scrubTime else playTime

    fun prevEvent() {
        val t = timelineCenter - 3000
        val e = (events + todayEvents).filter { it.start < t && ofKind(it) }.maxByOrNull { it.start }
        if (e != null) seekTo(e.bestTime - 2000) else Toaster.show("No earlier $jumpName nearby")
    }

    fun nextEvent() {
        val t = timelineCenter + 1000
        val e = (events + todayEvents).filter { it.start > t && ofKind(it) }.minByOrNull { it.start }
        if (e != null) seekTo(e.bestTime - 2000) else Toaster.show("No later $jumpName")
    }

    fun snapshot() {
        val bmp = texture?.bitmap ?: return Toaster.error("Nothing to capture yet")
        scope.launch {
            Gallery.saveBitmap(context, bmp, "${Gallery.safeName(cam.name)}_${System.currentTimeMillis() / 1000}")
                .onSuccess { Toaster.show("Snapshot saved to Pictures/Sentinel") }
                .onFailure { Toaster.error(it.message ?: "Couldn't save") }
        }
    }

    fun shareSnapshot() {
        val bmp = texture?.bitmap ?: return Toaster.error("Nothing to share yet")
        val uri = Gallery.shareBitmapFile(context, bmp, "${Gallery.safeName(cam.name)}_${System.currentTimeMillis() / 1000}")
        Gallery.share(context, uri, "image/jpeg", "${cam.name} · ${fmtTimeSec(timelineCenter)}")
    }

    fun toggleFullscreen() {
        activity.requestedOrientation = if (landscape) ActivityInfo.SCREEN_ORIENTATION_PORTRAIT else ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
    }

    val video: @Composable BoxScope.() -> Unit = {
        VideoArea(
            state = state,
            cam = cam,
            live = live,
            sub = sub,
            main = main,
            rec = rec,
            showMain = hd && mainUi.firstFrame,
            scrubbing = tl.scrubbing,
            scrubTime = tl.scrubTime,
            loading = loading,
            onTexture = { texture = it },
            onTap = { controlsVisible = !controlsVisible; lastTouch = System.currentTimeMillis() },
        )
    }

    if (inPip) {
        Box(Modifier.fillMaxSize().background(Color.Black)) { video() }
        return
    }

    val timeline: @Composable (Modifier) -> Unit = { m ->
        Timeline(
            state = tl,
            center = playTime,
            now = state.serverNow(),
            coverage = coverage,
            events = events,
            onScrub = { lastTouch = System.currentTimeMillis() },
            onSeek = { seekTo(it) },
            clipRange = clipRange,
            onClipRange = { clipRange = it },
            modifier = m,
        )
    }

    val transport: @Composable () -> Unit = {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceEvenly, verticalAlignment = Alignment.CenterVertically) {
            RoundIcon(Icons.Rounded.SkipPrevious, "Previous $jumpName", size = 46.dp) { prevEvent() }
            RoundIcon(Icons.Rounded.Replay10, "Back 10 seconds", size = 46.dp) { seekTo(timelineCenter - 10_000) }
            Box(
                Modifier.size(64.dp).clip(CircleShape).background(C.accent).clickable {
                    lastTouch = System.currentTimeMillis()
                    if (live) seekTo(state.serverNow() - 15_000) // pause live = step into the recording
                    else rec.togglePlay()
                },
                contentAlignment = Alignment.Center,
            ) {
                AnimatedContent(playing, transitionSpec = { fadeIn(tween(150)) togetherWith fadeOut(tween(150)) }, label = "pp") { p ->
                    Icon(if (p) Icons.Rounded.Pause else Icons.Rounded.PlayArrow, if (p) "Pause" else "Play", tint = Color.White, modifier = Modifier.size(34.dp))
                }
            }
            RoundIcon(Icons.Rounded.Forward10, "Forward 10 seconds", size = 46.dp) { if (!live) seekTo(timelineCenter + 10_000) }
            RoundIcon(Icons.Rounded.SkipNext, "Next $jumpName", size = 46.dp) { nextEvent() }
        }
    }

    // Every action visible at once: two rows of four.
    val actions: @Composable () -> Unit = {
        Column(Modifier.padding(horizontal = 12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                ActionTile("Snapshot", Icons.Rounded.CameraAlt, Modifier.weight(1f)) { snapshot() }
                ActionTile("Share", Icons.Rounded.Share, Modifier.weight(1f)) { shareSnapshot() }
                ActionTile(if (clipRange != null) "Cancel clip" else "Save clip", Icons.Rounded.ContentCut, Modifier.weight(1f), highlighted = clipRange != null) {
                    clipRange = if (clipRange != null) null else {
                        val c = minOf(timelineCenter, state.serverNow() - 1000)
                        (c - 15_000) to minOf(c + 15_000, state.serverNow())
                    }
                    if (clipRange != null) tl.span = 2f * MINUTE
                }
                ActionTile("Go to time", Icons.Rounded.Event, Modifier.weight(1f)) { showGoTo = true }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                if (live) ActionTile(if (hd) "HD quality" else "SD (saves data)", if (hd) Icons.Rounded.Hd else Icons.Rounded.Sd, Modifier.weight(1f), highlighted = hd) {
                    hd = !hd
                    if (!hd) sub.play(api.liveUrl(cam.id, hq = false))
                    Toaster.show(if (hd) "Full quality" else "Lower quality: uses much less data")
                }
                else ActionTile("${if (speed < 1) "½" else speed.toInt().toString()}× speed", Icons.Rounded.Speed, Modifier.weight(1f), highlighted = speed != 1f) {
                    speed = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.size]
                }
                ActionTile(if (muted) "Sound off" else "Sound on", if (muted) Icons.AutoMirrored.Rounded.VolumeOff else Icons.AutoMirrored.Rounded.VolumeUp, Modifier.weight(1f), highlighted = !muted, enabled = cam.hasAudio) { muted = !muted }
                ActionTile("Mini player", Icons.Rounded.PictureInPictureAlt, Modifier.weight(1f)) { activity.enterPip() }
                ActionTile("Fullscreen", Icons.Rounded.Fullscreen, Modifier.weight(1f)) { toggleFullscreen() }
            }
        }
    }

    val timeLabel: @Composable () -> Unit = {
        Row(verticalAlignment = Alignment.CenterVertically) {
            if (live && !tl.scrubbing) {
                PulsingDot(C.Rose, size = 8.dp)
                Text("  LIVE", color = C.RoseLight, fontWeight = FontWeight.Bold, fontSize = 13.sp, letterSpacing = 1.sp)
            } else {
                val t = if (tl.scrubbing) tl.scrubTime else playTime
                Text("${fmtDay(t, state.serverNow())} · ${fmtTimeSec(t)}", color = Color.White, fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
                if (!live && speed != 1f) Text("   ${if (speed < 1) "½" else speed.toInt()}×", color = C.Cyan, fontWeight = FontWeight.Bold, fontSize = 13.sp)
            }
        }
    }

    if (landscape) {
        Box(Modifier.fillMaxSize().background(Color.Black)) {
            Box(Modifier.align(Alignment.Center).aspectRatio(aspect.coerceIn(0.5f, 3f), matchHeightConstraintsFirst = true)) { video() }
            androidx.compose.animation.AnimatedVisibility(controlsVisible, enter = fadeIn(), exit = fadeOut(), modifier = Modifier.fillMaxSize()) {
                Box(Modifier.fillMaxSize()) {
                    Row(
                        Modifier.fillMaxWidth().background(Brush.verticalGradient(listOf(Color(0xE6000000), Color(0x80000000), Color.Transparent))).padding(start = 16.dp, end = 16.dp, top = 12.dp, bottom = 28.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        RoundIcon(Icons.Rounded.FullscreenExit, "Exit fullscreen", size = 40.dp, background = Color(0x33000000)) { toggleFullscreen() }
                        Column(Modifier.weight(1f).padding(horizontal = 12.dp)) {
                            Text(cam.name, color = Color.White, fontWeight = FontWeight.SemiBold, fontSize = 16.sp)
                            timeLabel()
                        }
                        if (cam.hasAudio) RoundIcon(if (muted) Icons.AutoMirrored.Rounded.VolumeOff else Icons.AutoMirrored.Rounded.VolumeUp, "Sound", size = 40.dp, background = Color(0x33000000)) { muted = !muted }
                    }
                    Column(
                        Modifier.align(Alignment.BottomCenter).fillMaxWidth().background(Brush.verticalGradient(listOf(Color.Transparent, Color(0xB3000000), Color(0xE6000000)))).padding(horizontal = 16.dp, vertical = 10.dp),
                    ) {
                        timeline(Modifier)
                        transport()
                    }
                }
            }
        }
        if (showGoTo) GoToDialog(state.serverNow(), onDismiss = { showGoTo = false }) { showGoTo = false; seekTo(it) }
        return
    }

    Backdrop {
        Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding()) {
            // Header
            Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                RoundIcon(Icons.AutoMirrored.Rounded.ArrowBack, "Back", size = 40.dp, background = Color(0x10FFFFFF), onClick = onBack)
                Column(Modifier.weight(1f).padding(horizontal = 12.dp)) {
                    Text(cam.name, style = MaterialTheme.typography.titleLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    val st = cam.recorder?.stream
                    if (st != null && st.width > 0) Text("${st.width}×${st.height} · ${st.videoCodec.uppercase()}${if (st.fps > 0) " · ${st.fps.toInt()} fps" else ""}", color = C.TextFaint, fontSize = 12.sp)
                }
                StatePill(if (cam.occasional && cam.state != "recording") "offline" else cam.state)
            }
            // Video, with its controls on top (tap the picture to show or hide them).
            Box(
                Modifier.padding(horizontal = 12.dp).fillMaxWidth().aspectRatio(aspect.coerceIn(0.6f, 2.4f)).clip(RoundedCornerShape(20.dp)).background(Color.Black)
                    .border(1.dp, if (cam.motion?.active == true) C.Amber.copy(alpha = 0.8f) else C.GlassBorder, RoundedCornerShape(20.dp)),
            ) {
                video()
                Box(Modifier.align(Alignment.TopStart).padding(10.dp).clip(CircleShape).background(Color(0x99000000)).padding(horizontal = 10.dp, vertical = 5.dp)) { timeLabel() }
                if (live) ConnectionPill(conn, Modifier.align(Alignment.TopEnd).padding(10.dp))
                else Row(
                    Modifier.align(Alignment.TopEnd).padding(10.dp).clip(CircleShape).background(C.Rose).clickable { goLive() }.padding(horizontal = 12.dp, vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    PulsingDot(Color.White, size = 7.dp)
                    Text("  Back to live", color = Color.White, fontSize = 12.sp, fontWeight = FontWeight.Bold)
                }
                androidx.compose.animation.AnimatedVisibility(controlsVisible && !tl.scrubbing, enter = fadeIn(), exit = fadeOut(), modifier = Modifier.align(Alignment.Center)) {
                    Box(
                        Modifier.size(62.dp).clip(CircleShape).background(Color(0x80000000)).clickable {
                            lastTouch = System.currentTimeMillis()
                            if (live) seekTo(state.serverNow() - 15_000) else rec.togglePlay()
                        },
                        contentAlignment = Alignment.Center,
                    ) { Icon(if (playing) Icons.Rounded.Pause else Icons.Rounded.PlayArrow, if (playing) "Pause" else "Play", tint = Color.White, modifier = Modifier.size(34.dp)) }
                }
                androidx.compose.animation.AnimatedVisibility(controlsVisible, enter = fadeIn(), exit = fadeOut(), modifier = Modifier.align(Alignment.BottomStart)) {
                    if (cam.hasAudio) RoundIcon(
                        if (muted) Icons.AutoMirrored.Rounded.VolumeOff else Icons.AutoMirrored.Rounded.VolumeUp, if (muted) "Turn sound on" else "Turn sound off",
                        Modifier.padding(10.dp), size = 38.dp, background = if (muted) Color(0x80000000) else C.Violet,
                    ) { muted = !muted; lastTouch = System.currentTimeMillis() }
                }
                androidx.compose.animation.AnimatedVisibility(controlsVisible, enter = fadeIn(), exit = fadeOut(), modifier = Modifier.align(Alignment.BottomEnd)) {
                    RoundIcon(Icons.Rounded.Fullscreen, "Fullscreen", Modifier.padding(10.dp), size = 38.dp, background = Color(0x80000000)) { toggleFullscreen() }
                }
            }
            Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
                // Timeline header: what's in view, and zoom buttons for those who don't pinch.
                Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 12.dp, top = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(fmtDay(timelineCenter, state.serverNow()), color = C.Text, fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
                    Text("  ·  ${spanLabel(tl.span)} in view", color = C.TextFaint, fontSize = 12.sp, modifier = Modifier.weight(1f))
                    RoundIcon(Icons.Rounded.ZoomOut, "Show more time", size = 34.dp, background = Color(0x10FFFFFF)) { tl.span = (tl.span * 2f).coerceAtMost(TimelineState.MAX_SPAN) }
                    RoundIcon(Icons.Rounded.ZoomIn, "Show less time", Modifier.padding(start = 6.dp), size = 34.dp, background = Color(0x10FFFFFF)) { tl.span = (tl.span / 2f).coerceAtLeast(TimelineState.MIN_SPAN) }
                }
                timeline(Modifier.padding(horizontal = 12.dp))
                AnimatedVisibility(clipRange != null, enter = expandVertically() + fadeIn(), exit = shrinkVertically() + fadeOut()) {
                    clipRange?.let { r ->
                        ClipPanel(r, cam.name, saving = savingClip, onCancel = { clipRange = null }) { name ->
                            savingClip = true
                            scope.launch {
                                runCatching { api.createClip(cam.id, r.first, r.second, name) }
                                    .onSuccess { Toaster.show("Saving “${it.name}” — it'll be in Clips"); clipRange = null }
                                    .onFailure { Toaster.error(it.message ?: "Couldn't save the clip") }
                                savingClip = false
                            }
                        }
                    }
                }
                Gap(8.dp)
                transport()
                Gap(16.dp)
                actions()
                if (!prefs.tipsSeen) Tips { state.setPrefs { it.copy(tipsSeen = true) } }
                Gap(20.dp)
                if (todayEvents.isNotEmpty()) {
                    val shown = todayEvents.filter { ofKind(it) }
                    Row(Modifier.padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text("LAST 24 HOURS · ${shown.size}", color = C.TextDim, style = MaterialTheme.typography.labelSmall, modifier = Modifier.weight(1f))
                        listOf("all" to "All", "person" to "People", "animal" to "Animals").forEach { (k, l) ->
                            Text(
                                l, color = if (jump == k) Color.White else C.TextDim, fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
                                modifier = Modifier.padding(start = 6.dp).clip(CircleShape).background(if (jump == k) Color(0x26FFFFFF) else Color.Transparent).clickable { jump = k }.padding(horizontal = 10.dp, vertical = 4.dp),
                            )
                        }
                    }
                    Gap(10.dp)
                    if (shown.isEmpty()) Text(
                        "No ${if (jump == "person") "people" else "animals"} in the last 24 hours", color = C.TextFaint, fontSize = 13.sp, modifier = Modifier.padding(horizontal = 16.dp),
                    ) else LazyRow(contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 12.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        items(shown, key = { it.id }) { e ->
                            EventThumb(state, e, cam.aspect) { seekTo(e.bestTime - 2000) }
                        }
                    }
                    Gap(20.dp)
                }
                OtherCameras(state, cam.id, onOpenCamera)
                Gap(24.dp)
            }
        }
    }
    if (showGoTo) GoToDialog(state.serverNow(), onDismiss = { showGoTo = false }) { showGoTo = false; seekTo(it) }
}

/** The picture: live (substream first, full quality fading in over it) or a recording; while scrubbing, preview frames. */
@Composable
private fun BoxScope.VideoArea(
    state: AppState,
    cam: CameraStatus,
    live: Boolean,
    sub: LivePlayer,
    main: LivePlayer,
    rec: RecordingPlayer,
    showMain: Boolean,
    scrubbing: Boolean,
    scrubTime: Long,
    loading: Boolean,
    onTexture: (TextureView?) -> Unit,
    onTap: () -> Unit,
) {
    val context = LocalContext.current
    var zoom by remember { mutableFloatStateOf(1f) }
    var pan by remember { mutableStateOf(Offset.Zero) }
    val mainAlpha by animateFloatAsState(if (showMain) 1f else 0f, tween(350), label = "main")
    Box(
        Modifier.fillMaxSize()
            .pointerInput(Unit) {
                detectTapGestures(
                    onDoubleTap = { if (zoom > 1.05f) { zoom = 1f; pan = Offset.Zero } else zoom = 2.5f },
                    onTap = { onTap() },
                )
            }
            .pointerInput(Unit) {
                detectTransformGestures { _, p, z, _ ->
                    zoom = (zoom * z).coerceIn(1f, 8f)
                    val maxX = size.width * (zoom - 1) / 2
                    val maxY = size.height * (zoom - 1) / 2
                    pan = if (zoom <= 1f) Offset.Zero else Offset((pan.x + p.x).coerceIn(-maxX, maxX), (pan.y + p.y).coerceIn(-maxY, maxY))
                }
            },
    ) {
        Box(Modifier.fillMaxSize().graphicsLayer { scaleX = zoom; scaleY = zoom; translationX = pan.x; translationY = pan.y }) {
            AsyncImage(state.api.latestUrl(cam.id), null, contentScale = ContentScale.Fit, modifier = Modifier.fillMaxSize())
            if (live) {
                VideoSurface(sub.exo, Modifier.fillMaxSize(), onView = { if (!showMain) onTexture(it) })
                VideoSurface(main.exo, Modifier.fillMaxSize().graphicsLayer { alpha = mainAlpha }, onView = onTexture)
            } else {
                VideoSurface(rec.exo, Modifier.fillMaxSize(), onView = onTexture)
            }
        }
        // Scrubbing: show preview frames of that moment, keeping the last one until the next arrives.
        if (scrubbing) {
            var lastKey by remember { mutableStateOf<String?>(null) }
            val url = state.api.previewUrl(cam.id, scrubTime)
            AsyncImage(
                model = ImageRequest.Builder(context).data(url).placeholderMemoryCacheKey(lastKey).crossfade(false).build(),
                contentDescription = null,
                contentScale = ContentScale.Fit,
                modifier = Modifier.fillMaxSize().background(Color.Black),
                onSuccess = { lastKey = url },
            )
        }
        if (loading && !scrubbing) CircularProgressIndicator(Modifier.align(Alignment.Center).size(34.dp), color = Color.White.copy(alpha = 0.8f), strokeWidth = 3.dp)
    }
}

private fun spanLabel(span: Float): String = when {
    span >= DAY -> "${(span / DAY).let { if (it % 1f == 0f) it.toInt().toString() else "%.1f".format(it) }} day${if (span >= 2 * DAY) "s" else ""}"
    span >= HOUR -> "${(span / HOUR).let { if (it % 1f < 0.05f) it.toInt().toString() else "%.1f".format(it) }} h"
    else -> "${(span / MINUTE).toInt()} min"
}

/** A square action button with its label underneath. */
@Composable
private fun ActionTile(label: String, icon: ImageVector, modifier: Modifier = Modifier, highlighted: Boolean = false, enabled: Boolean = true, onClick: () -> Unit) {
    val shape = RoundedCornerShape(16.dp)
    Column(
        modifier
            .graphicsLayer { alpha = if (enabled) 1f else 0.35f }
            .clip(shape)
            .then(if (highlighted) Modifier.background(C.accent) else Modifier.background(Color(0x0DFFFFFF)).border(1.dp, C.GlassBorder, shape))
            .clickable(enabled = enabled, onClick = onClick)
            .padding(vertical = 12.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Icon(icon, null, tint = Color.White, modifier = Modifier.size(22.dp))
        Text(label, color = Color.White, fontSize = 11.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 6.dp, start = 4.dp, end = 4.dp))
    }
}

/** First-time help for the camera page. */
@Composable
private fun Tips(onDismiss: () -> Unit) {
    Column(Modifier.padding(start = 12.dp, end = 12.dp, top = 10.dp).fillMaxWidth().glass().padding(14.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Rounded.TipsAndUpdates, null, tint = C.Amber, modifier = Modifier.size(20.dp))
            Text("  Quick tips", fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
            Text("Got it", color = C.VioletLight, fontWeight = FontWeight.SemiBold, fontSize = 13.sp, modifier = Modifier.clip(CircleShape).clickable(onClick = onDismiss).padding(horizontal = 10.dp, vertical = 4.dp))
        }
        Gap(8.dp)
        listOf(
            "Drag the timeline left or right to go back in time; let go to play from there.",
            "Pinch the timeline (or use − / +) to see minutes or whole days.",
            "Amber bars are motion; ⏮ ⏭ jump between them.",
            "Pinch or double-tap the picture to zoom in.",
        ).forEach { Text("•  $it", color = C.TextDim, fontSize = 13.sp, modifier = Modifier.padding(vertical = 2.dp)) }
    }
}

@Composable
private fun ActionChip(text: String, icon: ImageVector?, highlighted: Boolean = false, enabled: Boolean = true, onClick: () -> Unit) {
    Row(
        Modifier
            .graphicsLayer { alpha = if (enabled) 1f else 0.4f }
            .clip(CircleShape)
            .then(if (highlighted) Modifier.background(C.accentH) else Modifier.background(Color(0x0DFFFFFF)).border(1.dp, C.GlassBorder, CircleShape))
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (icon != null) Icon(icon, null, tint = Color.White, modifier = Modifier.size(18.dp).padding(end = 0.dp))
        if (icon != null) Box(Modifier.width(6.dp))
        if (text == "Live" && highlighted) {
            PulsingDot(Color.White, size = 7.dp)
            Box(Modifier.width(6.dp))
        }
        Text(text, color = Color.White, fontSize = 13.sp, fontWeight = FontWeight.Medium)
    }
}

@Composable
private fun ClipPanel(range: Pair<Long, Long>, camName: String, saving: Boolean, onCancel: () -> Unit, onSave: (String) -> Unit) {
    var name by remember { mutableStateOf("$camName ${fmtTime(range.first)}") }
    Column(Modifier.padding(12.dp).fillMaxWidth().glass().padding(14.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Rounded.ContentCut, null, tint = C.Cyan, modifier = Modifier.size(18.dp))
            Text("  ${fmtTimeSec(range.first)} → ${fmtTimeSec(range.second)}", color = C.Text, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
            Text(fmtDuration(range.second - range.first), color = C.Cyan, fontWeight = FontWeight.SemiBold)
        }
        Text("Drag the cyan handles on the timeline to set the start and end.", color = C.TextFaint, fontSize = 12.sp, modifier = Modifier.padding(top = 4.dp))
        Gap(10.dp)
        OutlinedTextField(
            name, { name = it.take(80) }, label = { Text("Clip name") }, singleLine = true, shape = RoundedCornerShape(14.dp), modifier = Modifier.fillMaxWidth(),
            colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = C.Cyan, unfocusedBorderColor = C.GlassBorder, cursorColor = C.Cyan),
        )
        Gap(10.dp)
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            app.sentinel.ui.components.SubtleButton("Cancel", Modifier.weight(1f), onClick = onCancel)
            GradientButton("Save clip", Modifier.weight(1f).height(44.dp), enabled = name.isNotBlank(), loading = saving) { onSave(name.trim()) }
        }
    }
}

@Composable
fun EventThumb(state: AppState, e: SentinelEvent, aspect: Float, onClick: () -> Unit) {
    Column(Modifier.width(150.dp).clip(RoundedCornerShape(14.dp)).clickable(onClick = onClick)) {
        Box(Modifier.fillMaxWidth().aspectRatio(aspect.coerceIn(1f, 2f)).clip(RoundedCornerShape(14.dp)).background(C.Ink800)) {
            app.sentinel.ui.components.EventPicture(state.api, e, Modifier.fillMaxSize(), boxes = false)
            app.sentinel.ui.components.LabelChips(e.labels, Modifier.align(Alignment.TopStart).padding(6.dp), small = true)
            Box(Modifier.align(Alignment.BottomEnd).padding(6.dp).clip(CircleShape).background(Color(0xAA000000)).padding(horizontal = 6.dp, vertical = 2.dp)) {
                Text(if (e.ongoing) "now" else fmtDuration(e.end - e.start), color = Color.White, fontSize = 10.sp, fontWeight = FontWeight.SemiBold)
            }
        }
        Text(fmtTime(e.start), color = C.Text, fontSize = 13.sp, fontWeight = FontWeight.Medium, modifier = Modifier.padding(top = 6.dp, start = 2.dp))
    }
}

@Composable
private fun OtherCameras(state: AppState, current: String, onOpen: (String) -> Unit) {
    val status by state.status.collectAsStateWithLifecycle()
    val prefs by state.prefs.collectAsStateWithLifecycle()
    val others = state.orderedCameras(status, prefs).filter { it.id != current && it.enabled }
    if (others.isEmpty()) return
    Text("OTHER CAMERAS", color = C.TextDim, style = MaterialTheme.typography.labelSmall, modifier = Modifier.padding(horizontal = 16.dp))
    Gap(10.dp)
    LazyRow(contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 12.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        items(others, key = { it.id }) { c ->
            Column(Modifier.width(140.dp).clip(RoundedCornerShape(14.dp)).clickable { onOpen(c.id) }) {
                Box(Modifier.fillMaxWidth().aspectRatio(16f / 9f).clip(RoundedCornerShape(14.dp)).background(C.Ink800)
                    .border(1.dp, if (c.motion?.active == true) C.Amber else C.GlassBorder, RoundedCornerShape(14.dp))) {
                    AsyncImage(state.api.latestUrl(c.id), null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
                }
                Text(c.name, color = C.Text, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 6.dp, start = 2.dp))
            }
        }
    }
}

/** Jump to a moment: quick choices, or any date and time. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun GoToDialog(now: Long, onDismiss: () -> Unit, onGo: (Long) -> Unit) {
    var step by remember { mutableStateOf(0) }
    val dateState = rememberDatePickerState(initialSelectedDateMillis = now, selectableDates = object : androidx.compose.material3.SelectableDates {
        override fun isSelectableDate(utcTimeMillis: Long) = utcTimeMillis <= now + DAY
    })
    val cal = Calendar.getInstance().apply { timeInMillis = now }
    val timeState = rememberTimePickerState(cal.get(Calendar.HOUR_OF_DAY), cal.get(Calendar.MINUTE))
    DatePickerDialog(
        onDismissRequest = onDismiss,
        confirmButton = {
            TextButton({
                if (step == 0) step = 1 else {
                    val d = Calendar.getInstance().apply {
                        timeInMillis = dateState.selectedDateMillis ?: now
                        val y = get(Calendar.YEAR); val m = get(Calendar.MONTH); val day = get(Calendar.DAY_OF_MONTH)
                        timeZone = java.util.TimeZone.getDefault()
                        clear()
                        set(y, m, day, timeState.hour, timeState.minute, 0)
                    }
                    onGo(d.timeInMillis.coerceAtMost(now))
                }
            }) { Text(if (step == 0) "Next" else "Go", color = C.Cyan) }
        },
        dismissButton = { TextButton(onDismiss) { Text("Cancel", color = C.TextDim) } },
        colors = androidx.compose.material3.DatePickerDefaults.colors(containerColor = C.Ink850),
    ) {
        Column(Modifier.padding(bottom = 8.dp)) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp).horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                listOf("10 min ago" to 10 * MINUTE, "1 hour ago" to HOUR, "3 hours ago" to 3 * HOUR, "This time yesterday" to DAY).forEach { (label, d) ->
                    app.sentinel.ui.components.Chip(label, false) { onGo(now - d) }
                }
            }
            if (step == 0) DatePicker(dateState, showModeToggle = false, title = null, headline = null)
            else Box(Modifier.fillMaxWidth().padding(16.dp), contentAlignment = Alignment.Center) {
                TimePicker(timeState, colors = TimePickerDefaults.colors(clockDialColor = C.Ink700, selectorColor = C.Violet, timeSelectorSelectedContainerColor = C.Violet.copy(alpha = 0.3f)))
            }
        }
    }
}
