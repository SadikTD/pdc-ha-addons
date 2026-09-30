package app.sentinel.ui

import app.sentinel.ui.screens.PersonScreen
import app.sentinel.ui.screens.PeopleScreen
import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Bolt
import androidx.compose.material.icons.rounded.Fingerprint
import androidx.compose.material.icons.rounded.GridView
import androidx.compose.material.icons.rounded.Movie
import androidx.compose.material.icons.rounded.MoreHoriz
import androidx.compose.material.icons.rounded.ViewTimeline
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import app.sentinel.MainActivity
import app.sentinel.core.AppState
import app.sentinel.core.Auth
import app.sentinel.ui.components.Backdrop
import app.sentinel.ui.components.Gap
import app.sentinel.ui.components.GradientButton
import app.sentinel.ui.components.Logo
import app.sentinel.ui.components.ToastHost
import app.sentinel.ui.screens.CameraScreen
import app.sentinel.ui.screens.ClipsScreen
import app.sentinel.ui.screens.ConnectScreen
import app.sentinel.ui.screens.EventsScreen
import app.sentinel.ui.screens.LiveScreen
import app.sentinel.ui.screens.LoginScreen
import app.sentinel.ui.screens.MoreScreen
import app.sentinel.ui.screens.NotificationsScreen
import app.sentinel.ui.screens.NotificationPrompt
import app.sentinel.ui.screens.SettingsScreen
import app.sentinel.ui.screens.SummaryScreen
import app.sentinel.ui.screens.SystemScreen
import app.sentinel.ui.screens.TimelineScreen
import app.sentinel.ui.screens.UsersScreen
import app.sentinel.ui.theme.C

val LocalActivity = staticCompositionLocalOf<MainActivity> { error("no activity") }

@Composable
fun SentinelRoot(state: AppState, activity: MainActivity) {
    val auth by state.auth.collectAsStateWithLifecycle()
    CompositionLocalProvider(LocalActivity provides activity) {
        Box(Modifier.fillMaxSize().background(C.Ink950)) {
            AnimatedContent(
                targetState = auth,
                contentKey = { it::class },
                transitionSpec = { (fadeIn(tween(400)) + scaleIn(initialScale = 0.96f)) togetherWith fadeOut(tween(250)) },
                label = "auth",
            ) { a ->
                when (a) {
                    Auth.Loading -> Backdrop { Logo(Modifier.size(84.dp).align(Alignment.Center)) }
                    Auth.NoServer -> ConnectScreen(state, activity.deepLinkId).also { LaunchedEffect(Unit) { activity.consumeDeepLink() } }
                    is Auth.LoggedOut -> LoginScreen(state, a)
                    is Auth.LoggedIn -> MainNav(state)
                }
            }
            if (activity.locked && auth is Auth.LoggedIn) LockScreen { activity.unlock() }
            ToastHost()
        }
    }
}

