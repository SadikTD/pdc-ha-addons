package app.sentinel.ui.components

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.CloudOff
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.sentinel.core.AppState
import kotlinx.coroutines.launch

/** Plain words for why Sentinel can't be reached. */
fun friendlyConnError(raw: String?): String = when {
    raw == null -> "Trying to connect…"
    raw.contains("offline", true) -> "Sentinel isn't connected to the internet right now (a power cut or the router restarting?). It comes back by itself."
    raw.contains("can't reach the internet", true) || raw.contains("introducer", true) -> "This phone has no internet connection."
    raw.contains("identity", true) -> "Something else answered instead of your Sentinel, so the app refused it."
    else -> "Couldn't connect from this network. Check your internet and try again."
}

/** Shown instead of content while Sentinel can't be reached. */
@Composable
fun ConnectionProblem(state: AppState, modifier: Modifier = Modifier) {
    val conn by state.engine.state.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    val connecting = conn.state == "connecting"
    GlassCard(modifier.fillMaxWidth()) {
        Column(Modifier.fillMaxWidth().padding(8.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            if (connecting) CircularProgressIndicator(Modifier.size(34.dp), strokeWidth = 3.dp, color = app.sentinel.ui.theme.C.Cyan)
            else Icon(Icons.Rounded.CloudOff, null, tint = app.sentinel.ui.theme.C.RoseLight, modifier = Modifier.size(34.dp))
            Gap(12.dp)
            Text(if (connecting) "Connecting to Sentinel…" else "Can't reach Sentinel", style = MaterialTheme.typography.titleMedium)
            Gap(6.dp)
            Text(
                if (connecting) "Finding the fastest way to your cameras." else friendlyConnError(conn.error),
                color = app.sentinel.ui.theme.C.TextDim, fontSize = 14.sp, textAlign = TextAlign.Center,
            )
            if (!connecting) {
                Gap(16.dp)
                SubtleButton("Try again", icon = Icons.Rounded.Refresh) {
                    scope.launch {
                        state.engine.reconnect()
                        state.engine.connect()
                        state.refreshStatus()
                    }
                }
            }
        }
    }
}
