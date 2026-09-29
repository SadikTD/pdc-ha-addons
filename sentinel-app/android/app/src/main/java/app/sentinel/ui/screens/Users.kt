package app.sentinel.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.Logout
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.Delete
import androidx.compose.material.icons.rounded.Key
import androidx.compose.material.icons.rounded.Smartphone
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.sentinel.core.AppSession
import app.sentinel.core.AppState
import app.sentinel.core.AppUser
import app.sentinel.core.UserInput
import app.sentinel.core.fmtAgo
import app.sentinel.ui.components.Chip
import app.sentinel.ui.components.Gap
import app.sentinel.ui.components.GlassCard
import app.sentinel.ui.components.GradientButton
import app.sentinel.ui.components.RoundIcon
import app.sentinel.ui.components.SectionTitle
import app.sentinel.ui.components.Toaster
import app.sentinel.ui.theme.C
import java.security.SecureRandom
import kotlinx.coroutines.launch

/** Admins: who can use the app, what they can see, and signed-in phones. */
@Composable
fun UsersScreen(state: AppState, onBack: () -> Unit) {
    var users by remember { mutableStateOf<List<AppUser>>(emptyList()) }
    var sessions by remember { mutableStateOf<List<AppSession>>(emptyList()) }
    var editing by remember { mutableStateOf<AppUser?>(null) }
    var adding by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val me = state.auth.collectAsStateWithLifecycle().value.let { (it as? app.sentinel.core.Auth.LoggedIn)?.user }
    val status by state.status.collectAsStateWithLifecycle()
    val camNames = status?.cameras?.associate { it.id to it.name } ?: emptyMap()

    suspend fun load() {
        runCatching { state.api.users() }.onSuccess { users = it }
        runCatching { state.api.sessions() }.onSuccess { sessions = it.sortedByDescending { s -> s.lastSeen } }
    }
    LaunchedEffect(Unit) { load() }

    SubPage("Users", onBack, action = { RoundIcon(Icons.Rounded.Add, "Add user", size = 40.dp, background = C.Violet) { adding = true } }) {
        item {
            Text("Each person gets their own login. Viewers can be limited to some cameras; changing a password signs that person out everywhere.", color = C.TextDim, fontSize = 13.sp)
        }
        items(users, key = { it.id }) { u ->
            GlassCard(Modifier.fillMaxWidth(), onClick = { editing = u }) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.size(44.dp).clip(CircleShape).background(if (u.admin) C.Violet.copy(alpha = 0.3f) else C.Cyan.copy(alpha = 0.2f)), contentAlignment = Alignment.Center) {
                        Text(u.display.take(1).uppercase(), color = Color.White, fontWeight = FontWeight.Bold)
                    }
                    Column(Modifier.weight(1f).padding(horizontal = 12.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(u.display, style = MaterialTheme.typography.titleSmall)
                            Text("  @${u.username}", color = C.TextFaint, fontSize = 12.sp)
                        }
                        Text(
                            (if (u.admin || u.cameras.isEmpty()) "All cameras" else u.cameras.joinToString { camNames[it] ?: it }) +
                                " · " + (if (u.lastLogin > 0) "last login ${fmtAgo(u.lastLogin)}" else "never logged in"),
                            color = C.TextDim, fontSize = 12.sp, maxLines = 1,
                        )
                    }
                    if (u.admin) Pill("Admin", C.VioletLight)
                    if (u.disabled) Pill("Off", C.TextFaint)
                }
            }
        }
        if (sessions.isNotEmpty()) {
            item { SectionTitle("Signed-in phones") }
            items(sessions, key = { it.id }) { s ->
                Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Rounded.Smartphone, null, tint = C.TextDim, modifier = Modifier.size(20.dp))
                    Column(Modifier.weight(1f).padding(horizontal = 12.dp)) {
                        Text("${s.device.ifBlank { "Phone" }}  ", color = C.Text, fontSize = 14.sp)
                        Text("@${s.username} · ${fmtAgo(s.lastSeen)} · ${if (s.via == "home") "at home" else "over the internet"}${if (s.push) " · notifications" else ""}", color = C.TextFaint, fontSize = 12.sp)
                    }
                    RoundIcon(Icons.AutoMirrored.Rounded.Logout, "Sign out", size = 36.dp, tint = C.RoseLight, background = C.Rose.copy(alpha = 0.1f)) {
                        scope.launch {
                            runCatching { state.api.deleteSession(s.id) }.onSuccess { Toaster.show("Signed out ${s.device}"); load() }
                        }
                    }
                }
            }
        }
    }

    if (adding || editing != null) {
        UserSheet(state, editing, isMe = editing?.id == me?.id, onDismiss = { adding = false; editing = null }) {
            adding = false
            editing = null
            scope.launch { load() }
        }
    }
}

