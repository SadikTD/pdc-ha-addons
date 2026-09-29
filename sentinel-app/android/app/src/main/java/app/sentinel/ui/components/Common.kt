package app.sentinel.ui.components

import android.view.TextureView
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.media3.exoplayer.ExoPlayer
import app.sentinel.core.TunnelState
import app.sentinel.core.stateLabel
import app.sentinel.ui.theme.C

/** Sentinel's shield logo. */
@Composable
fun Logo(modifier: Modifier = Modifier.size(40.dp)) {
    Canvas(modifier) {
        val w = size.width
        val h = size.height
        val s = w / 64f
        val shield = Path().apply {
            moveTo(32 * s, 4 * s)
            lineTo(8 * s, 13 * s)
            lineTo(8 * s, 30 * s)
            cubicTo(8 * s, 45 * s, 18.3f * s, 56.6f * s, 32 * s, 60 * s)
            cubicTo(45.7f * s, 56.6f * s, 56 * s, 45 * s, 56 * s, 30 * s)
            lineTo(56 * s, 13 * s)
            close()
        }
        drawPath(shield, Brush.linearGradient(listOf(C.Violet, C.Cyan), Offset.Zero, Offset(w, h)))
        drawCircle(Color(0xFF06080D), radius = 11 * s, center = Offset(32 * s, 31 * s))
        drawCircle(Color.White, radius = 5.5f * s, center = Offset(32 * s, 31 * s))
    }
}

/** Soft violet/cyan glows behind every screen, like the web UI. */
@Composable
fun Backdrop(modifier: Modifier = Modifier, content: @Composable BoxScope.() -> Unit) {
    Box(
        modifier
            .fillMaxSize()
            .background(C.Ink950)
            .background(Brush.radialGradient(listOf(C.Violet.copy(alpha = 0.13f), Color.Transparent), center = Offset(80f, -120f), radius = 1300f))
            .background(Brush.radialGradient(listOf(C.Cyan.copy(alpha = 0.08f), Color.Transparent), center = Offset(1400f, 200f), radius = 1000f)),
        content = content,
    )
}

fun Modifier.glass(shape: Shape = RoundedCornerShape(20.dp)): Modifier = this
    .clip(shape)
    .background(Brush.verticalGradient(listOf(Color(0x0DFFFFFF), Color(0x06FFFFFF))))
    .border(1.dp, C.GlassBorder, shape)

@Composable
fun GlassCard(modifier: Modifier = Modifier, padding: PaddingValues = PaddingValues(16.dp), onClick: (() -> Unit)? = null, content: @Composable () -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    Box(
        modifier
            .scale(if (pressed) 0.985f else 1f)
            .glass()
            .then(if (onClick != null) Modifier.clickable(interaction, indication = null, onClick = onClick) else Modifier)
            .padding(padding),
    ) { content() }
}

/** The primary action: violet→cyan gradient, springy press. */
@Composable
fun GradientButton(text: String, modifier: Modifier = Modifier, enabled: Boolean = true, loading: Boolean = false, icon: ImageVector? = null, onClick: () -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    Box(
        modifier
            .height(52.dp)
            .scale(if (pressed) 0.97f else 1f)
            .graphicsLayer { alpha = if (enabled) 1f else 0.45f }
            .clip(RoundedCornerShape(16.dp))
            .background(C.accentH)
            .clickable(interaction, indication = null, enabled = enabled && !loading, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (loading) CircularProgressIndicator(Modifier.size(18.dp), color = Color.White, strokeWidth = 2.dp)
            else if (icon != null) Icon(icon, null, tint = Color.White, modifier = Modifier.size(20.dp))
            Text(text, color = Color.White, style = MaterialTheme.typography.labelLarge, fontSize = 16.sp)
        }
    }
}

