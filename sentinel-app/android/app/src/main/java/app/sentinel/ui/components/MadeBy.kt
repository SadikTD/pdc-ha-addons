package app.sentinel.ui.components

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Favorite
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
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
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.LinearGradientShader
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathMeasure
import androidx.compose.ui.graphics.Shader
import androidx.compose.ui.graphics.ShaderBrush
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.TileMode
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.clipRect
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.sentinel.R
import app.sentinel.ui.theme.C
import kotlin.math.cos
import kotlin.math.sin

const val AUTHOR = "Sadik Hossain"

private val ScriptFont = FontFamily(Font(R.font.dancing_script_bold, FontWeight.Bold))
private val SigColors = listOf(Color(0xFFC4B5FD), Color(0xFF67E8F9), Color(0xFFF0ABFC), Color(0xFFC4B5FD))
private val Pink = Color(0xFFF0ABFC)
private val Ease = CubicBezierEasing(0.65f, 0f, 0.35f, 1f)

/**
 * The author's name in a handwritten script. Once on screen it writes itself in from left
 * to right, a pen stroke underlines it, then its colours drift slowly.
 */
@Composable
fun Signature(fontSize: TextUnit, modifier: Modifier = Modifier) {
    val write = remember { Animatable(0f) }
    val stroke = remember { Animatable(0f) }
    var seen by remember { mutableStateOf(false) }
    val screenH = with(LocalDensity.current) { LocalConfiguration.current.screenHeightDp.dp.toPx() }
    LaunchedEffect(seen) {
        if (!seen) return@LaunchedEffect
        kotlinx.coroutines.delay(250)
        write.animateTo(1f, tween(1500, easing = Ease))
        stroke.animateTo(1f, tween(850, easing = Ease))
    }
    val flow by rememberInfiniteTransition(label = "signature").animateFloat(
        0f, 1f, infiniteRepeatable(tween(6000, easing = LinearEasing)), label = "flow",
    )
    // The gradient slides along the name, repeating seamlessly.
    val brush = remember(flow) {
        object : ShaderBrush() {
            override fun createShader(size: Size): Shader {
                val w = size.width.coerceAtLeast(1f)
                val x = -flow * 2 * w
                return LinearGradientShader(Offset(x, 0f), Offset(x + 2 * w, 0f), SigColors, tileMode = TileMode.Repeated)
            }
        }
    }
    Box(
        modifier.onGloballyPositioned {
            if (!seen) {
                val b = it.boundsInWindow()
                if (b.height > 0 && b.bottom > 0 && b.top < screenH) seen = true
            }
        },
    ) {
        Text(
            AUTHOR,
            style = TextStyle(fontFamily = ScriptFont, fontWeight = FontWeight.Bold, fontSize = fontSize, brush = brush),
            modifier = Modifier
                .padding(bottom = (fontSize.value * 0.16f).dp, end = (fontSize.value * 0.06f).dp)
                .drawWithContent { clipRect(right = size.width * write.value) { this@drawWithContent.drawContent() } },
        )
        Canvas(Modifier.matchParentSize()) {
            if (stroke.value <= 0f) return@Canvas
            val w = size.width
            val top = size.height * 0.80f
            val band = size.height * 0.16f
            fun p(x: Float, y: Float) = Offset(w * 0.02f + x / 212f * w * 0.96f, top + y / 14f * band)
            val path = Path().apply {
                val a = p(2f, 10f); moveTo(a.x, a.y)
                val (c1, c2, e1) = listOf(p(38f, 3f), p(76f, 13f), p(112f, 7f))
                cubicTo(c1.x, c1.y, c2.x, c2.y, e1.x, e1.y)
                val (c3, c4, e2) = listOf(p(148f, 1f), p(176f, 3f), p(210f, 8f))
                cubicTo(c3.x, c3.y, c4.x, c4.y, e2.x, e2.y)
            }
            val m = PathMeasure().apply { setPath(path, false) }
            val part = Path()
            m.getSegment(0f, m.length * stroke.value, part, true)
            drawPath(
                part,
                Brush.horizontalGradient(listOf(C.VioletLight.copy(alpha = 0f), C.VioletLight, C.Cyan, Pink.copy(alpha = 0.3f))),
                style = Stroke(width = (fontSize.value * 0.075f).dp.toPx(), cap = StrokeCap.Round),
            )
        }
    }
}