private fun strongPassword(): String {
    val chars = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789"
    val r = SecureRandom()
    return (1..12).map { chars[r.nextInt(chars.length)] }.joinToString("")
}

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
private fun UserSheet(state: AppState, user: AppUser?, isMe: Boolean, onDismiss: () -> Unit, onSaved: () -> Unit) {
    val status by state.status.collectAsStateWithLifecycle()
    val cams = status?.cameras ?: emptyList()
    val scope = rememberCoroutineScope()
    var username by remember { mutableStateOf(user?.username ?: "") }
    var name by remember { mutableStateOf(user?.name ?: "") }
    var password by remember { mutableStateOf(if (user == null) strongPassword() else "") }
    var admin by remember { mutableStateOf(user?.admin ?: false) }
    var allCams by remember { mutableStateOf(user == null || user.cameras.isEmpty()) }
    var selected by remember { mutableStateOf(user?.cameras?.toSet() ?: emptySet()) }
    var disabled by remember { mutableStateOf(user?.disabled ?: false) }
    var busy by remember { mutableStateOf(false) }
    var confirmDelete by remember { mutableStateOf(false) }

    val navBottom = androidx.compose.foundation.layout.WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()
    ModalBottomSheet(onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = C.Ink850) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp).imePadding().padding(bottom = navBottom)) {
            Text(if (user == null) "Add user" else "Edit ${user.username}", style = MaterialTheme.typography.titleLarge)
            Gap(16.dp)
            OutlinedTextField(username, { username = it.lowercase().filter { c -> c.isLetterOrDigit() || c in "._-" }.take(32) }, label = { Text("Username") }, singleLine = true, modifier = Modifier.fillMaxWidth(), shape = RoundedCornerShape(14.dp))
            Gap(10.dp)
            OutlinedTextField(name, { name = it.take(64) }, label = { Text("Name (optional)") }, singleLine = true, modifier = Modifier.fillMaxWidth(), shape = RoundedCornerShape(14.dp))
            Gap(10.dp)
            OutlinedTextField(
                password, { password = it }, label = { Text(if (user == null) "Password" else "New password (leave empty to keep)") }, singleLine = true,
                textStyle = MaterialTheme.typography.bodyLarge.copy(fontFamily = FontFamily.Monospace), modifier = Modifier.fillMaxWidth(), shape = RoundedCornerShape(14.dp),
                trailingIcon = { Icon(Icons.Rounded.Key, "Make a strong password", tint = C.VioletLight, modifier = Modifier.clip(CircleShape).clickable { password = strongPassword() }.padding(8.dp)) },
                supportingText = { Text(if (user == null) "At least 8 characters. Share it with them privately." else "Changing it signs this user out on every phone.") },
            )
            Gap(6.dp)
            ToggleRow("Admin", "Can also delete clips, restart cameras, see the activity log and manage users", admin, enabled = !isMe) { admin = it }
            if (!admin) {
                ToggleRow("All cameras", "Including cameras added later", allCams) { allCams = it }
                if (!allCams) FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(vertical = 8.dp)) {
                    cams.forEach { c -> Chip(c.name, c.id in selected) { selected = if (c.id in selected) selected - c.id else selected + c.id } }
                }
            }
            if (user != null && !isMe) ToggleRow("Switched off", "Blocks this account without removing it", disabled) { disabled = it }
            Gap(16.dp)
            GradientButton(
                if (user == null) "Add user" else "Save",
                Modifier.fillMaxWidth(),
                loading = busy,
                enabled = username.length >= 2 && (user != null || password.length >= 8) && (password.isEmpty() || password.length >= 8) && (admin || allCams || selected.isNotEmpty()),
            ) {
                busy = true
                scope.launch {
                    val input = UserInput(
                        username = username, name = name, password = password.ifEmpty { null }, admin = admin,
                        cameras = if (admin || allCams) emptyList() else selected.toList(), disabled = disabled,
                    )
                    runCatching { if (user == null) state.api.createUser(input) else state.api.updateUser(user.id, input) }
                        .onSuccess { Toaster.show(if (user == null) "$username added" else "$username saved"); onSaved() }
                        .onFailure { Toaster.error(it.message ?: "Couldn't save") }
                    busy = false
                }
            }
            if (user != null && !isMe) {
                Gap(10.dp)
                TextButton({ confirmDelete = true }, Modifier.fillMaxWidth()) {
                    Icon(Icons.Rounded.Delete, null, tint = C.RoseLight)
                    Text("  Remove user", color = C.RoseLight)
                }
            }
            Gap(24.dp)
        }
    }
    if (confirmDelete && user != null) {
        AlertDialog(
            onDismissRequest = { confirmDelete = false },
            title = { Text("Remove ${user.username}?") },
            text = { Text("Their phones are signed out at once.") },
            confirmButton = {
                TextButton({
                    scope.launch {
                        runCatching { state.api.deleteUser(user.id) }.onSuccess { Toaster.show("${user.username} removed"); onSaved() }.onFailure { Toaster.error(it.message ?: "Failed") }
                    }
                    confirmDelete = false
                }) { Text("Remove", color = C.RoseLight) }
            },
            dismissButton = { TextButton({ confirmDelete = false }) { Text("Cancel", color = C.TextDim) } },
            containerColor = C.Ink800,
        )
    }
}

@Composable
fun ToggleRow(title: String, sub: String?, checked: Boolean, enabled: Boolean = true, onChange: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth().clickable(enabled = enabled) { onChange(!checked) }.padding(vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(title, color = if (enabled) C.Text else C.TextFaint, fontSize = 15.sp)
            if (sub != null) Text(sub, color = C.TextFaint, fontSize = 12.sp)
        }
        Switch(
            checked, onChange, enabled = enabled,
            colors = SwitchDefaults.colors(checkedTrackColor = C.Violet, checkedThumbColor = Color.White, uncheckedTrackColor = C.Ink700, uncheckedBorderColor = C.Ink600, uncheckedThumbColor = C.TextDim),
        )
    }
}
