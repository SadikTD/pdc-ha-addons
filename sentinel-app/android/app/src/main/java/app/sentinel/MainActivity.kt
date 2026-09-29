package app.sentinel

import android.app.PictureInPictureParams
import android.content.Intent
import android.content.res.Configuration
import android.os.Build
import android.os.Bundle
import android.util.Rational
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.content.ContextCompat
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.fragment.app.FragmentActivity
import app.sentinel.ui.SentinelRoot
import app.sentinel.ui.theme.SentinelTheme

class MainActivity : FragmentActivity() {
    /** sentinel://connect?id=… from a QR code or a shared link. */
    var deepLinkId by mutableStateOf<String?>(null)
        private set
    /** A camera to open (from a notification): id and moment. */
    var openCamera by mutableStateOf<Pair<String, Long?>?>(null)
    var inPip by mutableStateOf(false)
        private set
    var locked by mutableStateOf(false)
        private set
    private var backgroundAt = 0L

    /** Set by the camera screen while video plays: go to picture-in-picture on Home. */
    var pipAspect: Rational? = null
        set(value) {
            field = value
            updatePip()
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        installSplashScreen()
        super.onCreate(savedInstanceState)
        enableEdgeToEdge(statusBarStyle = SystemBarStyle.dark(0), navigationBarStyle = SystemBarStyle.dark(0))
        handleIntent(intent)
        val app = application as SentinelApp
        locked = app.state.prefs.value.appLock
        setContent {
            SentinelTheme {
                SentinelRoot(app.state, this)
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    private fun handleIntent(intent: Intent?) {
        val data = intent?.data ?: return
        if (data.scheme != "sentinel") return
        when (data.host) {
            "connect" -> deepLinkId = data.getQueryParameter("id")
            "camera" -> data.getQueryParameter("id")?.let { openCamera = it to data.getQueryParameter("t")?.toLongOrNull() }
        }
    }

    fun consumeDeepLink() {
        deepLinkId = null
    }

    override fun onStop() {
        super.onStop()
        backgroundAt = System.currentTimeMillis()
    }

    override fun onStart() {
        super.onStart()
        val app = application as SentinelApp
        // Lock again after 30 s away (not for a quick look at another app).
        if (app.state.prefs.value.appLock && backgroundAt > 0 && System.currentTimeMillis() - backgroundAt > 30_000) locked = true
    }

    fun unlock() {
        val canAuth = BiometricManager.from(this).canAuthenticate(
            BiometricManager.Authenticators.BIOMETRIC_WEAK or BiometricManager.Authenticators.DEVICE_CREDENTIAL,
        )
        if (canAuth != BiometricManager.BIOMETRIC_SUCCESS) {
            locked = false // no lock screen set up on the phone: nothing to check against
            return
        }
        val prompt = BiometricPrompt(this, ContextCompat.getMainExecutor(this), object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                locked = false
            }
        })
        prompt.authenticate(
            BiometricPrompt.PromptInfo.Builder()
                .setTitle("Unlock Sentinel")
                .setSubtitle("Your cameras are protected")
                .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_WEAK or BiometricManager.Authenticators.DEVICE_CREDENTIAL)
                .build(),
        )
    }

    private fun updatePip() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val b = PictureInPictureParams.Builder()
        pipAspect?.let { b.setAspectRatio(it) }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) b.setAutoEnterEnabled(pipAspect != null).setSeamlessResizeEnabled(true)
        runCatching { setPictureInPictureParams(b.build()) }
    }

    fun enterPip() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val b = PictureInPictureParams.Builder()
        pipAspect?.let { b.setAspectRatio(it) }
        runCatching { enterPictureInPictureMode(b.build()) }
    }

    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        if (Build.VERSION.SDK_INT in Build.VERSION_CODES.O until Build.VERSION_CODES.S && pipAspect != null) enterPip()
    }

    override fun onPictureInPictureModeChanged(isInPictureInPictureMode: Boolean, newConfig: Configuration) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
        inPip = isInPictureInPictureMode
    }
}
