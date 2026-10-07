package app.sentinel.ui.components

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.AutoAwesome
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.CloudDownload
import androidx.compose.material.icons.rounded.ErrorOutline
import androidx.compose.material.icons.rounded.PauseCircle
import androidx.compose.material.icons.rounded.SystemUpdate
import androidx.compose.material.icons.rounded.VerifiedUser
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.sentinel.core.Update
import app.sentinel.core.Updater
import app.sentinel.core.fmtBytes
import app.sentinel.ui.theme.C
import kotlinx.coroutines.delay

/** Seconds the "Updating in…" message shows before the update installs by itself. */
private const val COUNTDOWN = 5

/**
 * The app updating itself, at the top of every screen: download progress, then a short
 * countdown (with "Later" and "Update now") before it installs, a quiet note while a
 * video is being watched (it installs when that ends), and a one-time "allow" step.
 */
@Composable
fun UpdateBanner() {
    val context = LocalContext.current
    val st by Updater.state.collectAsStateWithLifecycle()
    val watching by Updater.watching.collectAsStateWithLifecycle()
    val postponed by Updater.postponed.collectAsStateWithLifecycle()
    // Re-checked on coming back from Android's settings (the one-time "allow" switch).
    var resumes by remember { mutableIntStateOf(0) }
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { resumes++ }
    val canInstall = remember(resumes, st) { Updater.canInstall(context) }
    // The quiet notes ("installs when you stop watching", "ready") show for a moment and
    // then get out of the way of the screen's own header; More → App updates keeps them.
    val quiet = st is Update.Ready && (postponed || watching > 0)
    var noteGone by remember(quiet, postponed) { mutableStateOf(false) }
    LaunchedEffect(quiet, postponed) {
        if (quiet) {
            delay(4000)
            noteGone = true
        }
    }

    val view: BannerView? = when (val s = st) {
        Update.Idle -> null
        Update.Checking -> BannerView.Checking
        is Update.Downloading -> BannerView.Downloading(s.release.version, s.progress, s.release.size)
        is Update.Ready -> when {
            !canInstall && !postponed -> BannerView.Allow(s.release.version)
            postponed -> if (noteGone) null else BannerView.Later(s.release.version)
            watching > 0 -> if (noteGone) null else BannerView.Waiting(s.release.version)
            else -> BannerView.Countdown(s.release.version)
        }
        is Update.Installing -> BannerView.Installing(s.release.version)
        is Update.Failed -> BannerView.Failed(s.message)
    }

    Box(Modifier.fillMaxWidth().statusBarsPadding().padding(top = 8.dp, start = 14.dp, end = 14.dp), contentAlignment = Alignment.TopCenter) {
        AnimatedContent(
            view,
            contentKey = { it?.javaClass },
            transitionSpec = {
                (slideInVertically(spring(dampingRatio = 0.75f, stiffness = 400f)) { -it } + fadeIn() + scaleIn(initialScale = 0.94f)) togetherWith
                    (slideOutVertically(tween(220)) { -it } + fadeOut(tween(180)))
            },
            label = "update",
        ) { v ->
            when (v) {
                null -> Box(Modifier)
                BannerView.Checking -> Pill(Icons.Rounded.SystemUpdate, "Checking for updates…", spinning = true)
                is BannerView.Downloading -> DownloadCard(v)
                is BannerView.Allow -> Card(accent = C.Cyan) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        IconBadge(Icons.Rounded.VerifiedUser)
                        Column(Modifier.weight(1f).padding(start = 14.dp)) {
                            Text("One step to finish updating", color = C.Text, fontWeight = FontWeight.SemiBold, fontSize = 15.sp)
                            Text("Allow Sentinel to install its own updates. You only do this once.", color = C.TextDim, fontSize = 13.sp)
                        }
                    }
                    Buttons("Not now", { Updater.postponed.value = true }, "Allow") { Updater.allowInstalls(context) }
                }
                is BannerView.Waiting -> Pill(Icons.Rounded.PauseCircle, "Update ${v.version} ready · installs when you stop watching")
                is BannerView.Later -> Pill(Icons.Rounded.SystemUpdate, "Sentinel ${v.version} is ready", action = "Install") { Updater.install(context) }
                is BannerView.Countdown -> CountdownCard(v.version)
                is BannerView.Installing -> Card {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Box(Modifier.size(44.dp), contentAlignment = Alignment.Center) {
                            CircularProgressIndicator(Modifier.size(36.dp), color = C.Cyan, strokeWidth = 3.dp, trackColor = C.Ink700)
                        }
                        Column(Modifier.weight(1f).padding(start = 14.dp)) {
                            Text("Installing Sentinel ${v.version}…", color = C.Text, fontWeight = FontWeight.SemiBold, fontSize = 15.sp)
                            Text("Sentinel closes for a moment. Tap the “Sentinel updated” notification to open it again.", color = C.TextDim, fontSize = 13.sp)
                        }
                    }
                }
                is BannerView.Failed -> Card(accent = C.Rose) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        IconBadge(Icons.Rounded.ErrorOutline, Brush.linearGradient(listOf(C.Rose, C.Amber)))
                        Column(Modifier.weight(1f).padding(start = 14.dp)) {
                            Text("Update didn't finish", color = C.Text, fontWeight = FontWeight.SemiBold, fontSize = 15.sp)
                            Text(v.message, color = C.TextDim, fontSize = 13.sp)
                        }
                        Icon(Icons.Rounded.Close, "Close", tint = C.TextDim, modifier = Modifier.size(34.dp).clip(CircleShape).clickable { Updater.dismiss() }.padding(7.dp))
                    }
                    Buttons(null, {}, "Try again") { Updater.dismiss(); Updater.check(context, manual = true) }
                }
            }
        }
    }
}

