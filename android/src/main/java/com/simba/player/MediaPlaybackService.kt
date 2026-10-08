package com.simba.player

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Build
import android.os.IBinder
import android.support.v4.media.MediaMetadataCompat
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import android.util.Log
import androidx.core.app.NotificationCompat
import com.simba.player.mpv.MPVLib
import java.io.File
import java.net.URL

/**
 * V20 Phase B: the foreground service that owns playback.
 *
 * ## What changed, and why
 *
 * Before V20 this service was a notification *host*: `PlayerActivity`
 * created the [MediaSessionCompat], and the Activity passed its token in
 * the start intent so the notification's `MediaStyle` could point at it.
 * The class docblock stated the design intent explicitly — *"the service
 * does NOT own the `MediaSessionCompat` … This keeps the source of truth
 * for playback state in the activity"*.
 *
 * That is the arrangement Media3's guidance puts the other way round:
 *
 * > "To enable background playback, you should contain the Player and
 * > MediaSession inside a separate Service."
 * > "onCreate() … It's the best place to build Player and MediaSession.
 * > onDestroy() … All resources including player and session need to be
 * > released."
 * > — https://developer.android.com/media/media3/session/background-playback
 *
 * The practical cost of getting it backwards was that the session died
 * with the Activity, so "hide the player" and "shut the player down"
 * were the same verb, and a mini player could not exist. The session now
 * lives here, is released here, and outlives any UI.
 *
 * (The docblock's other claim — that the mpv pointer lives "in the
 * activity" — was wrong even before V20. It lives in C++, process-global
 * as `g_mpv`, and is mirrored by [PlaybackHost].)
 *
 * ## The engine is process-global, so no IPC is needed
 *
 * Media3 separates the session server from its UI with `MediaController`
 * because they may be in different processes. Here they are always in
 * one process, and the engine is a C++ global
 * (`native_state.h:13`) reached through the [MPVLib] singleton. So this
 * service issues transport commands directly via [PlaybackHost.handle()]
 * rather than going through a controller indirection, and same-process
 * callers reach it through [instance]. Media3's own session demo has the
 * same shape: `MainActivity` + `PlayerActivity` + `PlaybackService`, with
 * the service owning the player and session.
 *
 * ## Why the notification has no hand-added buttons
 *
 * V20 Phase B replaced these handlers, which did nothing:
 *
 * ```
 * ACTION_SKIP_NEXT -> Log.d(TAG, "... (MediaSession is the source of truth)")
 * ACTION_SKIP_PREV -> Log.d(TAG, "... (MediaSession is the source of truth)")
 * ```
 *
 * with real commands - but *also* kept our own action buttons on top of a
 * session-backed MediaStyle. Device verification showed both sets rendering at
 * once: two play-looking buttons and no way to tell which one was live. That
 * is the "control that may or may not be the real one" ambiguity the whole
 * change set out to remove, reintroduced by the fix.
 *
 * The buttons are gone. A MediaStyle carrying a session token renders the
 * transport controls from the session advertised actions and routes taps to
 * the session callback, which issues the real command - so the session alone
 * is the single path. ACTION_SEEK_TO is advertised, which is what makes the
 * progress bar seekable rather than decorative.
 */
class MediaPlaybackService : Service() {

