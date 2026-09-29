package app.sentinel.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.navigationBars
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
import android.Manifest
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.height
import androidx.compose.material.icons.rounded.Notifications
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.platform.LocalContext
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.ui.text.style.TextAlign
import app.sentinel.core.AppState
import app.sentinel.core.Push
import app.sentinel.ui.components.Gap
import app.sentinel.ui.components.GradientButton
import app.sentinel.ui.components.SubtleButton
import app.sentinel.ui.components.Toaster
import kotlinx.coroutines.launch
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

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun NotificationsCard(state: AppState) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val available by state.pushAvailable.collectAsStateWithLifecycle()
    val prefs by state.pushPrefs.collectAsStateWithLifecycle()
    val status by state.status.collectAsStateWithLifecycle()
    var allowed by remember { mutableStateOf(Push.canNotify(context)) }
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        allowed = ok
        if (ok) scope.launch { state.registerPush() }
    }
    GlassCard(Modifier.fillMaxWidth()) {
        Column {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Rounded.Notifications, null, tint = C.VioletLight, modifier = Modifier.size(20.dp))
                Text("  Notifications", style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
            }
            when {
                !available -> Text(
                    "Not set up on Sentinel yet. The admin turns them on in Sentinel → Settings → Sentinel app → Phone notifications.",
                    color = C.TextFaint, fontSize = 12.sp, modifier = Modifier.padding(top = 8.dp),
                )
                !allowed -> Column(Modifier.padding(top = 8.dp)) {
                    Text("Allow Sentinel to show notifications on this phone.", color = C.TextDim, fontSize = 13.sp)
                    Gap(10.dp)
                    GradientButton("Allow notifications", Modifier.fillMaxWidth().height(46.dp)) {
                        if (Build.VERSION.SDK_INT >= 33) ask.launch(Manifest.permission.POST_NOTIFICATIONS) else allowed = true
                    }
                }
                else -> Column {
                    ToggleRow("Night alerts", "People and animals seen at night, with the picture", prefs.alerts) { state.setPushPrefs(prefs.copy(alerts = it)) }
                    ToggleRow("Camera problems", "A camera stops or starts recording", prefs.status) { state.setPushPrefs(prefs.copy(status = it)) }
                    ToggleRow("Daily summary", "Each morning: who was seen yesterday, and whether every camera recorded", prefs.wantsSummary) { state.setPushPrefs(prefs.copy(summary = it)) }
                    Text("Any motion on", color = C.Text, fontSize = 15.sp, modifier = Modifier.padding(top = 8.dp))
                    Text("At most one notification a minute per camera", color = C.TextFaint, fontSize = 12.sp)
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(vertical = 10.dp)) {
                        status?.cameras?.forEach { c ->
                            val on = c.id in prefs.motion
                            Chip(c.name, on) { state.setPushPrefs(prefs.copy(motion = if (on) prefs.motion - c.id else prefs.motion + c.id)) }
                        }
                    }
                    SubtleButton("Send a test notification", Modifier.fillMaxWidth(), icon = Icons.Rounded.Notifications) {
                        scope.launch {
                            state.registerPush()
                            runCatching { state.api.testPush() }
                                .onSuccess { Toaster.show(if (it > 0) "Test sent — it should arrive in a moment" else "This phone isn't registered yet") }
                                .onFailure { Toaster.error(it.message ?: "Couldn't send") }
                        }
                    }
                }
            }
        }
    }
}

@Composable
fun NotificationsScreen(state: AppState, onBack: () -> Unit) {
    SubPage("Notifications", onBack) {
        item {
            Text(
                "Choose what this phone is told about. Pictures come straight from your Sentinel over the encrypted connection.",
                color = C.TextDim, fontSize = 13.sp,
            )
        }
        item { NotificationsCard(state) }
    }
}

/** Asks once, right after logging in, whether this phone should get alerts. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NotificationPrompt(state: AppState) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val available by state.pushAvailable.collectAsStateWithLifecycle()
    val prefs by state.prefs.collectAsStateWithLifecycle()
    if (!available || prefs.askedNotifications || Push.canNotify(context)) return
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        state.setPrefs { it.copy(askedNotifications = true) }
        if (ok) scope.launch { state.registerPush(); Toaster.show("Notifications are on") }
    }
    val navBottom = androidx.compose.foundation.layout.WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()
    ModalBottomSheet({ state.setPrefs { it.copy(askedNotifications = true) } }, sheetState = androidx.compose.material3.rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = C.Ink850) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 24.dp).padding(bottom = 16.dp + navBottom), horizontalAlignment = Alignment.CenterHorizontally) {
            Box(Modifier.size(64.dp).clip(CircleShape).background(C.accent), contentAlignment = Alignment.Center) {
                Icon(Icons.Rounded.Notifications, null, tint = androidx.compose.ui.graphics.Color.White, modifier = Modifier.size(32.dp))
            }
            Gap(16.dp)
            Text("Get alerts on this phone?", style = MaterialTheme.typography.titleLarge)
            Gap(8.dp)
            Text(
                "Sentinel can tell you when someone is seen at night (with the picture) and when a camera stops recording, even when the app is closed.",
                color = C.TextDim, fontSize = 14.sp, textAlign = TextAlign.Center,
            )
            Gap(20.dp)
            GradientButton("Allow notifications", Modifier.fillMaxWidth()) {
                if (Build.VERSION.SDK_INT >= 33) ask.launch(Manifest.permission.POST_NOTIFICATIONS)
                else state.setPrefs { it.copy(askedNotifications = true) }
            }
            Gap(8.dp)
            TextButton({ state.setPrefs { it.copy(askedNotifications = true) } }) { Text("Not now", color = C.TextDim) }
        }
    }
}
