package com.simba.player

import android.content.res.Resources
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Handler
import android.os.Looper
import android.util.Log
import java.io.File
import java.net.URL
import java.util.concurrent.Executors
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * The artwork that goes into the media notification.
 *
 * ## Why this class exists
 *
 * The notification was rebuilt once a second, and every rebuild re-fetched
 * the artwork over the network ON THE NOTIFICATION THREAD and then handed
 * the framework a bitmap the framework had already been handed before.
 *
 * That second half is what killed the app. Measured on emulator-5554
 * (API 37) on 2026-11-19, from the tombstone of the crash:
 *
 * ```
 * Abort message: 'fdsan: failed to exchange ownership of file descriptor:
 *   fd 223 is owned by unique_fd 0x79cc1c6e311c, was expected to be unowned'
 *
 *   MediaPlaybackService.buildNotification
 *   MediaPlaybackService.handleStart
 *   Notification$Builder.build
 *   Notification.reduceImageSizes
 *   Icon.scaleDownToAshmem
 *   BitmapCache.getShared
 *   Bitmap.asShared
 *   Bitmap.createAshmemBitmap
 *   ashmem_create_region
 * ```
 *
 * The fd table in that same tombstone holds TWO descriptors on the SAME
 * ashmem region - fd 145 (unowned) and fd 223 (owned by unique_fd) - which
 * is the framework in the middle of making a shared copy of an icon bitmap
 * whose pixels already lived in a shared region.
 *
 * The framework SHARES the icon bitmap it is handed: `Icon.scaleDownToAshmem`
 * turns it into an ashmem-backed bitmap so the system UI can read it. Hand
 * the framework the same instance twice and the second handover operates on
 * a bitmap that is already shared.
 *
 * And the same instance WAS handed twice, back to back, on every start:
 *
 *  - `handleStart` builds the notification twice - once inside
 *    `applyMetadata` and once for `startForeground`;
 *  - when the artwork could not be loaded (the radio rows pass a REMOTE
 *    image URL, and that fetch failed - "Failed to load artwork" appeared
 *    once per second in logcat) BOTH builds fell back to
 *    `BitmapFactory.decodeResource(resources, android.R.drawable.ic_media_play)`,
 *    which is the RESOURCES-CACHED bitmap: one instance, shared with every
 *    other user of that drawable, handed to the framework twice.
 *
 * ## The three rules this class enforces
 *
 *  1. The framework is handed a FRESH bitmap on every notification build.
 *     The bitmap this class owns is never handed over - only copies of it
 *     are.
 *  2. The fallback is OUR copy of the drawable, not the Resources-cached
 *     instance.
 *  3. The artwork is fetched OFF the notification thread, once per artwork
 *     path - not once per notification build.
 */
class NotificationArtwork(private val resources: Resources) {

    companion object {
        private const val TAG = "NotificationArtwork"

        private const val CONNECT_TIMEOUT_MS = 3000
        private const val READ_TIMEOUT_MS = 5000
    }

    /** The path the notification is currently meant to show. */
    private var requestedPath: String = ""

    /**
     * Our own copy of the drawable fallback.
     *
     * `BitmapFactory.decodeResource` hands back the RESOURCES-CACHED
     * bitmap - one instance, shared with every other user of that drawable.
     * Handing that to the framework would let the framework share a bitmap
     * the whole Resources cache still points at.
     */
    private val fallback: Bitmap? =
        privateCopy(BitmapFactory.decodeResource(resources, android.R.drawable.ic_media_play))

    /**
     * The source bitmap.
     *
     * NEVER handed to the framework: only copies of it are. The framework
     * shares the bitmap it is given, so a bitmap that has been handed over
     * once must never be handed over again.
     */
    private var source: Bitmap? = fallback

    /** The loader thread posts its results back to the main looper. */
    private val mainHandler = Handler(Looper.getMainLooper())

