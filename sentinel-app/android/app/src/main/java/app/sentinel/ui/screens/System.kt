package app.sentinel.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.RestartAlt
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.sentinel.core.AppState
import app.sentinel.core.CameraStatus
import app.sentinel.core.Incident
import app.sentinel.core.fmtAgo
import app.sentinel.core.fmtBitrate
import app.sentinel.core.fmtBytes
import app.sentinel.core.fmtDayTime
import app.sentinel.core.fmtDuration
import app.sentinel.core.stateLabel
import app.sentinel.ui.components.Gap
import app.sentinel.ui.components.GlassCard
import app.sentinel.ui.components.ProgressBar
import app.sentinel.ui.components.SectionTitle
import app.sentinel.ui.components.Stat
import app.sentinel.ui.components.StatePill
import app.sentinel.ui.components.Toaster
import app.sentinel.ui.components.stateColor
import app.sentinel.ui.theme.C
import kotlin.math.roundToInt
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@Composable
fun SystemScreen(state: AppState, onBack: () -> Unit, onOpenCamera: (String) -> Unit) {
    val status by state.status.collectAsStateWithLifecycle()
    val admin = state.isAdmin
    var incidents by remember { mutableStateOf<List<Incident>>(emptyList()) }
    var restart by remember { mutableStateOf<CameraStatus?>(null) }
    val scope = rememberCoroutineScope()
    if (admin) LaunchedEffect(Unit) {
        while (true) {
            runCatching { state.api.incidents(150) }.onSuccess { incidents = it.sortedByDescending { i -> i.t } }
            delay(15_000)
        }
    }
    val s = status
    SubPage("System", onBack) {
        if (s == null) return@SubPage
        item {
            GlassCard(Modifier.fillMaxWidth()) {
                Column {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Box(Modifier.size(10.dp).clip(CircleShape).background(if (s.health) C.Emerald else C.Rose))
                        Text(if (s.health) "  Sentinel is healthy" else "  Sentinel needs attention", style = MaterialTheme.typography.titleMedium)
                    }
                    Gap(14.dp)
                    Row {
                        Stat("Version", s.version, Modifier.weight(1f))
                        Stat("Up for", fmtDuration(s.uptimeMs), Modifier.weight(1f))
                        Stat("Clock", if (s.clock.synced) "In sync" else "Off", Modifier.weight(1f), sub = if (s.clock.offsetMs != 0L) "${s.clock.offsetMs / 1000}s fixed" else null, accent = if (s.clock.synced) C.Text else C.Amber)
                    }
                }
            }
        }
        item {
            val d = s.storage.disk
            GlassCard(Modifier.fillMaxWidth()) {
                Column {
                    Text("Storage", style = MaterialTheme.typography.titleMedium)
                    Gap(12.dp)
                    val usedFrac = if (d.total > 0) (d.total - d.free).toFloat() / d.total else 0f
                    ProgressBar(usedFrac, Modifier.fillMaxWidth(), brush = if (usedFrac > 0.9f) Brush.horizontalGradient(listOf(C.Amber, C.Rose)) else C.accentH)
                    Gap(8.dp)
                    Text("${fmtBytes(d.total - d.free)} of ${fmtBytes(d.total)} used · ${fmtBytes(d.free)} free", color = C.TextDim, fontSize = 13.sp)
                    Gap(14.dp)
                    Row {
                        Stat("Recordings", fmtBytes(s.storage.used), Modifier.weight(1f))
                        Stat("Per day", fmtBytes(s.storage.rateBph * 24), Modifier.weight(1f))
                        Stat("Room for", "${s.storage.capacityDays.roundToInt()} days", Modifier.weight(1f))
                    }
                }
            }
        }
        item {
            GlassCard(Modifier.fillMaxWidth()) {
                Column {
                    Text("Services", style = MaterialTheme.typography.titleMedium)
                    Gap(8.dp)
                    InfoLine("Live view", if (s.live) "Running" else "Starting")
                    InfoLine("Night alerts", if (s.alerts.enabled) (if (s.alerts.active) "Active now" else "On") else "Off")
                    InfoLine("Google Drive backup", if (s.drive.connected) "Connected" else "Not connected")
                    InfoLine("Home Assistant (MQTT)", if (s.mqtt.connected) "Connected" else "Not connected")
                }
            }
        }
        item { SectionTitle("Cameras") }
        items(s.cameras, key = { it.id }) { c ->
            GlassCard(Modifier.fillMaxWidth(), onClick = { onOpenCamera(c.id) }) {
                Column {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(c.name, style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
                        StatePill(c.state, compact = true)
                        if (admin && c.enabled) Icon(
                            Icons.Rounded.RestartAlt, "Restart", tint = C.TextDim,
                            modifier = Modifier.padding(start = 8.dp).size(28.dp).clip(CircleShape).clickable { restart = c }.padding(4.dp),
                        )
                    }
                    Gap(10.dp)
                    val r = c.recorder
                    Row {
                        Stat("Bitrate", r?.let { fmtBitrate(it.bitrateKbps) } ?: "—", Modifier.weight(1f))
                        Stat("24 h", "${(c.storage.uptime24h * 100).roundToInt()}%", Modifier.weight(1f), accent = if (c.storage.uptime24h > 0.99) C.Emerald else C.Amber)
                        Stat("Restarts", "${r?.restarts24h ?: 0}", Modifier.weight(1f))
                        Stat("Stored", fmtBytes(c.storage.bytes), Modifier.weight(1f))
                    }
                    r?.lastError?.takeIf { it.isNotBlank() && c.state != "recording" }?.let {
                        Gap(8.dp)
                        Text(it, color = C.Amber, fontSize = 12.sp)
                    }
                }
            }
        }
        if (admin && incidents.isNotEmpty()) {
            item { SectionTitle("Activity") }
            items(incidents.take(120)) { i ->
                Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 2.dp), verticalAlignment = Alignment.Top) {
                    Box(Modifier.padding(top = 6.dp).size(7.dp).clip(CircleShape).background(when (i.level) { "error" -> C.Rose; "warn" -> C.Amber; else -> C.Sky }))
                    Column(Modifier.padding(start = 10.dp)) {
                        Text(i.message, color = C.Text, fontSize = 13.sp)
                        Text(fmtDayTime(i.t, state.serverNow()) + (i.camera?.let { " · $it" } ?: ""), color = C.TextFaint, fontSize = 11.sp)
                    }
                }
            }
        }
    }
    restart?.let { c ->
        AlertDialog(
            onDismissRequest = { restart = null },
            title = { Text("Restart ${c.name}?") },
            text = { Text("Reconnects the camera's recorder. A few seconds of footage may be missing.") },
            confirmButton = {
                TextButton({
                    scope.launch {
                        runCatching { state.api.restartCamera(c.id) }.onSuccess { Toaster.show("${c.name} is reconnecting") }.onFailure { Toaster.error(it.message ?: "Failed") }
                    }
                    restart = null
                }) { Text("Restart", color = C.Amber) }
            },
            dismissButton = { TextButton({ restart = null }) { Text("Cancel", color = C.TextDim) } },
            containerColor = C.Ink850,
        )
    }
}
