package app.sentinel.ui.screens

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowForward
import androidx.compose.material.icons.rounded.Dns
import androidx.compose.material.icons.rounded.Key
import androidx.compose.material.icons.rounded.Lock
import androidx.compose.material.icons.rounded.Person
import androidx.compose.material.icons.rounded.QrCodeScanner
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.Visibility
import androidx.compose.material.icons.rounded.VisibilityOff
import androidx.compose.material.icons.rounded.Wifi
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
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
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.sentinel.core.AppState
import app.sentinel.core.Auth
import app.sentinel.core.Engine
import app.sentinel.core.Found
import app.sentinel.ui.components.Backdrop
import app.sentinel.ui.components.Gap
import app.sentinel.ui.components.GlassCard
import app.sentinel.ui.components.GradientButton
import app.sentinel.ui.components.Logo
import app.sentinel.ui.components.SubtleButton
import app.sentinel.ui.components.glass
import app.sentinel.ui.theme.C
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import kotlinx.coroutines.launch

/** The shield with radar rings sweeping out of it. */
@Composable
fun RadarLogo(active: Boolean, modifier: Modifier = Modifier) {
    val t = rememberInfiniteTransition(label = "radar")
    val p by t.animateFloat(0f, 1f, infiniteRepeatable(tween(2400, easing = LinearEasing)), label = "p")
    val glow by t.animateFloat(0.6f, 1f, infiniteRepeatable(tween(1600), RepeatMode.Reverse), label = "g")
    Box(modifier.size(220.dp), contentAlignment = Alignment.Center) {
        Canvas(Modifier.fillMaxSize()) {
            val c = Offset(size.width / 2, size.height / 2)
            drawCircle(Brush.radialGradient(listOf(C.Violet.copy(alpha = 0.35f * glow), Color.Transparent), c, size.width / 2.2f), size.width / 2.2f, c)
            if (active) {
                for (i in 0 until 3) {
                    val q = (p + i / 3f) % 1f
                    drawCircle(
                        Brush.linearGradient(listOf(C.Violet, C.Cyan)),
                        radius = size.width * (0.18f + 0.32f * q),
                        center = c,
                        alpha = (1f - q) * 0.55f,
                        style = Stroke(width = 2.dp.toPx()),
                    )
                }
            }
        }
        Logo(Modifier.size(84.dp).graphicsLayer { scaleX = 0.96f + 0.04f * glow; scaleY = 0.96f + 0.04f * glow })
    }
}

@Composable
private fun fieldColors() = OutlinedTextFieldDefaults.colors(
    focusedBorderColor = C.Violet,
    unfocusedBorderColor = C.GlassBorder,
    focusedContainerColor = Color(0x0AFFFFFF),
    unfocusedContainerColor = Color(0x06FFFFFF),
    cursorColor = C.Cyan,
    focusedLabelColor = C.VioletLight,
    unfocusedLabelColor = C.TextDim,
    focusedLeadingIconColor = C.VioletLight,
    unfocusedLeadingIconColor = C.TextDim,
)

