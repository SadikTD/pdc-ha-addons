package app.sentinel.ui.screens

import androidx.compose.material.icons.rounded.Face
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.automirrored.rounded.KeyboardArrowRight
import androidx.compose.material.icons.automirrored.rounded.Logout
import androidx.compose.material.icons.rounded.Dns
import androidx.compose.material.icons.rounded.SystemUpdate
import androidx.compose.material.icons.rounded.Group
import androidx.compose.material.icons.rounded.MonitorHeart
import androidx.compose.material.icons.rounded.Refresh
import kotlinx.coroutines.launch
import androidx.compose.material.icons.rounded.Notifications
import androidx.compose.material.icons.rounded.MeetingRoom
import androidx.compose.material.icons.rounded.AutoAwesome
import androidx.compose.material.icons.rounded.Shield
import androidx.compose.material.icons.rounded.Tune
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
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
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.sentinel.BuildConfig
import app.sentinel.core.AppState
import app.sentinel.core.Auth
import app.sentinel.core.Engine
import app.sentinel.core.fmtDuration
import app.sentinel.ui.components.AboutCard
import app.sentinel.ui.components.Backdrop
import app.sentinel.ui.components.ConnectionPill
import app.sentinel.ui.components.Gap
import app.sentinel.ui.components.GlassCard
import app.sentinel.ui.components.RoundIcon
import app.sentinel.ui.components.glass
import app.sentinel.ui.theme.C

@Composable
fun MoreScreen(state: AppState, padding: PaddingValues, onUsers: () -> Unit, onSystem: () -> Unit, onSettings: () -> Unit, onNotifications: () -> Unit, onSummary: () -> Unit, onPeople: () -> Unit, onPresence: () -> Unit) {
    val auth by state.auth.collectAsStateWithLifecycle()
    val status by state.status.collectAsStateWithLifecycle()
    val conn by state.engine.state.collectAsStateWithLifecycle()
    val a = auth as? Auth.LoggedIn ?: return
    var confirmLogout by remember { mutableStateOf(false) }
    val scope = androidx.compose.runtime.rememberCoroutineScope()

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState())
            .padding(start = 14.dp, end = 14.dp, top = padding.calculateTopPadding() + 8.dp, bottom = padding.calculateBottomPadding() + 16.dp),
    ) {
        Text("More", style = MaterialTheme.typography.headlineMedium)
        Gap(16.dp)
        // Account
        GlassCard(Modifier.fillMaxWidth()) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(56.dp).clip(CircleShape).background(C.accent), contentAlignment = Alignment.Center) {
                    Text(a.user.display.take(1).uppercase(), color = Color.White, fontSize = 24.sp, fontWeight = FontWeight.Bold)
                }
                Column(Modifier.weight(1f).padding(horizontal = 14.dp)) {
                    Text(a.user.display, style = MaterialTheme.typography.titleMedium)
                    Text("@${a.user.username} · ${if (a.user.admin) "Admin" else "Viewer"}", color = C.TextDim, fontSize = 13.sp)
                }
                if (a.user.admin) Icon(Icons.Rounded.Shield, "Admin", tint = C.VioletLight)
            }
        }
        Gap(12.dp)
        // Connection
        GlassCard(Modifier.fillMaxWidth()) {
            Column {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Rounded.Dns, null, tint = C.TextDim, modifier = Modifier.size(18.dp))
                    Text("  ${a.server.name.ifBlank { "Sentinel" }}", style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
                    ConnectionPill(conn)
                }
                Gap(10.dp)
                InfoLine("Sentinel ID", Engine.formatId(a.serverId), mono = true)
                InfoLine("Connection", when (conn.path) { "home" -> "Direct, home network"; "internet" -> "Direct, over the internet"; "relay" -> "Through the relay"; else -> conn.state })
                if (conn.path == "relay") Text(
                    "This network blocks direct connections, so traffic goes through a fast relay. It stays end-to-end encrypted.",
                    color = C.TextFaint, fontSize = 12.sp, modifier = Modifier.padding(bottom = 4.dp),
                )
                status?.let { InfoLine("Sentinel version", it.version) ; InfoLine("Running for", fmtDuration(it.uptimeMs)) }
                InfoLine("App version", BuildConfig.VERSION_NAME)
                Gap(10.dp)
                app.sentinel.ui.components.SubtleButton("Reconnect", Modifier.fillMaxWidth(), icon = Icons.Rounded.Refresh) {
                    state.engine.reconnect()
                    scope.launch { state.engine.connect(); state.refreshStatus() }
                }
            }
        }
        Gap(16.dp)
        MenuItem(Icons.Rounded.AutoAwesome, "Daily summary", "Who was seen, when, and whether every camera recorded", onSummary)
        MenuItem(Icons.Rounded.Face, "People", if (a.user.admin) "Who Sentinel recognises, and faces to name" else "Who Sentinel recognises", onPeople)
        MenuItem(Icons.Rounded.MeetingRoom, "Comings & goings", "When the people you named came home and went out", onPresence)
        MenuItem(Icons.Rounded.Notifications, "Notifications", "Night alerts, camera problems, motion", onNotifications)
        MenuItem(Icons.Rounded.MonitorHeart, "System", "Health, storage, recorders${if (a.user.admin) ", activity log" else ""}", onSystem)
        if (a.user.admin) MenuItem(Icons.Rounded.Group, "Users", "Who can use the app, and signed-in phones", onUsers)
        MenuItem(Icons.Rounded.Tune, "App settings", "Layout, data saver, app lock, camera order", onSettings)
        AppUpdatesItem()
        MenuItem(Icons.AutoMirrored.Rounded.Logout, "Log out", "Sign this phone out of Sentinel", tint = C.RoseLight) { confirmLogout = true }
        Gap(20.dp)
        AboutCard(status?.version, BuildConfig.VERSION_NAME)
        Gap(24.dp)
    }
    if (confirmLogout) {
        AlertDialog(
            onDismissRequest = { confirmLogout = false },
            title = { Text("Log out?") },
            text = { Text("You'll need your username and password to log in again.") },
            confirmButton = { TextButton({ confirmLogout = false; state.logout() }) { Text("Log out", color = C.RoseLight) } },
            dismissButton = { TextButton({ confirmLogout = false }) { Text("Cancel", color = C.TextDim) } },
            containerColor = C.Ink850,
        )
    }
}

