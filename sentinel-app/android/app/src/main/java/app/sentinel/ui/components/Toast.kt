package app.sentinel.ui.components

import androidx.compose.foundation.clickable
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.spring
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.CheckCircle
import androidx.compose.material.icons.rounded.ErrorOutline
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.sentinel.ui.theme.C
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow

data class ToastMsg(val text: String, val error: Boolean = false, val action: String? = null, val onAction: (() -> Unit)? = null, val id: Long = System.nanoTime())

/** App-wide messages ("Clip saved", "Couldn't reach Sentinel"). */
object Toaster {
    val current = MutableStateFlow<ToastMsg?>(null)
    fun show(text: String) { current.value = ToastMsg(text) }
    /** A message with a button (e.g. "Undo"); stays a little longer. */
    fun show(text: String, action: String, onAction: () -> Unit) { current.value = ToastMsg(text, action = action, onAction = onAction) }
    fun error(text: String) { current.value = ToastMsg(text, error = true) }
}

@Composable
fun ToastHost(modifier: Modifier = Modifier) {
    val msg by Toaster.current.collectAsStateWithLifecycle()
    LaunchedEffect(msg?.id) {
        if (msg != null) {
            delay(if (msg!!.error || msg!!.action != null) 5000 else 2600)
            Toaster.current.value = null
        }
    }
    Box(modifier.fillMaxWidth().statusBarsPadding().padding(top = 8.dp), contentAlignment = Alignment.TopCenter) {
        AnimatedVisibility(
            msg != null,
            enter = slideInVertically(spring(dampingRatio = 0.7f)) { -it } + fadeIn() + scaleIn(initialScale = 0.9f),
            exit = slideOutVertically { -it } + fadeOut(),
        ) {
            val m = msg ?: return@AnimatedVisibility
            val color = if (m.error) C.Rose else C.Emerald
            Row(
                Modifier
                    .padding(horizontal = 20.dp)
                    .clip(RoundedCornerShape(18.dp))
                    .background(Color(0xF20E121B))
                    .border(1.dp, color.copy(alpha = 0.35f), RoundedCornerShape(18.dp))
                    .padding(horizontal = 16.dp, vertical = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(if (m.error) Icons.Rounded.ErrorOutline else Icons.Rounded.CheckCircle, null, tint = color, modifier = Modifier.size(20.dp))
                Text("  ${m.text}", color = C.Text, fontSize = 14.sp, modifier = Modifier.weight(1f, fill = false))
                if (m.action != null) Text(
                    m.action, color = C.VioletLight, fontSize = 14.sp, fontWeight = FontWeight.Bold,
                    modifier = Modifier.padding(start = 12.dp).clip(RoundedCornerShape(8.dp)).clickable { Toaster.current.value = null; m.onAction?.invoke() }.padding(horizontal = 6.dp, vertical = 4.dp),
                )
            }
        }
    }
}
