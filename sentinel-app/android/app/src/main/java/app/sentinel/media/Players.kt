@file:androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)

package app.sentinel.media

import android.content.Context
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.VideoSize
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.hls.HlsMediaSource
import androidx.media3.exoplayer.source.ProgressiveMediaSource
import androidx.media3.extractor.DefaultExtractorsFactory
import androidx.media3.extractor.mp4.FragmentedMp4Extractor
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request

data class PlayerUi(
    val loading: Boolean = true,
    val playing: Boolean = false,
    val firstFrame: Boolean = false,
    val error: String? = null,
    val videoAspect: Float = 0f,
    val hasAudio: Boolean = false,
)

private fun renderers(context: Context) = DefaultRenderersFactory(context)
    .setEnableDecoderFallback(true)
    .setExtensionRendererMode(DefaultRenderersFactory.EXTENSION_RENDERER_MODE_OFF)

/** Shared player plumbing: UI state from player events. */
abstract class BasePlayer(context: Context) {
    protected val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    abstract val exo: ExoPlayer
    protected val _ui = MutableStateFlow(PlayerUi())
    val ui: StateFlow<PlayerUi> = _ui.asStateFlow()

    protected val listener = object : Player.Listener {
        override fun onPlaybackStateChanged(state: Int) {
            _ui.value = _ui.value.copy(loading = state == Player.STATE_BUFFERING || state == Player.STATE_IDLE && _ui.value.error == null)
            if (state == Player.STATE_ENDED) onEnded()
        }

        override fun onIsPlayingChanged(isPlaying: Boolean) {
            _ui.value = _ui.value.copy(playing = isPlaying, loading = if (isPlaying) false else _ui.value.loading)
        }

        override fun onRenderedFirstFrame() {
            _ui.value = _ui.value.copy(firstFrame = true, loading = false, error = null)
        }

        override fun onVideoSizeChanged(videoSize: VideoSize) {
            if (videoSize.width > 0 && videoSize.height > 0) {
                val aspect = videoSize.width * videoSize.pixelWidthHeightRatio / videoSize.height
                _ui.value = _ui.value.copy(videoAspect = aspect)
            }
        }

        override fun onTracksChanged(tracks: androidx.media3.common.Tracks) {
            _ui.value = _ui.value.copy(hasAudio = tracks.containsType(C.TRACK_TYPE_AUDIO))
        }

        override fun onPlayerError(error: PlaybackException) {
            _ui.value = _ui.value.copy(error = friendly(error), loading = false)
            onError(error)
        }
    }

    protected open fun onEnded() {}
    protected open fun onError(e: PlaybackException) {}

    var muted: Boolean = true
        set(value) {
            field = value
            exo.volume = if (value) 0f else 1f
        }

    open fun release() {
        scope.cancel()
        exo.removeListener(listener)
        exo.release()
    }

    companion object {
        fun friendly(e: PlaybackException): String = when (e.errorCode) {
            PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED,
            PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT -> "Connection lost"
            PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS -> "Camera isn't streaming"
            PlaybackException.ERROR_CODE_DECODER_INIT_FAILED,
            PlaybackException.ERROR_CODE_DECODING_FORMAT_UNSUPPORTED -> "This phone can't decode the camera's video"
            else -> "Video stopped (${e.errorCodeName.removePrefix("ERROR_CODE_").lowercase().replace('_', ' ')})"
        }
    }
}

/**
 * Live view: go2rtc's fragmented MP4 stream, played with the smallest buffer that stays
 * smooth. If it falls behind (a network hiccup), it speeds up a little until it's live
 * again; if the stream drops, it reconnects by itself.
 */
class LivePlayer(context: Context, private val http: OkHttpClient) : BasePlayer(context) {
    override val exo: ExoPlayer = ExoPlayer.Builder(context, renderers(context))
        .setLoadControl(
            DefaultLoadControl.Builder()
                .setBufferDurationsMs(800, 4000, 100, 300)
                .setPrioritizeTimeOverSizeThresholds(true)
                .build(),
        )
        .build()
        .apply {
            volume = 0f
            playWhenReady = true
            addListener(listener)
        }

