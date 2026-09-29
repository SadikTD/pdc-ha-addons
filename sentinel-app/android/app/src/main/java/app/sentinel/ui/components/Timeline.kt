package app.sentinel.ui.components

import androidx.compose.animation.core.AnimationState
import androidx.compose.animation.core.animateDecay
import androidx.compose.animation.core.exponentialDecay
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.calculateZoom
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChange
import androidx.compose.ui.input.pointer.util.VelocityTracker
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.sentinel.core.DAY
import app.sentinel.core.HOUR
import app.sentinel.core.MINUTE
import app.sentinel.core.SECOND
import app.sentinel.core.SentinelEvent
import app.sentinel.core.Span
import app.sentinel.ui.theme.C
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale
import kotlin.math.abs
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

@Stable
class TimelineState(initialSpan: Long = 30 * MINUTE) {
    /** Milliseconds across the full width. */
    var span by mutableFloatStateOf(initialSpan.toFloat())
    var scrubbing by mutableStateOf(false)
    var scrubTime by mutableLongStateOf(0L)

    companion object {
        const val MIN_SPAN = 60_000f
        const val MAX_SPAN = 2f * DAY
    }
}

private val TICK_STEPS = longArrayOf(
    5 * SECOND, 10 * SECOND, 30 * SECOND, MINUTE, 2 * MINUTE, 5 * MINUTE, 10 * MINUTE, 15 * MINUTE,
    30 * MINUTE, HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR,
)

/**
 * A scrubbing timeline. The playhead stays in the middle: drag (or fling) the timeline
 * under it, pinch to zoom, tap to jump. Recorded footage is the gradient band, missing
 * footage is tinted red, motion events are the amber bars above (people, cats and dogs
 * in their colours).
 */