private sealed interface BannerView {
    data object Checking : BannerView
    data class Downloading(val version: String, val progress: Float, val size: Long) : BannerView
    data class Allow(val version: String) : BannerView
    data class Waiting(val version: String) : BannerView
    data class Later(val version: String) : BannerView
    data class Countdown(val version: String) : BannerView
    data class Installing(val version: String) : BannerView
    data class Failed(val message: String) : BannerView
}

@Composable
private fun DownloadCard(v: BannerView.Downloading) {
    val p by animateFloatAsState(v.progress, spring(stiffness = 300f), label = "p")
    Card {
        Row(verticalAlignment = Alignment.CenterVertically) {
            val pulse = rememberInfiniteTransition(label = "pulse").animateFloat(0.75f, 1f, infiniteRepeatable(tween(700), RepeatMode.Reverse), label = "a")
            IconBadge(Icons.Rounded.CloudDownload, modifier = Modifier.graphicsLayer { alpha = pulse.value })
            Column(Modifier.weight(1f).padding(start = 14.dp)) {
                Text("Updating Sentinel", color = C.Text, fontWeight = FontWeight.SemiBold, fontSize = 15.sp)
                Text(
                    "Version ${v.version}" + if (v.size > 0) " · ${fmtBytes((v.size * v.progress).toLong())} of ${fmtBytes(v.size)}" else "",
                    color = C.TextDim, fontSize = 13.sp,
                )
            }
            Text("${(v.progress * 100).toInt()}%", style = MaterialTheme.typography.titleMedium.copy(brush = C.textAccent))
        }
        Box(Modifier.padding(top = 12.dp)) { ProgressBar(p, Modifier.fillMaxWidth()) }
    }
}

@Composable
private fun CountdownCard(version: String) {
    val context = LocalContext.current
    var left by remember { mutableIntStateOf(COUNTDOWN) }
    LaunchedEffect(Unit) {
        while (left > 0) {
            delay(1000)
            left--
        }
        Updater.install(context)
    }
    val sweep by animateFloatAsState(left / COUNTDOWN.toFloat(), tween(950), label = "sweep")
    Card {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(44.dp), contentAlignment = Alignment.Center) {
                Canvas(Modifier.fillMaxSize()) {
                    val w = 3.5.dp.toPx()
                    val inset = Offset(w / 2, w / 2)
                    val sz = Size(size.width - w, size.height - w)
                    drawArc(C.Ink700, 0f, 360f, false, inset, sz, style = Stroke(w))
                    drawArc(Brush.sweepGradient(listOf(C.Violet, C.Cyan, C.Violet)), -90f, 360f * sweep, false, inset, sz, style = Stroke(w, cap = StrokeCap.Round))
                }
                Text("$left", color = C.Text, fontWeight = FontWeight.Bold, fontSize = 16.sp)
            }
            Column(Modifier.weight(1f).padding(start = 14.dp)) {
                Text("Updating to Sentinel $version", color = C.Text, fontWeight = FontWeight.SemiBold, fontSize = 15.sp)
                Text("Sentinel closes for a moment to finish. Tap “Sentinel updated” to open it again.", color = C.TextDim, fontSize = 13.sp)
            }
        }
        Buttons("Later", { Updater.postponed.value = true }, "Update now") { Updater.install(context) }
    }
}