    private var url: String? = null
    private var retry = 0
    private var retryJob: Job? = null
    private val catchUp = scope.launch {
        while (isActive) {
            delay(500)
            if (!exo.isPlaying) continue
            val behind = exo.bufferedPosition - exo.currentPosition
            when {
                behind > 6000 -> exo.seekTo(exo.bufferedPosition - 400)
                behind > 1200 -> exo.setPlaybackSpeed(1.12f)
                behind < 500 -> exo.setPlaybackSpeed(1f)
            }
        }
    }

    fun play(url: String) {
        if (this.url == url && exo.playbackState != Player.STATE_IDLE) return
        this.url = url
        retry = 0
        start()
    }

    private fun start() {
        val u = url ?: return
        retryJob?.cancel()
        _ui.value = _ui.value.copy(loading = true, error = null)
        val ds = OkHttpDataSource.Factory(http)
        val extractors = DefaultExtractorsFactory().setFragmentedMp4ExtractorFlags(FragmentedMp4Extractor.FLAG_WORKAROUND_IGNORE_EDIT_LISTS)
        val source = ProgressiveMediaSource.Factory(ds, extractors)
            .setContinueLoadingCheckIntervalBytes(32 * 1024)
            .createMediaSource(MediaItem.fromUri(u))
        exo.setMediaSource(source)
        exo.setPlaybackSpeed(1f)
        exo.prepare()
        exo.playWhenReady = true
    }

    override fun onEnded() = scheduleRetry()
    override fun onError(e: PlaybackException) = scheduleRetry()

    private fun scheduleRetry() {
        retryJob?.cancel()
        retryJob = scope.launch {
            delay(minOf(1000L shl minOf(retry, 4), 10_000L))
            retry++
            start()
        }
    }

    fun stop() {
        retryJob?.cancel()
        exo.stop()
        url = null
    }

    override fun release() {
        catchUp.cancel()
        retryJob?.cancel()
        super.release()
    }
}

/** A fragment of the recordings playlist: player position <-> wall-clock time. */
data class Frag(val pos: Double, val dur: Double, val pdt: Long)

fun parsePlaylist(text: String): List<Frag> {
    val out = ArrayList<Frag>()
    var pos = 0.0
    var pdt = 0L
    var inFile = 0.0
    for (line in text.lineSequence()) {
        if (line.startsWith("#EXT-X-PROGRAM-DATE-TIME:")) {
            pdt = runCatching { java.time.Instant.parse(line.substring(25).trim()).toEpochMilli() }.getOrDefault(0L)
            inFile = 0.0
        } else if (line.startsWith("#EXTINF:")) {
            val dur = line.substring(8).substringBefore(',').toDoubleOrNull() ?: 0.0
            out += Frag(pos, dur, pdt + (inFile * 1000).toLong())
            pos += dur
            inFile += dur
        }
    }
    return out
}

fun posToTime(frags: List<Frag>, pos: Double): Long {
    if (frags.isEmpty()) return 0
    var lo = 0
    var hi = frags.size - 1
    while (lo < hi) {
        val mid = (lo + hi + 1) / 2
        if (frags[mid].pos <= pos) lo = mid else hi = mid - 1
    }
    val f = frags[lo]
    return f.pdt + ((pos - f.pos) * 1000).toLong()
}

/** Position for time t; inside a gap, the start of the next recording. Null past the end. */
fun timeToPos(frags: List<Frag>, t: Long): Double? {
    for (f in frags) {
        if (t < f.pdt) return f.pos
        if (t < f.pdt + (f.dur * 1000).toLong()) return f.pos + (t - f.pdt) / 1000.0
    }
    return null
}

/**
 * Recordings: Sentinel's HLS playlist over a window of footage around the chosen
 * moment. Gaps are skipped; the wall-clock time comes from the playlist.
 */