@Composable
fun Timeline(
    state: TimelineState,
    center: Long,
    now: Long,
    coverage: List<Span>,
    events: List<SentinelEvent>,
    onScrub: (Long) -> Unit,
    onSeek: (Long) -> Unit,
    modifier: Modifier = Modifier,
    height: Dp = 84.dp,
    clipRange: Pair<Long, Long>? = null,
    onClipRange: (Pair<Long, Long>) -> Unit = {},
) {
    val scope = rememberCoroutineScope()
    val haptic = LocalHapticFeedback.current
    val measurer = rememberTextMeasurer()
    val centerNow by rememberUpdatedState(center)
    val nowNow by rememberUpdatedState(now)
    val clip by rememberUpdatedState(clipRange)
    val onScrubL by rememberUpdatedState(onScrub)
    val onSeekL by rememberUpdatedState(onSeek)
    val onClipL by rememberUpdatedState(onClipRange)
    var fling by remember { mutableStateOf<Job?>(null) }
    val labelStyle = TextStyle(color = C.TextDim, fontSize = 10.sp)
    val dayStyle = TextStyle(color = C.VioletLight, fontSize = 10.sp)

    Canvas(
        modifier
            .fillMaxWidth()
            .height(height)
            .pointerInput(Unit) {
                val slop = viewConfiguration.touchSlop
                val handleHit = 28.dp.toPx()
                awaitEachGesture {
                    val down = awaitFirstDown(requireUnconsumed = false)
                    fling?.cancel()
                    val w = size.width.toFloat()
                    val msPerPx = { state.span / w }
                    val start = if (state.scrubbing) state.scrubTime else centerNow
                    state.scrubTime = start
                    // Grabbing a clip handle moves that end of the clip instead.
                    var handle = -1
                    clip?.let { (a, b) ->
                        val xa = w / 2 + (a - start) / msPerPx()
                        val xb = w / 2 + (b - start) / msPerPx()
                        handle = when {
                            abs(down.position.x - xb) < handleHit -> 1
                            abs(down.position.x - xa) < handleHit -> 0
                            else -> -1
                        }
                    }
                    val vt = VelocityTracker()
                    var moved = false
                    var zoomed = false
                    var total = 0f
                    var lastTick = start / tickFor(state.span, w)
                    while (true) {
                        val ev = awaitPointerEvent()
                        val pressed = ev.changes.filter { it.pressed }
                        if (pressed.isEmpty()) break
                        if (pressed.size >= 2) {
                            zoomed = true
                            val z = ev.calculateZoom()
                            if (z != 1f) state.span = (state.span / z).coerceIn(TimelineState.MIN_SPAN, TimelineState.MAX_SPAN)
                            ev.changes.forEach { it.consume() }
                            continue
                        }
                        if (zoomed) continue
                        val ch = pressed.first()
                        val dx = ch.positionChange().x
                        total += dx
                        if (!moved && abs(total) > slop) moved = true
                        if (!moved) continue
                        ch.consume()
                        if (handle >= 0) {
                            val (a, b) = clip ?: break
                            val t = start + ((ch.position.x - w / 2) * msPerPx()).toLong()
                            onClipL(if (handle == 0) minOf(t, b - 1000) to b else a to maxOf(t, a + 1000).coerceAtMost(nowNow))
                            continue
                        }
                        state.scrubbing = true
                        state.scrubTime = (state.scrubTime - (dx * msPerPx()).toLong()).coerceAtMost(nowNow)
                        vt.addPosition(ch.uptimeMillis, ch.position)
                        val tick = state.scrubTime / tickFor(state.span, w)
                        if (tick != lastTick) {
                            lastTick = tick
                            haptic.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                        }
                        onScrubL(state.scrubTime)
                    }
                    if (!moved && !zoomed && handle < 0) {
                        // Tap: jump to that moment.
                        val t = (start + ((down.position.x - w / 2) * msPerPx()).toLong()).coerceAtMost(nowNow)
                        state.scrubbing = false
                        onSeekL(t)
                    } else if (moved && handle < 0) {
                        val v = vt.calculateVelocity().x
                        if (abs(v) < 150f) {
                            state.scrubbing = false
                            onSeekL(state.scrubTime)
                        } else {
                            fling = scope.launch {
                                var last = 0f
                                AnimationState(0f, v).animateDecay(exponentialDecay(frictionMultiplier = 1.6f)) {
                                    val d = value - last
                                    last = value
                                    state.scrubTime = (state.scrubTime - (d * msPerPx()).toLong()).coerceAtMost(nowNow)
                                    onScrubL(state.scrubTime)
                                    if (state.scrubTime >= nowNow) cancelAnimation()
                                }
                                state.scrubbing = false
                                onSeekL(state.scrubTime)
                            }
                        }
                    } else if (zoomed && state.scrubbing) {
                        state.scrubbing = false
                        onSeekL(state.scrubTime)
                    }
                }
            },
    ) {
        val w = size.width
        val h = size.height
        val c = if (state.scrubbing) state.scrubTime else center
        val msPerPx = state.span / w
        val t0 = c - (w / 2 * msPerPx).toLong()
        val t1 = c + (w / 2 * msPerPx).toLong()
        fun x(t: Long) = w / 2 + (t - c) / msPerPx

        val trackTop = h * 0.52f
        val trackH = h * 0.30f
        val evTop = h * 0.34f
        val evH = h * 0.12f
        val r = CornerRadius(6.dp.toPx())

        // Track: the past without footage is red, the future is empty.
        drawRoundRect(C.Ink800, Offset(0f, trackTop), Size(w, trackH), r)
        val nowX = x(now).coerceIn(0f, w)
        if (nowX > 0) drawRoundRect(C.Rose.copy(alpha = 0.16f), Offset(0f, trackTop), Size(nowX, trackH), r)
        val band = Brush.horizontalGradient(listOf(C.Violet.copy(alpha = 0.85f), C.Cyan.copy(alpha = 0.75f)), 0f, w)
        for (s in coverage) {
            if (s.e < t0 || s.s > t1) continue
            val xa = x(s.s).coerceAtLeast(0f)
            val xb = x(minOf(s.e, now)).coerceAtMost(w)
            if (xb - xa > 0.5f) drawRect(band, Offset(xa, trackTop), Size(xb - xa, trackH))
        }
        // Events: plain motion in faint amber; people and animals in their colour, taller,
        // on top (with a dark ring so neighbours stay apart).
        for (e in events) {
            val end = e.endOr(now)
            if (end < t0 || e.start > t1 || mainLabel(e) != null) continue
            val xa = x(e.start)
            val xb = maxOf(x(end), xa + 3.dp.toPx())
            drawRoundRect(C.Amber.copy(alpha = 0.55f), Offset(xa, evTop + evH * 0.2f), Size(xb - xa, evH * 0.6f), CornerRadius(2.dp.toPx()))
        }
        for (e in events) {
            val label = mainLabel(e) ?: continue
            val end = e.endOr(now)
            if (end < t0 || e.start > t1) continue
            val xa = x(e.start)
            val xb = maxOf(x(end), xa + 6.dp.toPx())
            val ring = 1.5.dp.toPx()
            drawRoundRect(C.Ink950, Offset(xa - ring, evTop - evH * 0.35f - ring), Size(xb - xa + 2 * ring, evH * 1.7f + 2 * ring), CornerRadius(4.dp.toPx()))
            drawRoundRect(LABELS.getValue(label).color, Offset(xa, evTop - evH * 0.35f), Size(xb - xa, evH * 1.7f), CornerRadius(3.dp.toPx()))
        }
        // Clip range.
        clipRange?.let { (a, b) ->
            val xa = x(a)
            val xb = x(b)
            drawRect(C.Cyan.copy(alpha = 0.16f), Offset(xa, 0f), Size(xb - xa, h))
            for (hx in listOf(xa, xb)) {
                drawLine(C.Cyan, Offset(hx, 4f), Offset(hx, h - 4f), 3.dp.toPx(), StrokeCap.Round)
                drawCircle(C.Cyan, 7.dp.toPx(), Offset(hx, h - 10.dp.toPx()))
            }
        }
        // Ticks and labels.
        val step = tickFor(state.span, w)
        val fmt = SimpleDateFormat(if (step < MINUTE) "HH:mm:ss" else "HH:mm", Locale.getDefault())
        val dayFmt = SimpleDateFormat("EEE d", Locale.getDefault())
        val offset = Calendar.getInstance().timeZone.getOffset(c)
        var t = ((t0 + offset) / step) * step - offset
        while (t <= t1 + step) {
            val tx = x(t)
            val local = (t + Calendar.getInstance().timeZone.getOffset(t)) % DAY
            val midnight = local == 0L
            drawLine(if (midnight) C.VioletLight else Color(0x40FFFFFF), Offset(tx, trackTop - 5.dp.toPx()), Offset(tx, trackTop), 1.dp.toPx())
            val label = if (midnight) dayFmt.format(Date(t)) else fmt.format(Date(t))
            val m = measurer.measure(label, if (midnight) dayStyle else labelStyle)
            drawText(m, topLeft = Offset(tx - m.size.width / 2f, 2.dp.toPx()))
            t += step
        }
        // Now marker.
        if (now in t0..t1) drawLine(C.Emerald.copy(alpha = 0.8f), Offset(x(now), trackTop - 4.dp.toPx()), Offset(x(now), trackTop + trackH + 4.dp.toPx()), 2.dp.toPx())
        // Playhead.
        drawLine(Color.White.copy(alpha = 0.18f), Offset(w / 2, 14.dp.toPx()), Offset(w / 2, h), 8.dp.toPx(), StrokeCap.Round)
        drawLine(Color.White, Offset(w / 2, 14.dp.toPx()), Offset(w / 2, h), 2.dp.toPx(), StrokeCap.Round)
        drawCircle(Color.White, 4.dp.toPx(), Offset(w / 2, 14.dp.toPx()))
    }
}

/** Tick spacing: the smallest step at least ~72 px apart. */
private fun tickFor(span: Float, widthPx: Float): Long {
    val msPerPx = span / widthPx
    for (s in TICK_STEPS) if (s / msPerPx >= 150f) return s
    return TICK_STEPS.last()
}
