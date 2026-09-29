package app.sentinel

import android.app.Application
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import app.sentinel.core.Api
import app.sentinel.core.AppState
import app.sentinel.core.Engine
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
        // Poll Sentinel only while the app is visible.
        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStart(owner: LifecycleOwner) = state.startPolling()
            override fun onStop(owner: LifecycleOwner) = state.stopPolling()
        })
    }

    override fun newImageLoader(context: PlatformContext): ImageLoader =
        ImageLoader.Builder(context)
            .components { add(OkHttpNetworkFetcherFactory(callFactory = { engine.http })) }
            .memoryCache { MemoryCache.Builder().maxSizePercent(context, 0.25).build() }
            .diskCache { DiskCache.Builder().directory(cacheDir.resolve("images")).maxSizeBytes(256L * 1024 * 1024).build() }
            .crossfade(true)
            .build()

    companion object {
        lateinit var instance: SentinelApp
            private set
    }
}