    companion object {
        const val TAG = "MediaPlaybackService"
        const val CHANNEL_ID = "simba_player_media_playback"
        const val NOTIFICATION_ID = 1101

        // Intent actions
        const val ACTION_START = "com.simba.player.MEDIA_PLAYBACK_START"
        const val ACTION_UPDATE = "com.simba.player.MEDIA_PLAYBACK_UPDATE"
        const val ACTION_STOP = "com.simba.player.MEDIA_PLAYBACK_STOP"

        // V20 Phase B originally added ACTION_PLAY_PAUSE / ACTION_SKIP_NEXT /
        // ACTION_SKIP_PREV / ACTION_SEEK_TO so the notification's own
        // action buttons had somewhere to land. Those buttons are gone -
        // see buildNotification(). A MediaStyle carrying a session token
        // renders the transport controls from the session's advertised
        // actions and routes taps to the session callback, so these
        // handlers were reachable from nowhere and were deleted rather
        // than left in place as plausible-looking dead code.

        // Intent extras (kept in sync with PlayerActivity's
        // [buildMediaPlaybackServiceIntent] helper).
        const val EXTRA_TITLE = "title"
        const val EXTRA_ARTIST = "artist"
        const val EXTRA_ALBUM = "album"
        const val EXTRA_ARTWORK_PATH = "artworkPath"
        const val EXTRA_POSITION_MS = "positionMs"
        const val EXTRA_DURATION_MS = "durationMs"
        const val EXTRA_IS_PLAYING = "isPlaying"
        /**
         * Retained for wire compatibility with an already-installed
         * 1.x consumer that still puts a token in the start intent. The
         * service ignores it — it owns the session now and publishes its
         * own token to the notification.
         */
        const val EXTRA_SESSION_TOKEN = "sessionToken"

        // Notification action indices (compact view ordering)
        private const val INDEX_PLAY = 0
        private const val INDEX_NEXT = 1
        private const val INDEX_PREV = 2

        @Volatile
        private var isRunning = false

        /**
         * The running instance, for same-process callers.
         *
         * This is a convenience handle, not an ownership mechanism: the
         * session and the notification are created and released by the
         * Service's own lifecycle regardless of who holds a reference.
         * It mirrors the existing `currentActivityIsPlayer` pattern used
         * elsewhere in this library.
         */
        @Volatile
        private var instance: MediaPlaybackService? = null

        fun isRunning(): Boolean = isRunning

        /**
         * Publish a playback state to the session, if the service is up.
         *
         * Callers are UI. If the service is not running there is no
         * session to publish to and no playback to describe, so this is a
         * deliberate no-op rather than a queued write — a UI must never
         * be the thing that resurrects a torn-down session.
         */
        fun publishState(playing: Boolean, state: Int = PlaybackStateCompat.STATE_PLAYING) {
            instance?.publishPlaybackState(playing, state)
        }

        /** Publish metadata to the session and refresh the notification. */
        fun publishMetadata(
            title: String,
            artist: String,
            album: String,
            artworkPath: String,
            mediaUri: String,
            displaySubtitle: String,
        ) {
            instance?.applyMetadata(title, artist, album, artworkPath, mediaUri, displaySubtitle)
        }

        /**
         * Build a [PendingIntent] for a notification action targeting
         * this service. FLAG_IMMUTABLE is mandatory on API 31+ for
         * any PendingIntent not explicitly mutable.
         */
        private fun buildActionIntent(context: Context, action: String): PendingIntent {
            val intent = Intent(context, MediaPlaybackService::class.java).apply {
                this.action = action
            }
            return PendingIntent.getService(
                context,
                action.hashCode(),
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
        }

        /**
         * Build a [PendingIntent] that opens `PlayerActivity`. Used
         * when the user taps the notification body — returns them
         * to the player if its task is still alive, or launches a fresh
         * instance otherwise.
         */
        private fun buildContentIntent(context: Context): PendingIntent {
            val intent = Intent().apply {
                setClassName(context, "com.simba.player.PlayerActivity")
                flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            }
            return PendingIntent.getActivity(
                context,
                0,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
        }
    }

    // ── Instance State ─────────────────────────────────────────────────────

    private lateinit var notificationManager: NotificationManager

    /**
     * V20 Phase B: the session is created here and released in this
     * service's `onDestroy`, not in an Activity's.
     */
    private var mediaSession: MediaSessionCompat? = null

    // Cached metadata for the latest notification rebuild.
    private var currentTitle: String = "Simba Player"
    private var currentArtist: String = ""
    private var currentAlbum: String = ""
    private var currentArtworkPath: String = ""
    private var currentPosition: Long = 0L
    private var currentDuration: Long = 0L
    private var isCurrentlyPlaying: Boolean = true

    // ── Lifecycle ──────────────────────────────────────────────────────────

    override fun onCreate() {
        super.onCreate()
        instance = this
        notificationManager = getSystemService(NotificationManager::class.java)
        createNotificationChannel()
        createMediaSession()
        Log.i(TAG, "MediaPlaybackService created (session owned by service)")
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_UPDATE -> handleUpdate(intent)
            ACTION_STOP -> handleStop()
            else -> handleStart(intent)
        }
        return START_REDELIVER_INTENT
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        // Media3 puts player + session release in the *service's*
        // onDestroy. Doing it in an Activity's is what tied the session's
        // lifetime to a window.
        releaseMediaSession()
        isRunning = false
        instance = null
        notificationManager.cancel(NOTIFICATION_ID)
        Log.i(TAG, "MediaPlaybackService destroyed")
        super.onDestroy()
    }

    // ── Session ownership ──────────────────────────────────────────────────

    /**
     * The full transport set, issued against the process-global engine.
     *
     * Every handler reads the handle at the moment of use via
     * [PlaybackHost] rather than caching it — a cached copy is what let
     * an Activity's controls go silently dead after a destroy/re-create.
     */
    private fun createMediaSession() {
        val callback = object : MediaSessionCompat.Callback() {
            override fun onPlay() = command("onPlay") {
                MPVLib.nativePlay(ptr())
                publishPlaybackState(playing = true)
            }

            override fun onPause() = command("onPause") {
                MPVLib.nativePause(ptr())
                publishPlaybackState(playing = false)
            }

            override fun onStop() = command("onStop") {
                MPVLib.nativeStop(ptr())
                publishPlaybackState(playing = false, state = PlaybackStateCompat.STATE_STOPPED)
            }

            override fun onSkipToNext() = command("onSkipToNext") {
                MPVLib.nativePlaylistNext(ptr())
                publishPlaybackState(playing = true)
            }

            override fun onSkipToPrevious() = command("onSkipToPrevious") {
                MPVLib.nativePlaylistPrev(ptr())
                publishPlaybackState(playing = true)
            }

            override fun onSeekTo(pos: Long) = command("onSeekTo($pos)") {
                if (pos >= 0L) MPVLib.nativeSeek(ptr(), pos.toDouble() / 1000.0)
            }
        }

        val session = MediaSessionCompat(this, TAG).apply {
            setFlags(
                MediaSessionCompat.FLAG_HANDLES_MEDIA_BUTTONS or
                    MediaSessionCompat.FLAG_HANDLES_TRANSPORT_CONTROLS,
            )
            setCallback(callback)
            // Tapping the lock-screen widget should surface the player.
            val activityIntent = Intent().apply {
                setClassName(this@MediaPlaybackService, "com.simba.player.PlayerActivity")
                flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            }
            setSessionActivity(
                PendingIntent.getActivity(
                    this@MediaPlaybackService,
                    0,
                    activityIntent,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                ),
            )
            isActive = true
        }
        mediaSession = session
        publishPlaybackState(playing = true)
        Log.i(TAG, "MediaSession created and owned by the service")
    }

    private fun releaseMediaSession() {
        val session = mediaSession ?: return
        try {
            session.isActive = false
            session.release()
            Log.i(TAG, "MediaSession released")
        } catch (e: Exception) {
            Log.w(TAG, "releaseMediaSession: ${e.message}", e)
        } finally {
            mediaSession = null
        }
    }

    /**
     * Run [block] against the engine, or explain why it could not run.
     *
     * A transport command that silently does nothing is the exact defect
     * this class used to contain, so "no engine" is logged rather than
     * swallowed.
     */
    private inline fun command(label: String, block: () -> Unit) {
        if (ptr() == 0L) {
            Log.w(TAG, "MediaSession.$label ignored: no engine handle")
            return
        }
        try {
            block()
        } catch (e: Exception) {
            Log.w(TAG, "MediaSession.$label threw ${e.message}", e)
        }
    }

    private fun ptr(): Long = PlaybackHost.handle()

    private fun enginePropertyMs(name: String): Long {
        val handle = ptr()
        if (handle == 0L) return 0L
        return try {
            MPVLib.nativeGetProperty(handle, name).trim().toDoubleOrNull()?.times(1000.0)?.toLong() ?: 0L
        } catch (_: Exception) {
            0L
        }
    }

    private fun engineProperty(name: String): String {
        val handle = ptr()
        if (handle == 0L) return ""
        return try {
            MPVLib.nativeGetProperty(handle, name).trim()
        } catch (_: Exception) {
            ""
        }
    }

    /** Push the current transport state into the session. */
    private fun publishPlaybackState(
        playing: Boolean,
        state: Int = if (playing) PlaybackStateCompat.STATE_PLAYING else PlaybackStateCompat.STATE_PAUSED,
    ) {
        val session = mediaSession ?: return
        val positionMs = enginePropertyMs("time-pos")
        val builder = PlaybackStateCompat.Builder()
            .setActions(
                PlaybackStateCompat.ACTION_PLAY or
                    PlaybackStateCompat.ACTION_PAUSE or
                    PlaybackStateCompat.ACTION_PLAY_PAUSE or
                    PlaybackStateCompat.ACTION_STOP or
                    PlaybackStateCompat.ACTION_SKIP_TO_NEXT or
                    PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS or
                    // Advertised, so the notification's progress bar is
                    // genuinely seekable rather than a decoration.
                    PlaybackStateCompat.ACTION_SEEK_TO,
            )
            .setState(state, positionMs, 1.0f)
        session.setPlaybackState(builder.build())

        // Keep the notification's own cache in step so its progress bar
        // and play/pause glyph reflect reality rather than optimism.
        currentPosition = positionMs
        currentDuration = enginePropertyMs("duration")
        isCurrentlyPlaying = playing
    }

    private fun applyMetadata(
        title: String,
        artist: String,
        album: String,
        artworkPath: String,
        mediaUri: String,
        displaySubtitle: String,
    ) {
        if (title.isNotBlank()) currentTitle = title
        currentArtist = artist
        currentAlbum = album
        currentArtworkPath = artworkPath

        val session = mediaSession ?: return
        val durationMs = enginePropertyMs("duration")
        val builder = MediaMetadataCompat.Builder()
            .putString(MediaMetadataCompat.METADATA_KEY_TITLE, currentTitle)
            .putString(MediaMetadataCompat.METADATA_KEY_DISPLAY_TITLE, currentTitle)
        if (currentArtist.isNotBlank()) {
            builder.putString(MediaMetadataCompat.METADATA_KEY_ARTIST, currentArtist)
        }
        if (currentAlbum.isNotBlank()) {
            builder.putString(MediaMetadataCompat.METADATA_KEY_ALBUM, currentAlbum)
        }
        if (displaySubtitle.isNotBlank()) {
            builder.putString(MediaMetadataCompat.METADATA_KEY_DISPLAY_SUBTITLE, displaySubtitle)
        }
        if (mediaUri.isNotBlank()) {
            builder.putString(MediaMetadataCompat.METADATA_KEY_MEDIA_URI, mediaUri)
        }
        if (durationMs > 0L) builder.putLong(MediaMetadataCompat.METADATA_KEY_DURATION, durationMs)
        session.setMetadata(builder.build())
        notificationManager.notify(NOTIFICATION_ID, buildNotification())
    }

    // ── Action Handlers ────────────────────────────────────────────────────

    private fun handleStart(intent: Intent?) {
        val extras = intent?.extras
        currentTitle = extras?.getString(EXTRA_TITLE) ?: "Simba Player"
        currentArtist = extras?.getString(EXTRA_ARTIST) ?: ""
        currentAlbum = extras?.getString(EXTRA_ALBUM) ?: ""
        currentArtworkPath = extras?.getString(EXTRA_ARTWORK_PATH) ?: ""
        currentPosition = extras?.getLong(EXTRA_POSITION_MS, 0L) ?: 0L
        currentDuration = extras?.getLong(EXTRA_DURATION_MS, 0L) ?: 0L
        isCurrentlyPlaying = extras?.getBoolean(EXTRA_IS_PLAYING, true) ?: true
        isRunning = true
        applyMetadata(currentTitle, currentArtist, currentAlbum, currentArtworkPath, "", "")
        startForeground(NOTIFICATION_ID, buildNotification())
        Log.i(
            TAG,
            "Media playback started: title='$currentTitle' artist='$currentArtist' playing=$isCurrentlyPlaying",
        )
    }

    private fun handleUpdate(intent: Intent) {
        val extras = intent.extras ?: return
        extras.getString(EXTRA_TITLE)?.let { currentTitle = it }
        extras.getString(EXTRA_ARTIST)?.let { currentArtist = it }
        extras.getString(EXTRA_ALBUM)?.let { currentAlbum = it }
        extras.getString(EXTRA_ARTWORK_PATH)?.let { currentArtworkPath = it }
        extras.getLong(EXTRA_POSITION_MS, -1L).let { if (it >= 0L) currentPosition = it }
        extras.getLong(EXTRA_DURATION_MS, -1L).let { if (it >= 0L) currentDuration = it }
        extras.getBoolean(EXTRA_IS_PLAYING, isCurrentlyPlaying)?.also { isCurrentlyPlaying = it }
        notificationManager.notify(NOTIFICATION_ID, buildNotification())
        Log.d(TAG, "Media playback updated: position=$currentPosition playing=$isCurrentlyPlaying")
    }

    private fun handleStop() {
        command("notification-stop") {
            if (ptr() != 0L) MPVLib.nativeStop(ptr())
        }
        publishPlaybackState(playing = false, state = PlaybackStateCompat.STATE_STOPPED)
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }
    // ── Notification Channel (Android 8+) ──────────────────────────────────

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Media Playback",
                // Low = no sound on post, shows in shade — required for
                // a media notification to be persistent without
                // interrupting the user.
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = "Persistent playback controls for Simba Player"
                setShowBadge(false)
                lockscreenVisibility = NotificationCompat.VISIBILITY_PUBLIC
            }
            notificationManager.createNotificationChannel(channel)
        }
    }

    // ── Notification Building ──────────────────────────────────────────────

    private fun buildNotification(): Notification {
        // Never null. `setContentText(null)` renders the literal string
        // "null" in the MediaStyle subtitle when artist and album are both
        // blank - which is every untagged file. An untagged item should
        // show nothing, not the word "null".
        val subtitle = when {
            currentArtist.isNotBlank() && currentAlbum.isNotBlank() ->
                "$currentArtist • $currentAlbum"
            currentArtist.isNotBlank() -> currentArtist
            currentAlbum.isNotBlank() -> currentAlbum
            else -> ""
        }

        val artwork: Bitmap? = loadArtworkBitmap(currentArtworkPath) ?: BitmapFactory.decodeResource(
            resources,
            android.R.drawable.ic_media_play,
        )

        val builder = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setLargeIcon(artwork)
            .setContentTitle(currentTitle)
            .setContentText(subtitle)
            .setContentIntent(buildContentIntent(this))
            .setDeleteIntent(buildActionIntent(this, ACTION_STOP))
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(isCurrentlyPlaying)
            .setShowWhen(false)
            .setSilent(true)
            .setOnlyAlertOnce(true)

        // MediaStyle points at *this service's own* session — no token
        // has to be handed in by an Activity any more.
        val session = mediaSession
        val mediaStyle = androidx.media.app.NotificationCompat.MediaStyle()
            .setShowActionsInCompactView(INDEX_PLAY, INDEX_NEXT, INDEX_PREV)
            .setShowCancelButton(true)
            .setCancelButtonIntent(buildActionIntent(this, ACTION_STOP))
        if (session != null) {
            mediaStyle.setMediaSession(session.sessionToken)
        }
        builder.setStyle(mediaStyle)

        // No manual actions are added here, deliberately.
        //
        // Once a MediaStyle carries a session token, the system renders
        // the transport controls from `session.playbackState.actions` and
        // routes taps to the session callback. Adding our own on top
        // produced TWO overlapping control sets on device - two
        // play-looking buttons and an ambiguous tap target - which is
        // exactly the "control that may or may not be the real one"
        // ambiguity this class was rewritten to remove.
        //
        // The session advertises PLAY / PAUSE / PLAY_PAUSE / STOP /
        // SKIP_TO_NEXT / SKIP_TO_PREVIOUS / SEEK_TO, so every control we
        // need is already rendered and already wired to a real command.
        // Stop additionally gets the MediaStyle cancel button below.
        builder.setStyle(mediaStyle)

        // Progress bar. Seekable now, because the session advertises
        // ACTION_SEEK_TO - which is what makes the system render this
        // seekable rather than as decoration.
        if (currentDuration > 0L) {
            builder.setProgress(
                currentDuration.toInt(),
                currentPosition.toInt(),
                false, // determinate
            )
        }

        return builder.build()
    }

    // ── Artwork Loading ────────────────────────────────────────────────────

    private fun loadArtworkBitmap(path: String): Bitmap? {
        if (path.isBlank()) return null
        return try {
            if (path.startsWith("http://") || path.startsWith("https://")) {
                val url = URL(path)
                val connection = url.openConnection()
                connection.connectTimeout = 3000
                connection.readTimeout = 5000
                val inputStream = connection.getInputStream()
                BitmapFactory.decodeStream(inputStream)
            } else {
                val file = File(path)
                if (file.exists()) {
                    BitmapFactory.decodeFile(file.absolutePath)
                } else {
                    null
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "Failed to load artwork: ${e.message}")
            null
        }
    }
}
