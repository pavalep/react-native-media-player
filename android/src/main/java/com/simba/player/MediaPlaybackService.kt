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
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import android.util.Log
import androidx.core.app.NotificationCompat
import java.io.File
import java.net.URL

/**
 * V12 Wave 4 Phase 16: foreground service that hosts the persistent
 * media-style notification for `PlayerActivity`.
 *
 * Why a service?
 *  - Android can kill backgrounded activities, but a foreground service
 *    has UI-importance guarantees that keep the audio/video process
 *    alive while playback is in progress.
 *  - The media-style notification is the user-facing surface for
 *    playback controls (play/pause, next, prev) outside the
 *    PiP / lock-screen / Bluetooth paths.
 *
 * Why module-local?
 *  - The V11 `MediaNotificationService` lives in the consumer app for
 *    the inline-mount path. V12's dedicated `PlayerActivity` needs its
 *    own notification host, and the module is the right home for it
 *    (so any consumer app that installs `@simba/react-native-media-player`
 *    gets the notification wiring for free).
 *
 * Session token: the service does NOT own the `MediaSessionCompat` —
 * `PlayerActivity` does (Phase 15). The activity passes the session
 * token in the start intent's `EXTRA_SESSION_TOKEN` extra so the
 * `MediaStyle` notification can wire its controls to the same
 * `MediaSessionCompat.Callback` the activity registered. This keeps
 * the source of truth for playback state in the activity (where the
 * mpv pointer lives) and lets the service focus on the notification.
 *
 * Permissions: the consumer app must declare
 *   <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
 *   <uses-permission android:name="android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK" />
 * in its own manifest (the V11 app already declares the first; the
 * second is API 34+). The library manifest declares the service
 * component itself.
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
        const val ACTION_PLAY_PAUSE = "com.simba.player.MEDIA_PLAYBACK_PLAY_PAUSE"
        const val ACTION_SKIP_NEXT = "com.simba.player.MEDIA_PLAYBACK_SKIP_NEXT"
        const val ACTION_SKIP_PREV = "com.simba.player.MEDIA_PLAYBACK_SKIP_PREV"

        // Intent extras (kept in sync with PlayerActivity's
        // [buildStartIntent] helper).
        const val EXTRA_TITLE = "title"
        const val EXTRA_ARTIST = "artist"
        const val EXTRA_ALBUM = "album"
        const val EXTRA_ARTWORK_PATH = "artworkPath"
        const val EXTRA_POSITION_MS = "positionMs"
        const val EXTRA_DURATION_MS = "durationMs"
        const val EXTRA_IS_PLAYING = "isPlaying"
        const val EXTRA_SESSION_TOKEN = "sessionToken"

        // Notification action indices (compact view ordering)
        private const val INDEX_PLAY = 0
        private const val INDEX_NEXT = 1
        private const val INDEX_PREV = 2

        @Volatile
        private var isRunning = false

        fun isRunning(): Boolean = isRunning

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
         * Build a PendingIntent that opens `PlayerActivity`. Used
         * when the user taps the notification body — returns them
         * to the player if it's still alive, or launches a fresh
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

    // Cached metadata for the latest notification rebuild.
    private var currentTitle: String = "Simba Player"
    private var currentArtist: String = ""
    private var currentAlbum: String = ""
    private var currentArtworkPath: String = ""
    private var currentPosition: Long = 0L
    private var currentDuration: Long = 0L
    private var isCurrentlyPlaying: Boolean = true
    private var sessionToken: MediaSessionCompat.Token? = null

    // ── Lifecycle ──────────────────────────────────────────────────────────

    override fun onCreate() {
        super.onCreate()
        notificationManager = getSystemService(NotificationManager::class.java)
        createNotificationChannel()
        Log.i(TAG, "MediaPlaybackService created")
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_UPDATE -> handleUpdate(intent)
            ACTION_STOP -> {
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
            }
            // Phase 16: notification action handlers. The actual
            // play/pause / skip / stop calls go through the
            // MediaSessionCompat (Phase 15) — PlayerActivity's
            // callback translates them into MPVLib calls. These
            // handlers just optimistically update the cached state
            // so the notification UI feels responsive even before
            // MPVLib confirms.
            ACTION_PLAY_PAUSE -> handlePlayPause()
            ACTION_SKIP_NEXT -> Log.d(TAG, "ACTION_SKIP_NEXT (MediaSession is the source of truth)")
            ACTION_SKIP_PREV -> Log.d(TAG, "ACTION_SKIP_PREV (MediaSession is the source of truth)")
            else -> handleStart(intent)
        }
        return START_REDELIVER_INTENT
    }

    private fun handlePlayPause() {
        // Toggle local state for instant UI feedback; the
        // MediaSessionCompat callback in PlayerActivity (Phase 15)
        // will issue the actual MPVLib play/pause and call
        // updateMediaSessionState, which feeds back into a
        // ACTION_UPDATE intent and syncs us up.
        isCurrentlyPlaying = !isCurrentlyPlaying
        notificationManager.notify(NOTIFICATION_ID, buildNotification())
        Log.d(TAG, "ACTION_PLAY_PAUSE: optimistically toggled to playing=$isCurrentlyPlaying")
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        isRunning = false
        notificationManager.cancel(NOTIFICATION_ID)
        Log.i(TAG, "MediaPlaybackService destroyed")
        super.onDestroy()
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
        sessionToken = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            extras?.getParcelable(EXTRA_SESSION_TOKEN) as? MediaSessionCompat.Token
        } else {
            null
        }
        isRunning = true
        val notification = buildNotification()
        startForeground(NOTIFICATION_ID, notification)
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
        val playbackAction = if (isCurrentlyPlaying) {
            android.R.drawable.ic_media_pause
        } else {
            android.R.drawable.ic_media_play
        }
        val playbackContent = if (isCurrentlyPlaying) "Pause" else "Play"

        val subtitle: String? = when {
            currentArtist.isNotBlank() && currentAlbum.isNotBlank() ->
                "$currentArtist • $currentAlbum"
            currentArtist.isNotBlank() -> currentArtist
            else -> null
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

        // MediaStyle: wire to the session token PlayerActivity
        // passed in via EXTRA_SESSION_TOKEN so the notification's
        // playback state matches the activity's MediaSession
        // (Phase 15). If the token was lost across an activity
        // rebuild, the style still renders (just without the
        // session integration).
        val token = sessionToken
        val mediaStyle = androidx.media.app.NotificationCompat.MediaStyle()
            .setShowActionsInCompactView(INDEX_PLAY, INDEX_NEXT, INDEX_PREV)
            .setShowCancelButton(true)
            .setCancelButtonIntent(buildActionIntent(this, ACTION_STOP))
        if (token != null) {
            mediaStyle.setMediaSession(token)
        }
        builder.setStyle(mediaStyle)

        // Action buttons
        builder.addAction(
            android.R.drawable.ic_media_previous,
            "Previous",
            buildActionIntent(this, ACTION_SKIP_PREV),
        )
        builder.addAction(playbackAction, playbackContent, buildActionIntent(this, ACTION_PLAY_PAUSE))
        builder.addAction(
            android.R.drawable.ic_media_next,
            "Next",
            buildActionIntent(this, ACTION_SKIP_NEXT),
        )
        builder.addAction(
            android.R.drawable.ic_menu_close_clear_cancel,
            "Stop",
            buildActionIntent(this, ACTION_STOP),
        )

        // Progress bar (seekable on Android 12+ when the session
        // exposes SEEK_TO; not used here yet — Phase 20 wires it).
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

    // ── State Builders for Session (used when token is set) ────────────────

    /**
     * Build a [PlaybackStateCompat] from the cached fields. Called
     * when the notification is rebuilt with a session token; the
     * session's own [MediaSessionCompat.Callback] in `PlayerActivity`
     * (Phase 15) handles the actual play/pause/seek calls.
     */
    private fun buildPlaybackStateCompat(): PlaybackStateCompat {
        val state = if (isCurrentlyPlaying) {
            PlaybackStateCompat.STATE_PLAYING
        } else {
            PlaybackStateCompat.STATE_PAUSED
        }
        return PlaybackStateCompat.Builder()
            .setActions(
                PlaybackStateCompat.ACTION_PLAY or
                    PlaybackStateCompat.ACTION_PAUSE or
                    PlaybackStateCompat.ACTION_PLAY_PAUSE or
                    PlaybackStateCompat.ACTION_SKIP_TO_NEXT or
                    PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS or
                    PlaybackStateCompat.ACTION_STOP,
            )
            .setState(state, currentPosition, 1.0f)
            .build()
    }
}