@Composable
private fun Card(accent: Color = C.Violet, content: @Composable () -> Unit) {
    Column(
        Modifier
            .widthIn(max = 560.dp)
            .fillMaxWidth()
            .clip(RoundedCornerShape(22.dp))
            .background(C.Ink850)
            .border(1.dp, Brush.linearGradient(listOf(accent.copy(alpha = 0.55f), C.GlassBorder, C.Cyan.copy(alpha = 0.25f))), RoundedCornerShape(22.dp))
            .padding(14.dp),
    ) { content() }
}

@Composable
private fun IconBadge(icon: ImageVector, brush: Brush = C.accent, modifier: Modifier = Modifier) {
    Box(modifier.size(44.dp).clip(RoundedCornerShape(14.dp)).background(brush), contentAlignment = Alignment.Center) {
        Icon(icon, null, tint = Color.White, modifier = Modifier.size(24.dp))
    }
}

/** A quiet secondary action and the main one, right-aligned under the message. */
@Composable
private fun Buttons(secondary: String?, onSecondary: () -> Unit, primary: String, onPrimary: () -> Unit) {
    Row(Modifier.fillMaxWidth().padding(top = 12.dp), horizontalArrangement = Arrangement.End, verticalAlignment = Alignment.CenterVertically) {
        if (secondary != null) Text(
            secondary, color = C.TextDim, fontSize = 14.sp, fontWeight = FontWeight.SemiBold,
            modifier = Modifier.clip(RoundedCornerShape(12.dp)).clickable(onClick = onSecondary).padding(horizontal = 14.dp, vertical = 9.dp),
        )
        Text(
            primary, color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.SemiBold,
            modifier = Modifier.padding(start = 6.dp).clip(RoundedCornerShape(12.dp)).background(C.accentH).clickable(onClick = onPrimary).padding(horizontal = 16.dp, vertical = 9.dp),
        )
    }
}

/** A small note at the top (tappable when it has an action). */
@Composable
private fun Pill(icon: ImageVector, text: String, spinning: Boolean = false, action: String? = null, onAction: () -> Unit = {}) {
    Row(
        Modifier
            .clip(CircleShape)
            .background(C.Ink850)
            .border(1.dp, C.Violet.copy(alpha = 0.4f), CircleShape)
            .then(if (action != null) Modifier.clickable(onClick = onAction) else Modifier)
            .padding(start = 12.dp, end = if (action != null) 6.dp else 14.dp, top = 7.dp, bottom = 7.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (spinning) CircularProgressIndicator(Modifier.size(16.dp), color = C.Cyan, strokeWidth = 2.dp)
        else Icon(icon, null, tint = C.Cyan, modifier = Modifier.size(18.dp))
        Text("  $text", color = C.Text, fontSize = 13.sp, fontWeight = FontWeight.Medium)
        if (action != null) Text(
            action, color = Color.White, fontSize = 13.sp, fontWeight = FontWeight.Bold,
            modifier = Modifier.padding(start = 10.dp).clip(CircleShape).background(C.accentH).padding(horizontal = 12.dp, vertical = 5.dp),
        )
    }
}

/** "What's new" after the app updated itself (once). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun WhatsNewSheet(version: String, notes: String, onDone: () -> Unit) {
    val items = notes.lines().map { it.trim() }.filter { it.isNotEmpty() && !it.startsWith("#") }.map { it.removePrefix("-").removePrefix("•").removePrefix("*").trim() }
    val navBottom = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()
    ModalBottomSheet(onDone, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = C.Ink850) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 24.dp).padding(bottom = 16.dp + navBottom), horizontalAlignment = Alignment.CenterHorizontally) {
            Box(Modifier.size(64.dp).clip(CircleShape).background(C.accent), contentAlignment = Alignment.Center) {
                Icon(Icons.Rounded.AutoAwesome, null, tint = Color.White, modifier = Modifier.size(32.dp))
            }
            Gap(14.dp)
            Text("Sentinel is up to date", style = MaterialTheme.typography.titleLarge)
            Text("Version $version · what's new", color = C.TextDim, fontSize = 14.sp)
            Gap(18.dp)
            Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(18.dp)).background(Color(0x0AFFFFFF)).padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                (items.ifEmpty { listOf("Improvements and fixes") }).forEach { line ->
                    Row {
                        Box(Modifier.padding(top = 8.dp).size(6.dp).clip(CircleShape).background(C.accent))
                        Text(line, color = C.Text, fontSize = 14.sp, modifier = Modifier.padding(start = 12.dp))
                    }
                }
            }
            Gap(20.dp)
            GradientButton("Got it", Modifier.fillMaxWidth(), onClick = onDone)
        }
    }
}
