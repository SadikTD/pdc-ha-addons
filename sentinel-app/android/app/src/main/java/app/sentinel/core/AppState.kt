package app.sentinel.core

import androidx.compose.runtime.setValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.getValue
import android.content.Context
import android.os.Build
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

private val Context.store by preferencesDataStore("sentinel")

/** App preferences the user can change. */
data class AppPrefs(
    val gridColumns: Int = 0, // 0 = automatic
    val dataSaver: Boolean = false,
    val appLock: Boolean = false,
    val keepScreenOn: Boolean = true,
    val cameraOrder: List<String> = emptyList(),
    val hidden: Set<String> = emptySet(),
    val tipsSeen: Boolean = false,
    val askedNotifications: Boolean = false,
)

sealed interface Auth {
    data object Loading : Auth
    data object NoServer : Auth
    data class LoggedOut(val serverId: String, val message: String? = null) : Auth
    data class LoggedIn(val serverId: String, val user: AppUser, val server: ServerInfo) : Auth
}

/**
 * Everything the screens share: who is logged in, Sentinel's live status (polled while
 * the app is open) and the app's preferences.
 */
class AppState(private val context: Context, val engine: Engine, val api: Api) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    private object K {
        val server = stringPreferencesKey("server_id")
        val token = stringPreferencesKey("token")
        val user = stringPreferencesKey("user")
        val serverInfo = stringPreferencesKey("server_info")
        val cols = intPreferencesKey("grid_cols")
        val saver = booleanPreferencesKey("data_saver")
        val lock = booleanPreferencesKey("app_lock")
        val screenOn = booleanPreferencesKey("keep_screen_on")
        val order = stringPreferencesKey("camera_order")
        val hidden = stringPreferencesKey("hidden")
        val tips = booleanPreferencesKey("tips_seen")
        val asked = booleanPreferencesKey("asked_notifications")
    }

    private val _auth = MutableStateFlow<Auth>(Auth.Loading)
    val auth: StateFlow<Auth> = _auth.asStateFlow()

    private val _status = MutableStateFlow<Status?>(null)
    val status: StateFlow<Status?> = _status.asStateFlow()

    /** Notifications: whether Sentinel has them set up, and this phone's choices. */
    private val _pushAvailable = MutableStateFlow(false)
    val pushAvailable: StateFlow<Boolean> = _pushAvailable.asStateFlow()
    private val _pushPrefs = MutableStateFlow(PushPrefs())
    val pushPrefs: StateFlow<PushPrefs> = _pushPrefs.asStateFlow()

    private val _statusError = MutableStateFlow<String?>(null)
    val statusError: StateFlow<String?> = _statusError.asStateFlow()

    val prefs: StateFlow<AppPrefs> = MutableStateFlow(AppPrefs()).also { flow ->
        scope.launch {
            context.store.data.map { p -> p.toPrefs() }.collect { flow.value = it }
        }
    }

    private fun Preferences.toPrefs() = AppPrefs(
        gridColumns = this[K.cols] ?: 0,
        dataSaver = this[K.saver] ?: false,
        appLock = this[K.lock] ?: false,
        keepScreenOn = this[K.screenOn] ?: true,
        cameraOrder = this[K.order]?.split(",")?.filter { it.isNotBlank() } ?: emptyList(),
        hidden = this[K.hidden]?.split(",")?.filter { it.isNotBlank() }?.toSet() ?: emptySet(),
        tipsSeen = this[K.tips] ?: false,
        askedNotifications = this[K.asked] ?: false,
    )

    init {
        scope.launch {
            val p = context.store.data.first()
            val server = p[K.server]
            val token = p[K.token]
            val user = p[K.user]?.let { runCatching { Engine.json.decodeFromString<AppUser>(it) }.getOrNull() }
            val info = p[K.serverInfo]?.let { runCatching { Engine.json.decodeFromString<ServerInfo>(it) }.getOrNull() } ?: ServerInfo()
            _auth.value = when {
                server == null -> Auth.NoServer
                token == null || user == null -> Auth.LoggedOut(server).also { engine.setServer(server) }
                else -> {
                    engine.setServer(server)
                    engine.setToken(token)
                    Auth.LoggedIn(server, user, info)
                }
            }
            if (_auth.value is Auth.LoggedIn) refreshMe()
        }
        scope.launch {
            api.onUnauthorized.collect {
                val a = _auth.value
                if (a is Auth.LoggedIn) signedOut(a.serverId, "You were signed out. Please log in again.")
            }
        }
    }

    /** Refresh the account (an admin may have changed it) without blocking the UI. */
    private fun refreshMe() = scope.launch {
        runCatching { api.me() }.onSuccess { me ->
            _pushPrefs.value = me.prefs
            _pushAvailable.value = me.push != null
            if (me.push != null && Push.init(context, me.push)) registerPush()
            val a = _auth.value
            if (a is Auth.LoggedIn) {
                _auth.value = a.copy(user = me.user, server = me.server)
                context.store.edit {
                    it[K.user] = Engine.json.encodeToString(me.user)
                    it[K.serverInfo] = Engine.json.encodeToString(me.server)
                }
            }
        }
    }

    fun chooseServer(id: String) {
        engine.setServer(id)
        _auth.value = Auth.LoggedOut(id)
        scope.launch { context.store.edit { it[K.server] = id } }
    }

    fun forgetServer() {
        val wasLoggedIn = _auth.value is Auth.LoggedIn
        _auth.value = Auth.NoServer
        scope.launch {
            if (wasLoggedIn) api.logout()
            engine.setToken(null)
            context.store.edit {
                it.remove(K.server); it.remove(K.token); it.remove(K.user)
            }
        }
    }

    suspend fun login(username: String, password: String): Result<Unit> = runCatching {
        val a = _auth.value
        val serverId = (a as? Auth.LoggedOut)?.serverId ?: error("Choose a Sentinel first")
        val device = "${Build.MANUFACTURER.replaceFirstChar { it.uppercase() }} ${Build.MODEL}".take(60)
        val r = api.login(username.trim(), password, device)
        engine.setToken(r.token)
        context.store.edit {
            it[K.token] = r.token
            it[K.user] = Engine.json.encodeToString(r.user)
            it[K.serverInfo] = Engine.json.encodeToString(r.server)
        }
        _status.value = null
        _auth.value = Auth.LoggedIn(serverId, r.user, r.server)
        refreshMe()
    }

    /** Tells Sentinel where to send this phone's notifications. */
    suspend fun registerPush(token: String? = null) {
        if (_auth.value !is Auth.LoggedIn) return
        val t = token ?: Push.token() ?: return
        runCatching { api.setPush(t, null) }.onSuccess { _pushPrefs.value = it }
    }

    fun setPushPrefs(p: PushPrefs) {
        _pushPrefs.value = p
        scope.launch { runCatching { api.setPush(null, p) }.onSuccess { _pushPrefs.value = it } }
    }

    fun logout() {
        val a = _auth.value as? Auth.LoggedIn ?: return
        scope.launch {
            api.logout()
            signedOut(a.serverId, null)
        }
    }

    private suspend fun signedOut(serverId: String, message: String?) {
        engine.setToken(null)
        context.store.edit { it.remove(K.token); it.remove(K.user) }
        _status.value = null
        _auth.value = Auth.LoggedOut(serverId, message)
    }

    fun setPrefs(change: (AppPrefs) -> AppPrefs) = scope.launch {
        val n = change(prefs.value)
        context.store.edit {
            it[K.cols] = n.gridColumns
            it[K.saver] = n.dataSaver
            it[K.lock] = n.appLock
            it[K.screenOn] = n.keepScreenOn
            it[K.order] = n.cameraOrder.joinToString(",")
            it[K.hidden] = n.hidden.joinToString(",")
            it[K.tips] = n.tipsSeen
            it[K.asked] = n.askedNotifications
        }
    }

    private var poller: Job? = null

    /** Poll Sentinel's status while the app is in the foreground. */
    fun startPolling() {
        if (poller?.isActive == true) return
        poller = scope.launch {
            while (isActive) {
                if (_auth.value is Auth.LoggedIn) refreshStatus()
                delay(if (_statusError.value == null) 2500 else 4000)
            }
        }
    }

    fun stopPolling() {
        poller?.cancel()
        poller = null
    }

    suspend fun refreshStatus() {
        runCatching { api.status() }
            .onSuccess {
                if (it.now > 0) skew = it.now - System.currentTimeMillis()
                _status.value = it
                _statusError.value = null
            }
            .onFailure { _statusError.value = it.message }
    }

    /** Cameras in the user's order (new cameras at the end), hidden ones left out. */
    fun orderedCameras(s: Status?, p: AppPrefs, includeHidden: Boolean = false): List<CameraStatus> {
        val cams = s?.cameras ?: return emptyList()
        val idx = p.cameraOrder.withIndex().associate { it.value to it.index }
        return cams.sortedBy { idx[it.id] ?: (1000 + cams.indexOf(it)) }.filter { includeHidden || it.id !in p.hidden }
    }

    /** Waits while the app isn't on screen: screens' refresh loops pause in the background (no data use, and the connection can go idle). */
    suspend fun awaitVisible() {
        androidx.lifecycle.ProcessLifecycleOwner.get().lifecycle.currentStateFlow.first { it.isAtLeast(androidx.lifecycle.Lifecycle.State.STARTED) }
    }

    /** Sentinel's clock minus this phone's (recordings and events use Sentinel's time). */
    @Volatile var skew: Long = 0L
        private set

    /** "Now" on Sentinel's clock. */
    fun serverNow(): Long = System.currentTimeMillis() + skew

    val isAdmin: Boolean get() = (auth.value as? Auth.LoggedIn)?.user?.admin == true

    // ---- Events opened from a list ----
    /** The last event lists fetched, so coming back from an event shows the list at once. */
    val eventsCache = HashMap<String, List<SentinelEvent>>()
    /** The list an event was opened from: the player steps through it (previous / next). */
    var eventList: List<ListItem> = emptyList()
    /** The event last opened from the list, marked there when coming back. */
    var lastWatched by mutableStateOf<String?>(null)
}

/** An event in a list: its camera, id, and where playback starts. */
data class ListItem(val c: String, val id: String, val t: Long)