/** Pick a Sentinel: found on this Wi-Fi, scanned from its QR code, or typed. */
@Composable
fun ConnectScreen(state: AppState, deepLinkId: String?) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var searching by remember { mutableStateOf(true) }
    var found by remember { mutableStateOf<List<Found>>(emptyList()) }
    var typed by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }

    fun choose(raw: String) {
        val formatted = Engine.formatId(raw)
        if (formatted.isEmpty()) {
            error = "A Sentinel ID has 12 letters and digits, like 8779-T3ZH-FSW7."
            return
        }
        state.chooseServer(formatted.replace("-", ""))
    }

    fun search() = scope.launch {
        searching = true
        found = state.engine.discover()
        searching = false
    }

    LaunchedEffect(deepLinkId) {
        if (deepLinkId != null) choose(deepLinkId) else search()
    }

    Backdrop {
        Column(
            Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding().imePadding().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Gap(24.dp)
            RadarLogo(active = searching)
            Text("Sentinel", style = MaterialTheme.typography.displaySmall.copy(brush = C.textAccent))
            Gap(6.dp)
            Text("Your cameras, live and recorded, anywhere.", color = C.TextDim, style = MaterialTheme.typography.bodyLarge, textAlign = TextAlign.Center)
            Gap(32.dp)

            AnimatedContent(searching to found.isEmpty(), transitionSpec = { fadeIn(tween(300)) togetherWith fadeOut(tween(200)) }, label = "found") { (busy, none) ->
                Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.fillMaxWidth()) {
                    when {
                        busy -> Row(verticalAlignment = Alignment.CenterVertically) {
                            CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp, color = C.Cyan)
                            Text("  Looking for Sentinel on this Wi-Fi…", color = C.TextDim)
                        }
                        none -> Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.clip(CircleShape).clickable { search() }.padding(8.dp)) {
                            Icon(Icons.Rounded.Wifi, null, tint = C.TextFaint, modifier = Modifier.size(18.dp))
                            Text("  Not found on this network · ", color = C.TextFaint)
                            Text("Search again", color = C.VioletLight, fontWeight = FontWeight.SemiBold)
                        }
                        else -> Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                            Text("FOUND ON THIS WI-FI", color = C.TextDim, style = MaterialTheme.typography.labelSmall)
                            found.forEach { f ->
                                GlassCard(Modifier.fillMaxWidth(), onClick = { choose(f.id) }) {
                                    Row(verticalAlignment = Alignment.CenterVertically) {
                                        Box(Modifier.size(44.dp).clip(RoundedCornerShape(14.dp)).background(C.accent), contentAlignment = Alignment.Center) {
                                            Icon(Icons.Rounded.Dns, null, tint = Color.White)
                                        }
                                        Column(Modifier.weight(1f).padding(horizontal = 14.dp)) {
                                            Text(f.name.ifBlank { "Sentinel" }, style = MaterialTheme.typography.titleMedium)
                                            Text("${Engine.formatId(f.id)} · ${f.addr.substringBefore(':')}", color = C.TextDim, fontSize = 13.sp)
                                        }
                                        Icon(Icons.AutoMirrored.Rounded.ArrowForward, null, tint = C.VioletLight)
                                    }
                                }
                            }
                        }
                    }
                }
            }

            Gap(28.dp)
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.weight(1f).size(1.dp).background(C.GlassBorder))
                Text("  or  ", color = C.TextFaint, fontSize = 13.sp)
                Box(Modifier.weight(1f).size(1.dp).background(C.GlassBorder))
            }
            Gap(20.dp)

            OutlinedTextField(
                value = typed,
                onValueChange = { typed = it.uppercase().take(16); error = null },
                label = { Text("Sentinel ID") },
                placeholder = { Text("XXXX-XXXX-XXXX", color = C.TextFaint) },
                leadingIcon = { Icon(Icons.Rounded.Key, null) },
                singleLine = true,
                textStyle = TextStyle(fontFamily = FontFamily.Monospace, fontSize = 18.sp, letterSpacing = 1.5.sp, color = C.Text),
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Characters, autoCorrectEnabled = false, imeAction = ImeAction.Go),
                keyboardActions = KeyboardActions(onGo = { choose(typed) }),
                shape = RoundedCornerShape(16.dp),
                colors = fieldColors(),
                modifier = Modifier.fillMaxWidth(),
            )
            AnimatedVisibility(error != null, enter = expandVertically() + fadeIn()) {
                Text(error ?: "", color = C.RoseLight, fontSize = 13.sp, modifier = Modifier.padding(top = 8.dp))
            }
            Gap(14.dp)
            GradientButton("Continue", Modifier.fillMaxWidth(), enabled = typed.isNotBlank(), icon = Icons.AutoMirrored.Rounded.ArrowForward) { choose(typed) }
            Gap(12.dp)
            SubtleButton("Scan QR code", Modifier.fillMaxWidth(), icon = Icons.Rounded.QrCodeScanner) {
                GmsBarcodeScanning.getClient(context).startScan()
                    .addOnSuccessListener { code ->
                        val raw = code.rawValue ?: return@addOnSuccessListener
                        val id = if (raw.startsWith("sentinel://")) android.net.Uri.parse(raw).getQueryParameter("id") ?: "" else raw
                        choose(id)
                    }
                    .addOnFailureListener { error = "The QR scanner isn't available on this phone. Type the ID instead." }
            }
            Gap(20.dp)
            Text(
                "The QR code and ID are in Sentinel → Settings → Sentinel app.",
                color = C.TextFaint,
                fontSize = 13.sp,
                textAlign = TextAlign.Center,
            )
            Gap(32.dp)
        }
    }
}