@Composable
private fun LockScreen(onUnlock: () -> Unit) {
    LaunchedEffect(Unit) { onUnlock() }
    Backdrop(Modifier.clickable(remember { MutableInteractionSource() }, null) {}) {
        Column(Modifier.align(Alignment.Center).padding(32.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Logo(Modifier.size(72.dp))
            Gap(20.dp)
            Text("Sentinel is locked", style = MaterialTheme.typography.titleLarge)
            Gap(24.dp)
            GradientButton("Unlock", icon = Icons.Rounded.Fingerprint, modifier = Modifier.width(200.dp), onClick = onUnlock)
        }
    }
}

object Routes {
    const val Tabs = "tabs"
    const val Camera = "camera/{id}?t={t}&ev={ev}"
    const val Users = "users"
    const val System = "system"
    const val Settings = "settings"
    const val Notifications = "notifications"
    const val People = "people"
    const val Person = "person/{id}"
    const val Summary = "summary?date={date}"
    fun summary(date: String? = null) = "summary" + (date?.takeIf { it.isNotBlank() }?.let { "?date=$it" } ?: "")
    fun camera(id: String, t: Long? = null, ev: String? = null) = "camera/$id" + (if (t != null) "?t=$t" else "") + (if (ev != null) "${if (t != null) "&" else "?"}ev=${android.net.Uri.encode(ev)}" else "")
}

@Composable
private fun MainNav(state: AppState) {
    val nav = rememberNavController()
    val activity = LocalActivity.current
    // Opened from a notification: go to that camera and moment.
    LaunchedEffect(activity.openCamera) {
        val (id, t) = activity.openCamera ?: return@LaunchedEffect
        activity.openCamera = null
        nav.navigate(Routes.camera(id, t)) { popUpTo(Routes.Tabs) }
    }
    LaunchedEffect(activity.openSummary) {
        val d = activity.openSummary ?: return@LaunchedEffect
        activity.openSummary = null
        nav.navigate(Routes.summary(d)) { popUpTo(Routes.Tabs) }
    }
    NavHost(
        nav,
        startDestination = Routes.Tabs,
        enterTransition = { slideInHorizontally(tween(320)) { it / 5 } + fadeIn(tween(320)) },
        exitTransition = { fadeOut(tween(200)) },
        popEnterTransition = { fadeIn(tween(250)) },
        popExitTransition = { slideOutHorizontally(tween(280)) { it / 5 } + fadeOut(tween(280)) },
    ) {
        composable(Routes.Tabs) { Tabs(state, nav) }
        composable(
            Routes.Camera,
            arguments = listOf(
                navArgument("id") { type = NavType.StringType },
                navArgument("t") { type = NavType.LongType; defaultValue = 0L },
                navArgument("ev") { type = NavType.StringType; nullable = true; defaultValue = null },
            ),
            enterTransition = { scaleIn(tween(320), initialScale = 0.92f) + fadeIn(tween(320)) },
            popExitTransition = { scaleOut(tween(260), targetScale = 0.92f) + fadeOut(tween(260)) },
        ) { entry ->
            val id = entry.arguments?.getString("id") ?: return@composable
            val t = entry.arguments?.getLong("t")?.takeIf { it > 0 }
            CameraScreen(
                state, id, t, entry.arguments?.getString("ev"),
                onBack = { nav.popBackStack() },
                onOpenCamera = { nav.navigate(Routes.camera(it)) { popUpTo(Routes.Tabs) } },
                // The next event is on another camera: replace this screen, so back still returns to the list.
                onStep = { nav.navigate(Routes.camera(it.c, it.t, it.id)) { popUpTo(Routes.Camera) { inclusive = true } } },
            )
        }
        composable(Routes.Users) { UsersScreen(state, onBack = { nav.popBackStack() }) }
        composable(Routes.System) { SystemScreen(state, onBack = { nav.popBackStack() }, onOpenCamera = { nav.navigate(Routes.camera(it)) }) }
        composable(Routes.Settings) { SettingsScreen(state, onBack = { nav.popBackStack() }) }
        composable(Routes.Notifications) { NotificationsScreen(state, onBack = { nav.popBackStack() }) }
        composable(Routes.People) {
            PeopleScreen(state, onBack = { nav.popBackStack() }, openCamera = { id, t -> nav.navigate(Routes.camera(id, t)) }, openPerson = { nav.navigate("person/$it") })
        }
        composable(Routes.Person, arguments = listOf(navArgument("id") { type = NavType.StringType })) { entry ->
            PersonScreen(state, entry.arguments?.getString("id") ?: "", onBack = { nav.popBackStack() }, openCamera = { id, t -> nav.navigate(Routes.camera(id, t)) })
        }
        composable(Routes.Summary, arguments = listOf(navArgument("date") { type = NavType.StringType; nullable = true; defaultValue = null })) { entry ->
            SummaryScreen(state, entry.arguments?.getString("date"), onBack = { nav.popBackStack() }, openCamera = { id, t -> nav.navigate(Routes.camera(id, t)) }, onPerson = { nav.navigate("person/$it") })
        }
    }
}

private data class Tab(val label: String, val icon: androidx.compose.ui.graphics.vector.ImageVector)

private val TABS = listOf(
    Tab("Live", Icons.Rounded.GridView),
    Tab("Events", Icons.Rounded.Bolt),
    Tab("Timeline", Icons.Rounded.ViewTimeline),
    Tab("Clips", Icons.Rounded.Movie),
    Tab("More", Icons.Rounded.MoreHoriz),
)

@Composable
private fun Tabs(state: AppState, nav: NavHostController) {
    var tab by rememberSaveable { mutableIntStateOf(0) }
    BackHandler(tab != 0) { tab = 0 }
    val top = WindowInsets.statusBars.asPaddingValues().calculateTopPadding()
    val padding = PaddingValues(top = top, bottom = 96.dp)
    val openCamera: (String, Long?) -> Unit = { id, t -> nav.navigate(Routes.camera(id, t)) }
    Backdrop {
        AnimatedContent(
            tab,
            transitionSpec = {
                val dir = if (targetState > initialState) 1 else -1
                (slideInHorizontally(tween(300)) { dir * it / 8 } + fadeIn(tween(300))) togetherWith (slideOutHorizontally(tween(250)) { -dir * it / 8 } + fadeOut(tween(200)))
            },
            label = "tab",
        ) { t ->
            when (t) {
                0 -> LiveScreen(state, padding, onSummary = { nav.navigate(Routes.summary()) }) { openCamera(it.id, null) }
                1 -> EventsScreen(state, padding) { nav.navigate(Routes.camera(it.c, it.t, it.id)) }
                2 -> TimelineScreen(state, padding, openCamera)
                3 -> ClipsScreen(state, padding)
                else -> MoreScreen(state, padding, onUsers = { nav.navigate(Routes.Users) }, onSystem = { nav.navigate(Routes.System) }, onSettings = { nav.navigate(Routes.Settings) }, onNotifications = { nav.navigate(Routes.Notifications) }, onSummary = { nav.navigate(Routes.summary()) }, onPeople = { nav.navigate(Routes.People) })
            }
        }
        TabBar(tab, Modifier.align(Alignment.BottomCenter)) { tab = it }
        NotificationPrompt(state)
    }
}

/** Floating glass tab bar with a gradient pill that springs to the selected tab. */
@Composable
private fun TabBar(selected: Int, modifier: Modifier, onSelect: (Int) -> Unit) {
    val haptic = LocalHapticFeedback.current
    BoxWithConstraints(
        modifier
            .navigationBarsPadding()
            .padding(horizontal = 14.dp, vertical = 10.dp)
            .fillMaxWidth()
            .height(66.dp)
            .clip(RoundedCornerShape(24.dp))
            .background(Color(0xE60E121B))
            .border(1.dp, C.GlassBorder, RoundedCornerShape(24.dp)),
    ) {
        val w = maxWidth / TABS.size
        val x by animateDpAsState(w * selected, spring(dampingRatio = 0.72f, stiffness = Spring.StiffnessMediumLow), label = "x")
        Box(Modifier.offset(x = x).width(w).fillMaxHeight().padding(6.dp).clip(RoundedCornerShape(18.dp)).background(C.accentH.let { androidx.compose.ui.graphics.Brush.horizontalGradient(listOf(C.Violet.copy(alpha = 0.9f), C.Cyan.copy(alpha = 0.8f))) }))
        Row(Modifier.fillMaxSize(), horizontalArrangement = Arrangement.SpaceEvenly) {
            TABS.forEachIndexed { i, t ->
                Column(
                    Modifier.weight(1f).fillMaxHeight().clickable(remember { MutableInteractionSource() }, null) {
                        if (i != selected) haptic.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                        onSelect(i)
                    },
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.Center,
                ) {
                    Icon(t.icon, t.label, tint = if (i == selected) Color.White else C.TextDim, modifier = Modifier.size(22.dp))
                    Text(t.label, color = if (i == selected) Color.White else C.TextDim, fontSize = 10.sp, fontWeight = if (i == selected) FontWeight.SemiBold else FontWeight.Medium)
                }
            }
        }
    }
}