/** The app's version, and its updates (they install by themselves; tap to check now). */
@Composable
private fun AppUpdatesItem() {
    val context = androidx.compose.ui.platform.LocalContext.current
    val st by app.sentinel.core.Updater.state.collectAsStateWithLifecycle()
    val checked by app.sentinel.core.Updater.checkedAt.collectAsStateWithLifecycle()
    val sub = when (val s = st) {
        is app.sentinel.core.Update.Downloading -> "Downloading ${s.release.version} · ${(s.progress * 100).toInt()}%"
        is app.sentinel.core.Update.Ready -> "Version ${s.release.version} is ready · tap to install"
        is app.sentinel.core.Update.Installing -> "Installing ${s.release.version}…"
        app.sentinel.core.Update.Checking -> "Checking…"
        else -> "Version ${BuildConfig.VERSION_NAME}" + (if (checked > 0) " · up to date" else "") + " · updates install by themselves"
    }
    MenuItem(Icons.Rounded.SystemUpdate, "App updates", sub) {
        if (st is app.sentinel.core.Update.Ready) app.sentinel.core.Updater.install(context)
        else app.sentinel.core.Updater.check(context, manual = true)
    }
}

@Composable
fun InfoLine(label: String, value: String, mono: Boolean = false) {
    Row(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
        Text(label, color = C.TextDim, fontSize = 13.sp, modifier = Modifier.weight(1f))
        Text(value, color = C.Text, fontSize = 13.sp, fontFamily = if (mono) FontFamily.Monospace else FontFamily.Default)
    }
}

@Composable
fun MenuItem(icon: ImageVector, title: String, sub: String?, onClick: () -> Unit) = MenuItem(icon, title, sub, C.Text, onClick)

@Composable
fun MenuItem(icon: ImageVector, title: String, sub: String?, tint: Color, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().padding(vertical = 5.dp).glass(RoundedCornerShape(18.dp)).clickable(onClick = onClick).padding(14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(40.dp).clip(RoundedCornerShape(12.dp)).background(Color(0x12FFFFFF)), contentAlignment = Alignment.Center) {
            Icon(icon, null, tint = tint, modifier = Modifier.size(20.dp))
        }
        Column(Modifier.weight(1f).padding(horizontal = 14.dp)) {
            Text(title, color = tint, style = MaterialTheme.typography.titleSmall)
            if (sub != null) Text(sub, color = C.TextFaint, fontSize = 12.sp)
        }
        Icon(Icons.AutoMirrored.Rounded.KeyboardArrowRight, null, tint = C.TextFaint)
    }
}

/** Page frame for the screens opened from More. */
@Composable
fun SubPage(title: String, onBack: () -> Unit, action: @Composable () -> Unit = {}, content: LazyListScope.() -> Unit) {
    Backdrop {
        Column(Modifier.fillMaxSize().statusBarsPadding()) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                RoundIcon(Icons.AutoMirrored.Rounded.ArrowBack, "Back", size = 40.dp, background = Color(0x10FFFFFF), onClick = onBack)
                Text(title, style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f).padding(horizontal = 12.dp))
                action()
            }
            LazyColumn(
                Modifier.fillMaxSize(),
                contentPadding = PaddingValues(start = 14.dp, end = 14.dp, top = 4.dp, bottom = 32.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
                content = { content(); item { Box(Modifier.navigationBarsPadding()) } },
            )
        }
    }
}

@Composable
fun Pill(text: String, color: Color) {
    Text(
        text,
        color = color,
        fontSize = 11.sp,
        fontWeight = FontWeight.SemiBold,
        modifier = Modifier.clip(CircleShape).background(color.copy(alpha = 0.12f)).border(1.dp, color.copy(alpha = 0.25f), CircleShape).padding(horizontal = 8.dp, vertical = 3.dp),
    )
}
