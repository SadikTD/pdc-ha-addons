@file:androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)

package app.sentinel.media

import android.content.Context
import androidx.media3.database.StandaloneDatabaseProvider
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.cache.CacheDataSource
import androidx.media3.datasource.cache.CacheKeyFactory
import androidx.media3.datasource.cache.CacheWriter
import androidx.media3.datasource.cache.LeastRecentlyUsedCacheEvictor
import androidx.media3.datasource.cache.SimpleCache
import androidx.media3.datasource.okhttp.OkHttpDataSource
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runInterruptible
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.net.URI

/**
 * Recordings never change once written, so every byte of them fetched once is kept on the
 * phone (least recently used out first) and never fetched again: going back to an event,
 * seeking back or reopening a moment plays at once. On top of that the Camera screen
 * warms what is likely next (the next and previous event), so stepping through events
 * starts at once even on mobile data.
 */
object VodCache {
    private const val MAX_BYTES = 400L * 1024 * 1024

    @Volatile private var cache: SimpleCache? = null

    private fun cache(context: Context): SimpleCache = cache ?: synchronized(this) {
        cache ?: SimpleCache(
            File(context.applicationContext.cacheDir, "recordings"),
            LeastRecentlyUsedCacheEvictor(MAX_BYTES),
            StandaloneDatabaseProvider(context.applicationContext),
        ).also { cache = it }
    }

    // The engine's proxy address (port, secret) changes between launches; the recording
    // itself is named by the part from /api/ on.
    private val keys = CacheKeyFactory { spec -> spec.key ?: spec.uri.toString().let { it.substring(it.indexOf("/api/").coerceAtLeast(0)) } }

    fun factory(context: Context, http: OkHttpClient): CacheDataSource.Factory = CacheDataSource.Factory()
        .setCache(cache(context))
        .setUpstreamDataSourceFactory(OkHttpDataSource.Factory(http))
        .setCacheKeyFactory(keys)
        .setFlags(CacheDataSource.FLAG_IGNORE_CACHE_ON_ERROR)

    /** The window of footage a player loads to play from time t (shared so warm-ups match). */
    fun window(t: Long, now: Long): Pair<Long, Long> = (t - 60_000) to minOf(now + 60_000, t + 30 * 60_000)

    /**
     * Fetch, one after another, what it takes to start playing each of these moments at
     * once: the init section and the first two fragments. Cancel the caller to stop.
     */
    suspend fun warm(context: Context, http: OkHttpClient, now: Long, moments: List<Pair<Long, (Long, Long) -> String>>) {
        val source = factory(context, http).createDataSource()
        for ((t, urlFor) in moments) {
            if (t > now - 20_000) continue
            val (from, to) = window(t, now)
            val url = urlFor(from, to)
            val text = withContext(Dispatchers.IO) {
                runCatching { http.newCall(Request.Builder().url(url).build()).execute().use { if (it.isSuccessful) it.body?.string() else null } }.getOrNull()
            } ?: continue
            for ((uri, pos, len) in refsAt(text, t, 2)) {
                val spec = DataSpec.Builder().setUri(URI(url).resolve(uri).toString()).setPosition(pos).setLength(len).build()
                runCatching { runInterruptible(Dispatchers.IO) { CacheWriter(source, spec, null, null).cache() } }
            }
        }
    }

    /** From a playlist: the init section and the first [count] fragments to play from time t. */
    private fun refsAt(text: String, t: Long, count: Int): List<Triple<String, Long, Long>> {
        var map: Triple<String, Long, Long>? = null
        var pdt = 0L
        var inFile = 0.0
        var dur = 0.0
        var range: Pair<Long, Long>? = null
        val out = mutableListOf<Triple<String, Long, Long>>()
        for (line in text.lineSequence()) {
            when {
                line.startsWith("#EXT-X-MAP:") -> {
                    val uri = Regex("URI=\"([^\"]+)\"").find(line)?.groupValues?.get(1)
                    val br = Regex("BYTERANGE=\"(\\d+)@(\\d+)\"").find(line)
                    map = if (uri != null && br != null) Triple(uri, br.groupValues[2].toLong(), br.groupValues[1].toLong()) else null
                }
                line.startsWith("#EXT-X-PROGRAM-DATE-TIME:") -> {
                    pdt = runCatching { java.time.Instant.parse(line.substring(25)).toEpochMilli() }.getOrDefault(0L)
                    inFile = 0.0
                }
                line.startsWith("#EXTINF:") -> dur = line.substring(8).substringBefore(',').toDoubleOrNull() ?: 0.0
                line.startsWith("#EXT-X-BYTERANGE:") -> {
                    val (n, o) = line.substring(17).split('@').map { it.toLong() }
                    range = o to n
                }
                line.isNotEmpty() && !line.startsWith("#") && range != null -> {
                    val end = pdt + ((inFile + dur) * 1000).toLong()
                    inFile += dur
                    if (out.isNotEmpty() || end > t) {
                        if (out.isEmpty()) map?.let { out += it }
                        out += Triple(line, range!!.first, range!!.second)
                        if (out.size > count) return out
                    }
                    range = null
                }
            }
        }
        return out
    }
}
