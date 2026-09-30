package app.sentinel.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.Login
import androidx.compose.material.icons.automirrored.rounded.Logout
import androidx.compose.material.icons.rounded.MeetingRoom
import androidx.compose.material.icons.rounded.Person
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.sentinel.core.AppState
import app.sentinel.core.PersonInfo
import app.sentinel.core.PresenceResponse
import app.sentinel.core.fmtDay
import app.sentinel.core.fmtDuration
import app.sentinel.core.fmtTime
import app.sentinel.core.startOfDay
import app.sentinel.ui.components.Chip
import app.sentinel.ui.components.GlassCard
import app.sentinel.ui.theme.C
import coil3.compose.AsyncImage
import kotlinx.coroutines.delay

private const val DAY_MS = 24 * 3600_000L

/** Comings and goings: when the people named came home and went out, and who is home now. */
@Composable
fun PresenceScreen(state: AppState, onBack: () -> Unit, openCamera: (String, Long) -> Unit) {
    val api = state.api
    val status by state.status.collectAsStateWithLifecycle()
    var days by remember { mutableIntStateOf(3) }
    var who by remember { mutableStateOf<String?>(null) }
    var data by remember { mutableStateOf<PresenceResponse?>(null) }
    var people by remember { mutableStateOf<List<PersonInfo>>(emptyList()) }
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) { runCatching { api.people() }.onSuccess { people = it.people } }
    LaunchedEffect(days) {
        while (true) {
            val to = state.serverNow()
            val from = if (days == 0) startOfDay(to) else to - days * DAY_MS
            runCatching { api.presence(from, to) }.onSuccess { data = it; error = null }.onFailure { error = it.message }
            delay(30_000)
            state.awaitVisible()
        }
    }
    fun cover(id: String) = people.firstOrNull { it.id == id }?.cover
    fun camName(id: String) = status?.cameras?.firstOrNull { it.id == id }?.name ?: id
    val d = data

    SubPage("Comings & goings", onBack) {
        when {
            d == null -> item {
                Box(Modifier.fillMaxWidth().padding(40.dp), contentAlignment = Alignment.Center) {
                    if (error != null) Text(error ?: "", color = C.RoseLight) else CircularProgressIndicator(color = C.Cyan)
                }
            }
            !d.enabled -> item {
                GlassCard(Modifier.fillMaxWidth()) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.fillMaxWidth()) {
                        Icon(Icons.Rounded.MeetingRoom, null, tint = C.VioletLight, modifier = Modifier.size(36.dp))
                        Text("Not set up yet", fontSize = 17.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 10.dp))
                        Text(
                            "Turn it on in Sentinel on the web: People → Comings & goings → Customize, and choose the cameras at your way in and out.",
                            color = C.TextDim, fontSize = 13.sp, modifier = Modifier.padding(top = 6.dp),
                        )
                    }
                }
            }
            else -> {
                // Who is home now.
                item {
                    Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        d.now.forEach { n ->
                            val sel = who == n.person
                            Row(
                                Modifier.clip(RoundedCornerShape(18.dp)).background(if (sel) C.Violet.copy(alpha = 0.25f) else Color(0x10FFFFFF))
                                    .clickable { who = if (sel) null else n.person }.padding(start = 6.dp, end = 14.dp, top = 6.dp, bottom = 6.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Avatar(state, cover(n.person))
                                Column(Modifier.padding(start = 10.dp)) {
                                    Text(n.name, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
                                    val (c, label) = when (n.state) {
                                        "home" -> C.Emerald to "Home"
                                        "away" -> C.Amber to "Out"
                                        else -> C.TextFaint to "Not seen lately"
                                    }
                                    Row(verticalAlignment = Alignment.CenterVertically) {
                                        Box(Modifier.size(6.dp).clip(CircleShape).background(c))
                                        Text(" $label" + (if (n.since > 0) " since ${fmtTime(n.since)}" else ""), color = c, fontSize = 11.sp)
                                    }
                                }
                            }
                        }
                    }
                }
                item {
                    Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        listOf("Today" to 0, "3 days" to 3, "7 days" to 7, "30 days" to 30).forEach { (l, n) -> Chip(l, days == n) { days = n } }
                    }
                }
                val list = d.entries.filter { who == null || it.person == who }
                if (list.isEmpty()) item {
                    Text(
                        "No comings or goings yet. They appear as the people you named are seen leaving past, and coming back past, the entrance cameras.",
                        color = C.TextDim, fontSize = 13.sp, modifier = Modifier.padding(vertical = 24.dp),
                    )
                }
                list.groupBy { startOfDay(it.t) }.forEach { (day, entries) ->
                    item { Text(fmtDay(day), color = C.TextDim, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 8.dp)) }
                    items(entries, key = { "${it.person}/${it.kind}/${it.t}" }) { e ->
                        val inn = e.kind == "arrived"
                        GlassCard(Modifier.fillMaxWidth(), padding = androidx.compose.foundation.layout.PaddingValues(12.dp), onClick = { openCamera(e.cam, e.t - 5000) }) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Box(
                                    Modifier.size(36.dp).clip(RoundedCornerShape(11.dp)).background((if (inn) C.Emerald else C.Amber).copy(alpha = 0.12f)),
                                    contentAlignment = Alignment.Center,
                                ) {
                                    Icon(if (inn) Icons.AutoMirrored.Rounded.Login else Icons.AutoMirrored.Rounded.Logout, null, tint = if (inn) C.Emerald else C.Amber, modifier = Modifier.size(18.dp))
                                }
                                Box(Modifier.padding(start = 10.dp)) { Avatar(state, cover(e.person)) }
                                Column(Modifier.weight(1f).padding(horizontal = 10.dp)) {
                                    Text("${e.name} ${if (inn) "came home" else "went out"}", fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
                                    val extra = buildList {
                                        add((if (inn) "Seen on " else "Last seen on ") + camName(e.cam))
                                        if (inn && e.outFor > 0) add("out for ${fmtDuration(e.outFor)}")
                                        if (e.by == "clothing") add("by clothes")
                                    }.joinToString(" · ")
                                    Text(extra, color = C.TextFaint, fontSize = 12.sp)
                                }
                                Text(fmtTime(e.t), color = C.Text, fontSize = 13.sp)
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun Avatar(state: AppState, faceId: String?) {
    if (faceId != null) {
        AsyncImage(state.api.faceUrl(faceId), null, contentScale = ContentScale.Crop, modifier = Modifier.size(36.dp).clip(RoundedCornerShape(11.dp)))
    } else {
        Box(Modifier.size(36.dp).clip(RoundedCornerShape(11.dp)).background(Color(0x10FFFFFF)), contentAlignment = Alignment.Center) {
            Icon(Icons.Rounded.Person, null, tint = C.TextFaint, modifier = Modifier.size(18.dp))
        }
    }
}
