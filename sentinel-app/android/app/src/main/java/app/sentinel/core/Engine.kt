package app.sentinel.core

import android.content.Context
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import android.net.NetworkCapabilities
import app.sentinel.tunnel.Tunnel
import app.sentinel.tunnel.Tunnel_
import java.io.File
import java.net.Inet4Address
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import okhttp3.ConnectionPool
import okhttp3.OkHttpClient

/**
 * The connection to Sentinel. The Go engine (tunnel.aar) connects directly to Sentinel,
 * at home over Wi-Fi or across the internet, and serves a private proxy on 127.0.0.1;
 * everything in the app (API, images, video) just uses [url].
 */
class Engine(context: Context) {
    private val app = context.applicationContext
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    val tunnel: Tunnel_ = Tunnel.new_(File(app.filesDir, "tunnel").path)

    /** http://127.0.0.1:port/secret */
    val base: String = tunnel.start()

    fun url(path: String) = "$base/${path.trimStart('/')}"

    val http: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(40, TimeUnit.SECONDS)
        .connectionPool(ConnectionPool(16, 5, TimeUnit.MINUTES))
        .build()

    /** For live video and downloads: no read timeout on long streams. */
    val streamHttp: OkHttpClient = http.newBuilder().readTimeout(20, TimeUnit.SECONDS).build()

    private val _state = MutableStateFlow(TunnelState())
    val state: StateFlow<TunnelState> = _state.asStateFlow()

    private var currentNetwork: Network? = null

    init {
        watchNetwork()
        scope.launch {
            while (isActive) {
                runCatching { json.decodeFromString<TunnelState>(tunnel.stateJSON()) }.onSuccess { _state.value = it }
                delay(1000)
            }
        }
    }

    fun setServer(id: String) = tunnel.setServer(id, "")

    fun setToken(token: String?) = tunnel.setToken(token ?: "")

    /** Connect now instead of on the first request. */
    suspend fun connect(): Result<Unit> = withContext(Dispatchers.IO) {
        runCatching { tunnel.connect() }
    }

    fun reconnect() = scope.launch { tunnel.reconnect() }

    suspend fun discover(): List<Found> = withContext(Dispatchers.IO) {
        runCatching { json.decodeFromString<List<Found>>(Tunnel.discover(localIPv4().firstOrNull() ?: "", 1600)) }.getOrDefault(emptyList())
    }

    private fun localIPv4(lp: LinkProperties? = null): List<String> {
        val cm = app.getSystemService(ConnectivityManager::class.java)
        val props = lp ?: cm.getLinkProperties(cm.activeNetwork) ?: return emptyList()
        return props.linkAddresses.mapNotNull { (it.address as? Inet4Address)?.hostAddress }
    }

    /**
     * When the phone moves between Wi-Fi and mobile data, the old path is dead: tell the
     * engine the new addresses and reconnect at once (instead of waiting for a timeout).
     */
    private fun watchNetwork() {
        val cm = app.getSystemService(ConnectivityManager::class.java)
        cm.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                val changed = currentNetwork != null && currentNetwork != network
                currentNetwork = network
                tunnel.setLocalIPs(localIPv4(cm.getLinkProperties(network)).joinToString(","))
                if (changed) reconnect()
            }

            override fun onLinkPropertiesChanged(network: Network, lp: LinkProperties) {
                tunnel.setLocalIPs(localIPv4(lp).joinToString(","))
            }

            override fun onCapabilitiesChanged(network: Network, nc: NetworkCapabilities) {}

            override fun onLost(network: Network) {
                if (network == currentNetwork) currentNetwork = null
            }
        })
    }

    val isOnWifi: Boolean
        get() {
            val cm = app.getSystemService(ConnectivityManager::class.java)
            val nc = cm.getNetworkCapabilities(cm.activeNetwork) ?: return false
            return nc.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) || nc.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)
        }

    companion object {
        val json = Json { ignoreUnknownKeys = true; explicitNulls = false; encodeDefaults = false; coerceInputValues = true }

        fun formatId(id: String): String = Tunnel.formatID(id)
    }
}
