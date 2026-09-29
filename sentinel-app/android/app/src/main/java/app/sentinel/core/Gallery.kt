package app.sentinel.core

import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import androidx.core.content.FileProvider
import java.io.File
import java.io.OutputStream
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request

/** Saving snapshots and clips to the phone's gallery (Pictures/Sentinel, Movies/Sentinel). */
object Gallery {
    private fun insert(context: Context, name: String, mime: String, video: Boolean): Pair<Uri, OutputStream>? {
        val resolver = context.contentResolver
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val values = ContentValues().apply {
                put(MediaStore.MediaColumns.DISPLAY_NAME, name)
                put(MediaStore.MediaColumns.MIME_TYPE, mime)
                put(MediaStore.MediaColumns.RELATIVE_PATH, (if (video) Environment.DIRECTORY_MOVIES else Environment.DIRECTORY_PICTURES) + "/Sentinel")
                put(MediaStore.MediaColumns.IS_PENDING, 1)
            }
            val collection = if (video) MediaStore.Video.Media.EXTERNAL_CONTENT_URI else MediaStore.Images.Media.EXTERNAL_CONTENT_URI
            val uri = resolver.insert(collection, values) ?: return null
            val out = resolver.openOutputStream(uri) ?: return null
            uri to out
        } else {
            @Suppress("DEPRECATION")
            val dir = File(Environment.getExternalStoragePublicDirectory(if (video) Environment.DIRECTORY_MOVIES else Environment.DIRECTORY_PICTURES), "Sentinel").apply { mkdirs() }
            val f = File(dir, name)
            Uri.fromFile(f) to f.outputStream()
        }
    }

    private fun finish(context: Context, uri: Uri) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            context.contentResolver.update(uri, ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }, null, null)
        }
    }

    suspend fun saveBitmap(context: Context, bmp: Bitmap, name: String): Result<Uri> = withContext(Dispatchers.IO) {
        runCatching {
            val (uri, out) = insert(context, "$name.jpg", "image/jpeg", false) ?: error("Couldn't save the picture")
            out.use { bmp.compress(Bitmap.CompressFormat.JPEG, 92, it) }
            finish(context, uri)
            uri
        }
    }

    /** Downloads a video into Movies/Sentinel, reporting progress 0..1. */
    suspend fun saveVideo(context: Context, http: OkHttpClient, url: String, name: String, progress: (Float) -> Unit): Result<Uri> = withContext(Dispatchers.IO) {
        runCatching {
            http.newCall(Request.Builder().url(url).build()).execute().use { resp ->
                if (!resp.isSuccessful) error("Download failed (HTTP ${resp.code})")
                val body = resp.body ?: error("Empty download")
                val total = body.contentLength()
                val (uri, out) = insert(context, "$name.mp4", "video/mp4", true) ?: error("Couldn't save the video")
                out.use { o ->
                    val buf = ByteArray(64 * 1024)
                    var done = 0L
                    body.byteStream().use { input ->
                        while (true) {
                            val n = input.read(buf)
                            if (n < 0) break
                            o.write(buf, 0, n)
                            done += n
                            if (total > 0) progress(done.toFloat() / total)
                        }
                    }
                }
                finish(context, uri)
                uri
            }
        }
    }

    /** Downloads to the app's cache and returns a shareable content URI. */
    suspend fun cacheForShare(context: Context, http: OkHttpClient, url: String, fileName: String, progress: (Float) -> Unit = {}): Result<Uri> = withContext(Dispatchers.IO) {
        runCatching {
            val dir = File(context.cacheDir, "shared").apply { mkdirs() }
            dir.listFiles()?.forEach { if (System.currentTimeMillis() - it.lastModified() > 3_600_000) it.delete() }
            val f = File(dir, fileName)
            http.newCall(Request.Builder().url(url).build()).execute().use { resp ->
                if (!resp.isSuccessful) error("Download failed (HTTP ${resp.code})")
                val body = resp.body ?: error("Empty download")
                val total = body.contentLength()
                f.outputStream().use { o ->
                    val buf = ByteArray(64 * 1024)
                    var done = 0L
                    body.byteStream().use { input ->
                        while (true) {
                            val n = input.read(buf)
                            if (n < 0) break
                            o.write(buf, 0, n)
                            done += n
                            if (total > 0) progress(done.toFloat() / total)
                        }
                    }
                }
            }
            FileProvider.getUriForFile(context, "${context.packageName}.files", f)
        }
    }

    fun shareBitmapFile(context: Context, bmp: Bitmap, name: String): Uri {
        val dir = File(context.cacheDir, "shared").apply { mkdirs() }
        val f = File(dir, "$name.jpg")
        f.outputStream().use { bmp.compress(Bitmap.CompressFormat.JPEG, 92, it) }
        return FileProvider.getUriForFile(context, "${context.packageName}.files", f)
    }

    fun share(context: Context, uri: Uri, mime: String, title: String) {
        val send = Intent(Intent.ACTION_SEND).apply {
            type = mime
            putExtra(Intent.EXTRA_STREAM, uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        context.startActivity(Intent.createChooser(send, title).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    fun safeName(s: String) = s.replace(Regex("[^A-Za-z0-9._ -]"), "_").trim().ifEmpty { "sentinel" }
}
