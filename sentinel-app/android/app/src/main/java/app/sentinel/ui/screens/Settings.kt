package app.sentinel.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.KeyboardArrowDown
import androidx.compose.material.icons.rounded.KeyboardArrowUp
import androidx.compose.material.icons.rounded.Visibility
import androidx.compose.material.icons.rounded.VisibilityOff
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.sentinel.core.AppState
import app.sentinel.ui.components.Chip
import app.sentinel.ui.components.GlassCard
import app.sentinel.ui.components.RoundIcon
import app.sentinel.ui.components.SectionTitle
import app.sentinel.ui.theme.C
import coil3.compose.AsyncImage

@Composable
fun SettingsScreen(state: AppState, onBack: () -> Unit) {
    val prefs by state.prefs.collectAsStateWithLifecycle()
    val status by state.status.collectAsStateWithLifecycle()
    val cams = state.orderedCameras(status, prefs, includeHidden = true)
    var confirmForget by remember { mutableStateOf(false) }

    SubPage("App settings", onBack) {
        item {
            GlassCard(Modifier.fillMaxWidth()) {
                Column {
                    Text("Live grid", color = C.TextDim, fontSize = 12.sp)
                    Row(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        listOf("Auto" to 0, "1" to 1, "2" to 2, "3" to 3).forEach { (label, n) ->
                            Chip(if (n == 0) label else "$label column${if (n > 1) "s" else ""}", prefs.gridColumns == n) { state.setPrefs { it.copy(gridColumns = n) } }
                        }
                    }
                    ToggleRow("Data saver", "Live grid shows pictures every few seconds instead of video, and cameras open in substream quality. Good on mobile data.", prefs.dataSaver) { v -> state.setPrefs { it.copy(dataSaver = v) } }
                    ToggleRow("Keep screen on", "While you watch a camera", prefs.keepScreenOn) { v -> state.setPrefs { it.copy(keepScreenOn = v) } }
                    ToggleRow("App lock", "Ask for your fingerprint, face or screen lock when opening Sentinel", prefs.appLock) { v -> state.setPrefs { it.copy(appLock = v) } }
                }
            }
        }
        item { SectionTitle("Camera order") }
        item { Text("Order and visibility on this phone only. Hidden cameras are still recorded.", color = C.TextFaint, fontSize = 12.sp) }
        itemsIndexed(cams, key = { _, c -> c.id }) { i, c ->
            val hidden = c.id in prefs.hidden
            Row(Modifier.fillMaxWidth().padding(vertical = 2.dp), verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(width = 64.dp, height = 40.dp).clip(RoundedCornerShape(10.dp)).background(C.Ink800)) {
                    AsyncImage(state.api.latestUrl(c.id), null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxWidth())
                }
                Text(c.name, color = if (hidden) C.TextFaint else C.Text, modifier = Modifier.weight(1f).padding(horizontal = 12.dp))
                RoundIcon(Icons.Rounded.KeyboardArrowUp, "Move up", size = 34.dp, background = Color(0x10FFFFFF)) {
                    if (i > 0) state.setPrefs { p -> p.copy(cameraOrder = cams.map { it.id }.toMutableList().apply { add(i - 1, removeAt(i)) }) }
                }
                RoundIcon(Icons.Rounded.KeyboardArrowDown, "Move down", Modifier.padding(start = 6.dp), size = 34.dp, background = Color(0x10FFFFFF)) {
                    if (i < cams.size - 1) state.setPrefs { p -> p.copy(cameraOrder = cams.map { it.id }.toMutableList().apply { add(i + 1, removeAt(i)) }) }
                }
                RoundIcon(if (hidden) Icons.Rounded.VisibilityOff else Icons.Rounded.Visibility, if (hidden) "Show" else "Hide", Modifier.padding(start = 6.dp), size = 34.dp, tint = if (hidden) C.TextFaint else C.Cyan, background = Color(0x10FFFFFF)) {
                    state.setPrefs { p -> p.copy(hidden = if (hidden) p.hidden - c.id else p.hidden + c.id) }
                }
            }
        }
        item { SectionTitle("This Sentinel") }
        item {
            MenuItem(Icons.Rounded.VisibilityOff, "Use a different Sentinel", "Logs out and forgets this Sentinel on this phone", C.RoseLight) { confirmForget = true }
        }
    }
    if (confirmForget) {
        AlertDialog(
            onDismissRequest = { confirmForget = false },
            title = { Text("Use a different Sentinel?") },
            text = { Text("This phone logs out and forgets the Sentinel ID.") },
            confirmButton = { TextButton({ confirmForget = false; state.forgetServer() }) { Text("Continue", color = C.RoseLight) } },
            dismissButton = { TextButton({ confirmForget = false }) { Text("Cancel", color = C.TextDim) } },
            containerColor = C.Ink850,
        )
    }
}