@Composable
fun SubtleButton(text: String, modifier: Modifier = Modifier, icon: ImageVector? = null, tint: Color = C.Text, onClick: () -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    Row(
        modifier
            .height(44.dp)
            .scale(if (pressed) 0.96f else 1f)
            .clip(RoundedCornerShape(14.dp))
            .background(Color(0x0AFFFFFF))
            .border(1.dp, C.GlassBorder, RoundedCornerShape(14.dp))
            .clickable(interaction, indication = null, onClick = onClick)
            .padding(horizontal = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally),
    ) {
        if (icon != null) Icon(icon, null, tint = tint, modifier = Modifier.size(18.dp))
        Text(text, color = tint, style = MaterialTheme.typography.labelLarge)
    }
}

/** A round icon button with a glassy background. */
@Composable
fun RoundIcon(icon: ImageVector, contentDescription: String?, modifier: Modifier = Modifier, size: Dp = 44.dp, tint: Color = Color.White, background: Color = Color(0x1AFFFFFF), onClick: () -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    Box(
        modifier
            .size(size)
            .scale(if (pressed) 0.88f else 1f)
            .clip(CircleShape)
            .background(background)
            .clickable(interaction, indication = null, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) { Icon(icon, contentDescription, tint = tint, modifier = Modifier.size(size * 0.48f)) }
}

@Composable
fun PulsingDot(color: Color, modifier: Modifier = Modifier, size: Dp = 8.dp, pulse: Boolean = true) {
    val t = rememberInfiniteTransition(label = "dot")
    val a by t.animateFloat(1f, if (pulse) 0.4f else 1f, infiniteRepeatable(tween(800, easing = FastOutSlowInEasing), RepeatMode.Reverse), label = "a")
    Box(modifier.size(size).graphicsLayer { alpha = a; scaleX = 0.8f + 0.2f * a; scaleY = 0.8f + 0.2f * a }.clip(CircleShape).background(color))
}

fun stateColor(state: String): Color = when (state) {
    "recording" -> C.Rose
    "starting" -> C.Sky
    "stalled", "reconnecting" -> C.Amber
    else -> C.TextFaint
}

@Composable
fun StatePill(state: String, compact: Boolean = false) {
    val color = stateColor(state)
    Row(
        Modifier
            .clip(CircleShape)
            // Over video (compact) the pill needs a dark base to stay readable.
            .background(if (compact) Color(0x99000000) else color.copy(alpha = 0.14f))
            .border(1.dp, color.copy(alpha = if (compact) 0.5f else 0.3f), CircleShape)
            .padding(horizontal = if (compact) 7.dp else 10.dp, vertical = if (compact) 3.dp else 5.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(5.dp),
    ) {
        PulsingDot(color, size = 6.dp, pulse = state == "recording")
        Text(
            if (compact && state == "recording") "REC" else stateLabel(state).let { if (compact) it.uppercase() else it },
            color = color.copy(alpha = 0.95f).let { if (state == "recording") C.RoseLight else it },
            fontSize = if (compact) 10.sp else 12.sp,
            fontWeight = FontWeight.SemiBold,
            letterSpacing = if (compact) 0.6.sp else 0.sp,
        )
    }
}

/** Where the connection goes: home Wi-Fi or across the internet, with the round trip. */
@Composable
fun ConnectionPill(st: TunnelState, modifier: Modifier = Modifier) {
    val (label, color) = when (st.state) {
        "connected" -> when (st.path) {
            "home" -> "Home"
            "relay" -> "Relay"
            else -> "Direct"
        } + (if (st.rttMs > 0) " · ${st.rttMs} ms" else "") to (if (st.path == "relay") C.Cyan else C.Emerald)
        "connecting" -> "Connecting…" to C.Sky
        "offline" -> "Offline" to C.Rose
        else -> "Standby" to C.TextDim
    }
    Row(
        modifier
            .clip(CircleShape)
            .background(color.copy(alpha = 0.12f))
            .border(1.dp, color.copy(alpha = 0.25f), CircleShape)
            .padding(horizontal = 10.dp, vertical = 5.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        PulsingDot(color, size = 6.dp, pulse = st.state == "connecting" || st.state == "connected")
        Text(label, color = color, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
    }
}

@Composable
fun SectionTitle(text: String, modifier: Modifier = Modifier, action: @Composable RowScope.() -> Unit = {}) {
    Row(modifier.fillMaxWidth().padding(top = 8.dp, bottom = 10.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(text.uppercase(), color = C.TextDim, style = MaterialTheme.typography.labelSmall, modifier = Modifier.weight(1f))
        action()
    }
}

@Composable
fun Shimmer(modifier: Modifier) {
    val t = rememberInfiniteTransition(label = "shimmer")
    val x by t.animateFloat(-1f, 2f, infiniteRepeatable(tween(1400, easing = LinearEasing)), label = "x")
    Box(
        modifier.background(
            Brush.linearGradient(
                listOf(C.Ink800, C.Ink700, C.Ink800),
                start = Offset(x * 800f, 0f),
                end = Offset(x * 800f + 800f, 0f),
            ),
        ),
    )
}

@Composable
fun EmptyState(icon: ImageVector, title: String, sub: String? = null, modifier: Modifier = Modifier, action: @Composable () -> Unit = {}) {
    Column(modifier.fillMaxWidth().padding(horizontal = 32.dp, vertical = 48.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Box(Modifier.size(64.dp).glass(RoundedCornerShape(20.dp)), contentAlignment = Alignment.Center) {
            Icon(icon, null, tint = C.TextDim, modifier = Modifier.size(28.dp))
        }
        Spacer(Modifier.height(16.dp))
        Text(title, style = MaterialTheme.typography.titleMedium, color = C.Text)
        if (sub != null) {
            Spacer(Modifier.height(6.dp))
            Text(sub, style = MaterialTheme.typography.bodyMedium, color = C.TextDim, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
        }
        Spacer(Modifier.height(16.dp))
        action()
    }
}

/** Renders an ExoPlayer into a TextureView (so it can be zoomed and animated). */
@Composable
fun VideoSurface(player: ExoPlayer, modifier: Modifier = Modifier, onView: (TextureView?) -> Unit = {}) {
    AndroidView(
        factory = { ctx -> TextureView(ctx).also { player.setVideoTextureView(it); onView(it) } },
        modifier = modifier,
        update = { tv -> player.setVideoTextureView(tv) },
        onRelease = { tv -> player.clearVideoTextureView(tv); onView(null) },
    )
}

@Composable
fun FadeIn(visible: Boolean, content: @Composable () -> Unit) {
    AnimatedVisibility(visible, enter = fadeIn(tween(250)), exit = fadeOut(tween(200))) { content() }
}

@Composable
fun Chip(text: String, selected: Boolean, modifier: Modifier = Modifier, icon: ImageVector? = null, onClick: () -> Unit) {
    val shape = CircleShape
    Row(
        modifier
            .clip(shape)
            .then(if (selected) Modifier.background(C.accentH) else Modifier.background(Color(0x0AFFFFFF)).border(1.dp, C.GlassBorder, shape))
            .clickable(onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        if (icon != null) Icon(icon, null, tint = if (selected) Color.White else C.TextDim, modifier = Modifier.size(16.dp))
        Text(text, color = if (selected) Color.White else C.Text, fontSize = 13.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
fun Stat(label: String, value: String, modifier: Modifier = Modifier, sub: String? = null, accent: Color = C.Text) {
    Column(modifier) {
        Text(label.uppercase(), color = C.TextFaint, style = MaterialTheme.typography.labelSmall)
        Spacer(Modifier.height(4.dp))
        Text(value, color = accent, style = MaterialTheme.typography.titleLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
        if (sub != null) Text(sub, color = C.TextFaint, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
fun ProgressBar(fraction: Float, modifier: Modifier = Modifier, brush: Brush = C.accentH) {
    Box(modifier.height(8.dp).clip(CircleShape).background(C.Ink700)) {
        Box(Modifier.fillMaxWidth(fraction.coerceIn(0f, 1f)).height(8.dp).clip(CircleShape).background(brush))
    }
}

@Composable
fun Gap(h: Dp) = Spacer(Modifier.height(h))

@Composable
fun HGap(w: Dp) = Spacer(Modifier.width(w))
