package app.sentinel

import android.app.Application
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import app.sentinel.core.Api
import app.sentinel.core.AppState
import app.sentinel.core.Engine
import app.sentinel.core.Push
import coil3.ImageLoader
import coil3.PlatformContext
import coil3.SingletonImageLoader
import coil3.disk.DiskCache
import coil3.disk.directory
import coil3.memory.MemoryCache
import coil3.network.okhttp.OkHttpNetworkFetcherFactory
import coil3.request.crossfade

class SentinelApp : Application(), SingletonImageLoader.Factory {
    lateinit var engine: Engine
        private set
    lateinit var state: AppState
        private set

    override fun onCreate() {
        super.onCreate()
        instance = this
        engine = Engine(this)
        state = AppState(this, engine, Api(engine))
        Push.channels(this)
        app.sentinel.core.Updater.channel(this)
        runCatching { Push.init(this, null) }
        // Poll Sentinel only while the app is visible.
        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStart(owner: LifecycleOwner) {
                app.sentinel.core.Updater.onAppOpen(this@SentinelApp)
                engine.onForeground()
                state.startPolling()
            }

            override fun onStop(owner: LifecycleOwner) {
                state.stopPolling()
                engine.onBackground()
            }
        })
    }

    override fun newImageLoader(context: PlatformContext): ImageLoader =
        ImageLoader.Builder(context)
            .components {
                add(OkHttpNetworkFetcherFactory(callFactory = { engine.http }))
                add(StableDiskKeys)
            }
            .memoryCache { MemoryCache.Builder().maxSizePercent(context, 0.25).build() }
            .diskCache { DiskCache.Builder().directory(cacheDir.resolve("images")).maxSizeBytes(256L * 1024 * 1024).build() }
            .crossfade(true)
            .build()

    /**
     * The engine's address (port and secret) changes every launch, so pictures that never
     * change (event pictures, faces, clip thumbnails, preview frames) are kept on the phone
     * under the part from /api/ on; otherwise every restart fetched them all again. Live
     * pictures (latest frame, snapshots) keep their full address: they must be fresh.
     */
    private object StableDiskKeys : coil3.intercept.Interceptor {
        private val stable = listOf("/api/events/", "/api/faces/", "/api/clips/", "/api/preview/")

        override suspend fun intercept(chain: coil3.intercept.Interceptor.Chain): coil3.request.ImageResult {
            val url = chain.request.data as? String ?: return chain.proceed()
            val i = url.indexOf("/api/")
            if (i < 0 || stable.none { url.startsWith(it, i) }) return chain.proceed()
            val key = url.substring(i)
            return chain.withRequest(chain.request.newBuilder().diskCacheKey(key).build()).proceed()
        }
    }

    companion object {
        lateinit var instance: SentinelApp
            private set
    }
}