    /**
     * The thread the artwork is fetched on.
     *
     * The fetch is network I/O with a 3 s connect and a 5 s read timeout.
     * Doing it on the notification thread meant every notification build
     * could block the main thread for seconds - and it happened once a
     * second.
     */
    private val loader = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "simba-artwork").apply { isDaemon = true }
    }

    /**
     * Tell the artwork what the notification should show.
     *
     * Safe to call as often as the service hears about a path: the fetch
     * only starts when the path actually changed.
     */
    fun request(path: String) {
        val wanted = ArtworkPath.normalize(path)
        if (wanted == requestedPath) return
        requestedPath = wanted

        if (wanted.isEmpty()) {
            source = fallback
            return
        }

        // The previous artwork must not keep showing while the new one
        // loads - and the fallback is safer than the last track's artwork.
        source = fallback

        loader.execute {
            val decoded = decode(wanted)
            mainHandler.post {
                // The path may have changed while the fetch was in flight.
                if (wanted == requestedPath) source = decoded ?: fallback
            }
        }
    }

    /**
     * The bitmap for ONE notification build.
     *
     * Always a fresh instance - see the class docblock. A null means the
     * caller should show no large icon at all.
     */
    fun bitmapForNotification(): Bitmap? = privateCopy(source)

    /**
     * Stop the loader.
     *
     * The bitmaps are NOT recycled: the copies the framework holds are its
     * own, and recycling a bitmap that a pending copy might still be
     * reading is a crash waiting to happen. They are small, and the
     * service dies with the app.
     */
    fun release() {
        loader.shutdownNow()
    }

    /**
     * Fetch and shrink the artwork.
     *
     * Runs on the loader thread, never on the notification thread.
     */
    private fun decode(path: String): Bitmap? {
        return try {
            val decoded = if (ArtworkPath.isRemote(path)) {
                val connection = URL(path).openConnection()
                connection.connectTimeout = CONNECT_TIMEOUT_MS
                connection.readTimeout = READ_TIMEOUT_MS
                connection.getInputStream().use { input ->
                    BitmapFactory.decodeStream(input)
                }
            } else {
                val file = File(path)
                if (file.exists()) BitmapFactory.decodeFile(file.absolutePath) else null
            }
            decoded?.let { shrink(it) }
        } catch (e: Exception) {
            Log.w(TAG, "Failed to load artwork: ${e.message}")
            null
        }
    }

    /**
     * Shrink a decoded bitmap to [ArtworkSizing.MAX_SOURCE_EDGE].
     *
     * The copy the framework receives is a copy of THIS bitmap, so the
     * smaller it is, the cheaper every notification build is.
     */
    private fun shrink(bitmap: Bitmap): Bitmap {
        val (width, height) = ArtworkSizing.shrunkSize(bitmap.width, bitmap.height)
        if (width == bitmap.width && height == bitmap.height) return bitmap
        val scaled = Bitmap.createScaledBitmap(bitmap, width, height, true)
        // The bitmap was ours alone - it was decoded here and nothing else
        // holds it - so it can be released once the smaller copy exists.
        if (scaled !== bitmap) bitmap.recycle()
        return scaled
    }

    /**
     * A bitmap this class owns.
     *
     * `Bitmap.copy` returns a bitmap with its OWN pixels, which is what
     * makes it safe to hand to the framework: the framework's sharing
     * (ashmem) touches the copy, never the source.
     */
    private fun privateCopy(bitmap: Bitmap?): Bitmap? =
        try {
            bitmap?.copy(Bitmap.Config.ARGB_8888, false)
        } catch (e: Exception) {
            Log.w(TAG, "Could not copy a bitmap for the notification: ${e.message}")
            null
        }
}

/**
 * The artwork's path rules - pure, with no Android in them.
 */
object ArtworkPath {

    /** The path as the notification should key it. */
    fun normalize(path: String): String = path.trim()

    /**
     * Whether the path is a REMOTE image the loader has to fetch.
     */
    fun isRemote(path: String): Boolean {
        val normalized = normalize(path)
        return normalized.startsWith("http://") || normalized.startsWith("https://")
    }
}

/**
 * The artwork's sizing arithmetic - pure, with no Android in them.
 */
object ArtworkSizing {

    /**
     * The longest edge the private source keeps.
     *
     * The notification's large icon is rendered at a few hundred pixels at
     * most, so keeping more than this costs memory and makes the
     * per-build copy bigger for no visible gain.
     */
    const val MAX_SOURCE_EDGE = 256

    /**
     * The size a source of [width] x [height] is shrunk to.
     *
     * A source that already fits is left alone.
     */
    fun shrunkSize(width: Int, height: Int, maxEdge: Int = MAX_SOURCE_EDGE): Pair<Int, Int> {
        val longest = max(width, height)
        if (longest <= maxEdge) return width to height
        val scale = maxEdge.toDouble() / longest.toDouble()
        return max(1, (width * scale).roundToInt()) to max(1, (height * scale).roundToInt())
    }
}
