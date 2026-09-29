package app.sentinel.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Bolt
import androidx.compose.material.icons.rounded.Person
import androidx.compose.material.icons.rounded.Pets
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.sentinel.core.Api
import app.sentinel.core.SentinelEvent
import app.sentinel.ui.theme.C
import coil3.compose.AsyncImage

/** How each kind of thing seen looks everywhere (same colours as the web page). */
data class LabelStyle(val name: String, val plural: String, val icon: ImageVector, val color: Color)

val LABELS: Map<String, LabelStyle> = linkedMapOf(
    "person" to LabelStyle("Person", "People", Icons.Rounded.Person, Color(0xFFDB2777)),
    "cat" to LabelStyle("Cat", "Cats", Icons.Rounded.Pets, Color(0xFF65A30D)),
    "dog" to LabelStyle("Dog", "Dogs", Icons.Rounded.Pets, Color(0xFF2563EB)),
)
val LABEL_ORDER = listOf("person", "cat", "dog")

/** Plain motion in charts (validated together with the label colours on the dark background). */
val MotionColor = Color(0xFFD97706)

fun mainLabel(e: SentinelEvent): String? = LABEL_ORDER.firstOrNull { it in e.labels }

/** Small badges for who was seen ("Motion" when checked and nobody was). */
@Composable
fun LabelChips(labels: List<String>, modifier: Modifier = Modifier, small: Boolean = false, showMotion: Boolean = false, checked: Boolean = true) {
    val shown = LABEL_ORDER.filter { it in labels }
    Row(modifier, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        if (shown.isEmpty() && showMotion) {
            Chiplet(if (checked) "Motion" else "Checking…", Icons.Rounded.Bolt, Color(0xAA000000), C.Amber, small)
        }
        shown.forEach { l ->
            val s = LABELS.getValue(l)
            Chiplet(s.name, s.icon, s.color, Color.White, small)
        }
    }
}

@Composable
private fun Chiplet(text: String, icon: ImageVector, bg: Color, fg: Color, small: Boolean) {
    Row(
        Modifier.clip(RoundedCornerShape(6.dp)).background(bg).padding(horizontal = if (small) 5.dp else 6.dp, vertical = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, null, tint = fg, modifier = Modifier.size(if (small) 10.dp else 12.dp))
        Text(" $text", color = fg, fontSize = if (small) 9.sp else 10.sp, fontWeight = FontWeight.Bold)
    }
}

/** The event's picture; on a snapshot of someone seen, a frame around them. */
@Composable
fun EventPicture(api: Api, e: SentinelEvent, modifier: Modifier = Modifier, boxes: Boolean = true) {
    Box(modifier.background(C.Ink800)) {
        AsyncImage(api.pictureUrl(e), null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
        val first = e.objects.firstOrNull()
        if (boxes && e.snap && first != null) {
            BoxWithConstraints(Modifier.fillMaxSize()) {
                e.objects.filter { it.t == first.t }.forEach { o ->
                    val c = LABELS[o.label]?.color ?: Color.White
                    Box(
                        Modifier
                            .offset(x = maxWidth * o.box.x.toFloat(), y = maxHeight * o.box.y.toFloat())
                            .size(width = maxWidth * o.box.w.toFloat(), height = maxHeight * o.box.h.toFloat())
                            .border(2.dp, c, RoundedCornerShape(3.dp)),
                    )
                }
            }
        }
    }
}