@Composable
fun LoginScreen(state: AppState, auth: Auth.LoggedOut) {
    val scope = rememberCoroutineScope()
    val focus = LocalFocusManager.current
    var username by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var show by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf(auth.message) }
    val conn by state.engine.state.collectAsStateWithLifecycle()

    // Start connecting at once, so logging in is quick.
    LaunchedEffect(auth.serverId) { state.engine.connect() }

    fun submit() {
        if (username.isBlank() || password.isEmpty() || busy) return
        focus.clearFocus()
        busy = true
        error = null
        scope.launch {
            state.login(username, password).onFailure { error = it.message ?: "Couldn't log in" }
            busy = false
        }
    }

    Backdrop {
        Column(
            Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding().imePadding().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Gap(40.dp)
            RadarLogo(active = conn.state == "connecting", modifier = Modifier.size(170.dp))
            Text("Welcome back", style = MaterialTheme.typography.headlineMedium)
            Gap(10.dp)
            Row(
                Modifier.glass(CircleShape).clickable { state.forgetServer() }.padding(horizontal = 14.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.Rounded.Dns, null, tint = C.TextDim, modifier = Modifier.size(16.dp))
                Text("  ${Engine.formatId(auth.serverId)}", fontFamily = FontFamily.Monospace, color = C.Text, fontSize = 14.sp)
                Text("   Change", color = C.VioletLight, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
            }
            Gap(8.dp)
            AnimatedContent(conn.state, label = "conn") { s ->
                Text(
                    when (s) {
                        "connected" -> if (conn.path == "home") "Connected on your home network" else "Connected over the internet"
                        "connecting" -> "Connecting to Sentinel…"
                        "offline" -> conn.error ?: "Can't reach Sentinel"
                        else -> " "
                    },
                    color = when (s) { "connected" -> C.Emerald; "offline" -> C.RoseLight; else -> C.TextDim },
                    fontSize = 13.sp,
                    textAlign = TextAlign.Center,
                )
            }
            Gap(28.dp)
            OutlinedTextField(
                value = username,
                onValueChange = { username = it.lowercase().trim(); error = null },
                label = { Text("Username") },
                leadingIcon = { Icon(Icons.Rounded.Person, null) },
                singleLine = true,
                keyboardOptions = KeyboardOptions(autoCorrectEnabled = false, keyboardType = KeyboardType.Email, imeAction = ImeAction.Next),
                shape = RoundedCornerShape(16.dp),
                colors = fieldColors(),
                modifier = Modifier.fillMaxWidth(),
            )
            Gap(12.dp)
            OutlinedTextField(
                value = password,
                onValueChange = { password = it; error = null },
                label = { Text("Password") },
                leadingIcon = { Icon(Icons.Rounded.Lock, null) },
                trailingIcon = {
                    IconButton({ show = !show }) { Icon(if (show) Icons.Rounded.VisibilityOff else Icons.Rounded.Visibility, "Show password", tint = C.TextDim) }
                },
                singleLine = true,
                visualTransformation = if (show) VisualTransformation.None else PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = { submit() }),
                shape = RoundedCornerShape(16.dp),
                colors = fieldColors(),
                modifier = Modifier.fillMaxWidth(),
            )
            AnimatedVisibility(error != null, enter = slideInVertically() + fadeIn(), exit = fadeOut()) {
                Row(
                    Modifier.padding(top = 14.dp).fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(C.Rose.copy(alpha = 0.1f))
                        .border(1.dp, C.Rose.copy(alpha = 0.3f), RoundedCornerShape(14.dp)).padding(12.dp),
                ) { Text(error ?: "", color = C.RoseLight, fontSize = 14.sp) }
            }
            Gap(20.dp)
            GradientButton("Log in", Modifier.fillMaxWidth(), enabled = username.isNotBlank() && password.isNotEmpty(), loading = busy) { submit() }
            Gap(14.dp)
            if (conn.state == "offline") {
                SubtleButton("Try connecting again", icon = Icons.Rounded.Refresh) { scope.launch { state.engine.reconnect(); state.engine.connect() } }
            }
            Gap(24.dp)
            Text("Ask the person who runs Sentinel to add you under Settings → Sentinel app.", color = C.TextFaint, fontSize = 13.sp, textAlign = TextAlign.Center)
            Gap(32.dp)
        }
    }
}