class RecordingPlayer(context: Context, private val http: OkHttpClient, private val urlFor: (from: Long, to: Long) -> String) : BasePlayer(context) {
    override val exo: ExoPlayer = ExoPlayer.Builder(context, renderers(context))
        .setLoadControl(DefaultLoadControl.Builder().setBufferDurationsMs(4000, 30_000, 400, 1200).build())
        .setSeekBackIncrementMs(10_000)
        .setSeekForwardIncrementMs(10_000)
        .build()
        .apply {
            volume = 0f
            addListener(listener)
        }

    private var frags: List<Frag> = emptyList()
    private var winFrom = 0L
    private var winTo = 0L
    private var loadSeq = 0

    /** Called when playback reaches the newest footage (caller switches to live). */
    var onCaughtUp: () -> Unit = {}
    var nowProvider: () -> Long = { System.currentTimeMillis() }

    val time: Long get() = if (frags.isEmpty()) 0 else posToTime(frags, exo.currentPosition / 1000.0)

    var rate: Float = 1f
        set(value) {
            field = value
            exo.setPlaybackSpeed(value)
        }

    /** Play from time t. Returns false when there's no footage there or later. */
    suspend fun seek(t: Long): Boolean {
        if (frags.isNotEmpty() && t >= winFrom + 60_000 && t < winTo - 60_000) {
            val pos = timeToPos(frags, t)
            val last = frags.last()
            if (pos != null && pos < last.pos + last.dur) {
                exo.seekTo((pos * 1000).toLong())
                exo.playWhenReady = true
                return true
            }
        }
        return load(t)
    }

    private suspend fun load(t: Long): Boolean {
        val seq = ++loadSeq
        _ui.value = _ui.value.copy(loading = true, error = null)
        val now = nowProvider()
        val from = t - 2 * 60_000
        val to = minOf(now + 60_000, t + 60 * 60_000)
        val url = urlFor(from, to)
        val list = withContext(Dispatchers.IO) {
            runCatching {
                http.newCall(Request.Builder().url(url).build()).execute().use { parsePlaylist(it.body?.string() ?: "") }
            }.getOrDefault(emptyList())
        }
        if (seq != loadSeq) return true
        val pos = timeToPos(list, t)
        if (list.isEmpty() || pos == null) {
            _ui.value = _ui.value.copy(loading = false)
            return false
        }
        frags = list
        winFrom = from
        winTo = to
        val source = HlsMediaSource.Factory(OkHttpDataSource.Factory(http))
            .setAllowChunklessPreparation(true)
            .createMediaSource(MediaItem.fromUri(url))
        exo.setMediaSource(source, (pos * 1000).toLong())
        exo.setPlaybackSpeed(rate)
        exo.prepare()
        exo.playWhenReady = true
        return true
    }

    override fun onEnded() {
        val last = frags.lastOrNull() ?: return
        val end = last.pdt + (last.dur * 1000).toLong()
        if (nowProvider() - end < 20_000) onCaughtUp() else scope.launch { if (!load(end + 100)) onCaughtUp() }
    }

    fun togglePlay() {
        exo.playWhenReady = !exo.playWhenReady
    }

    fun stop() {
        loadSeq++
        exo.stop()
        frags = emptyList()
    }
}

/** A plain seekable video (saved clips). */
class ClipPlayer(context: Context, http: OkHttpClient, url: String) : BasePlayer(context) {
    override val exo: ExoPlayer = ExoPlayer.Builder(context, renderers(context))
        .setMediaSourceFactory(androidx.media3.exoplayer.source.DefaultMediaSourceFactory(OkHttpDataSource.Factory(http)))
        .setSeekBackIncrementMs(5_000)
        .setSeekForwardIncrementMs(5_000)
        .build()
        .apply {
            addListener(listener)
            setMediaItem(MediaItem.fromUri(url))
            prepare()
            playWhenReady = true
        }

    init {
        muted = false
    }
}