/** A quiet credit for the bottom of the welcome screens. */
@Composable
fun MadeByCredit(modifier: Modifier = Modifier) {
    val beat by rememberInfiniteTransition(label = "heart").animateFloat(
        1f, 0.8f, infiniteRepeatable(tween(800, easing = LinearEasing), RepeatMode.Reverse), label = "beat",
    )
    Column(modifier, horizontalAlignment = Alignment.CenterHorizontally) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("CRAFTED WITH ", color = C.TextFaint, fontSize = 10.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 2.4.sp)
            Icon(
                Icons.Rounded.Favorite, null, tint = C.Rose.copy(alpha = 0.85f),
                modifier = Modifier.size(12.dp).graphicsLayer { scaleX = beat; scaleY = beat; alpha = 0.6f + 0.4f * beat },
            )
            Text(" BY", color = C.TextFaint, fontSize = 10.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 2.4.sp)
        }
        Signature(28.sp, Modifier.padding(top = 2.dp))
    }
}

/** Who made Sentinel, over a slowly drifting aurora (bottom of the More screen). */
@Composable
fun AboutCard(sentinelVersion: String?, appVersion: String, modifier: Modifier = Modifier) {
    val inf = rememberInfiniteTransition(label = "about")
    val spin by inf.animateFloat(0f, 360f, infiniteRepeatable(tween(8000, easing = LinearEasing)), label = "spin")
    val drift by inf.animateFloat(0f, (2 * Math.PI).toFloat(), infiniteRepeatable(tween(16000, easing = LinearEasing)), label = "drift")
    val shape = RoundedCornerShape(26.dp)
    Box(
        modifier
            .fillMaxWidth()
            .clip(shape)
            .background(C.Ink900)
            .drawBehind {
                val w = size.width
                val h = size.height
                fun blob(color: Color, cx: Float, cy: Float, r: Float) =
                    drawCircle(Brush.radialGradient(listOf(color, Color.Transparent), center = Offset(cx, cy), radius = r), radius = r, center = Offset(cx, cy))
                blob(C.Violet.copy(alpha = 0.28f), w * (0.15f + 0.08f * cos(drift)), h * (0.1f + 0.1f * sin(drift)), w * 0.55f)
                blob(C.Cyan.copy(alpha = 0.2f), w * (0.9f + 0.06f * sin(drift * 1.3f)), h * (0.95f + 0.08f * cos(drift)), w * 0.6f)
                blob(Pink.copy(alpha = 0.1f), w * (0.55f + 0.1f * sin(drift * 0.7f)), h * (0.45f + 0.1f * cos(drift * 1.1f)), w * 0.4f)
            }
            .border(1.dp, C.GlassBorder, shape)
            .padding(horizontal = 20.dp, vertical = 24.dp),
    ) {
        Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
            Box(Modifier.size(92.dp), contentAlignment = Alignment.Center) {
                Canvas(Modifier.fillMaxSize().graphicsLayer { rotationZ = spin }) {
                    drawCircle(Brush.sweepGradient(listOf(C.Violet, C.Cyan, Pink, C.Violet)), style = Stroke(2.5.dp.toPx()))
                }
                Box(Modifier.size(82.dp).clip(CircleShape).background(C.Ink950.copy(alpha = 0.85f)))
                Logo(Modifier.size(44.dp))
            }
            Text("ABOUT", color = C.TextFaint, fontSize = 10.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 2.6.sp, modifier = Modifier.padding(top = 14.dp))
            Text("Sentinel", style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(top = 2.dp))
            Text(
                listOfNotNull(sentinelVersion?.let { "Server $it" }, "App $appVersion").joinToString(" · "),
                color = C.TextFaint, fontSize = 12.sp,
            )
            Text(
                "Watching over home, day and night — recording, recognising and remembering, all on your own hardware.",
                color = C.TextDim, fontSize = 13.sp, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 8.dp),
            )
            Text("DESIGNED & BUILT BY", color = C.TextFaint, fontSize = 10.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 2.4.sp, modifier = Modifier.padding(top = 18.dp))
            Signature(42.sp, Modifier.padding(top = 2.dp))
        }
    }
}
