package com.simba.player

import android.app.PendingIntent
import android.app.PictureInPictureParams
import android.app.RemoteAction
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Rect
import android.graphics.drawable.Icon
import android.os.Build
import android.util.Rational
import androidx.annotation.RequiresApi
import com.facebook.react.ReactApplication
import com.facebook.react.bridge.ReactContext

/**
 * Manages Android Picture-in-Picture (PiP) overlay actions and parameters
 * for the `PlayerActivity` in `@simba/react-native-media-player`.
 *
 * v3 redesign (carried over from V11):
 *  - 3 RemoteAction buttons max: [Play/Pause] [Expand] [Close]
 *  - Notification text with chapter title + progress percentage (Android 12+)
 *  - No NEXT/PREV actions (removed for simplicity)
 *
 * V12 Phase 9: relocated from the consumer app to the module so
 * `PlayerActivity` can call `buildPipParams(...)` directly without
 * crossing the Gradle module boundary. The consumer app's
 * `MainActivity` continues to register / unregister [PipActionReceiver]
 * (since `MainActivity` is the activity that owns the foreground
 * during in-app video browsing — PiP can be entered from there too).
 * Both activities share the same `com.simba.player.PipManager` FQN,
 * which Gradle resolves to the module's copy at app build time.
 */
@RequiresApi(Build.VERSION_CODES.N)
object PipManager {

    // ── Action Constants ───────────────────────────────────────────────────

    const val ACTION_PLAY_PAUSE = "com.simba.player.PIP_PLAY_PAUSE"
    const val ACTION_EXPAND = "com.simba.player.PIP_EXPAND"
    const val ACTION_CLOSE = "com.simba.player.PIP_CLOSE"

    private const val REQ_PLAY_PAUSE = 1001
    private const val REQ_EXPAND = 1002
    private const val REQ_CLOSE = 1003

    // ── PiP Params Builder ─────────────────────────────────────────────────

    /**
     * Build PictureInPictureParams with 3 overlay actions:
     * [Pause/Resume] [Expand to Fullscreen] [Close].
     *
     * On Android 12+, also sets notification subtitle with chapter/progress info.
     *
     * @param context            Application or Activity context for PendingIntents.
     * @param aspect             Video aspect ratio as a float (e.g., 16f / 9f for 16:9).
     *                           Clamped to the Android PiP-allowed range [0.42, 2.38]
     *                           before being encoded as an integer Rational.
     * @param sourceRectHint     Optional bounds for smooth PiP entry animation.
     * @param chapterTitle       Current chapter title for notification text (Android 12+).
     * @param progressPercentage Percentage string like "45%" for notification text (Android 12+).
     */
    fun buildPipParams(
        context: Context,
        aspect: Float = 16f / 9f,
        sourceRectHint: Rect? = null,
        chapterTitle: String? = null,
        progressPercentage: String? = null,
    ): PictureInPictureParams {
        val actions = mutableListOf<RemoteAction>()

        // Play/Pause
        actions.add(
            buildRemoteAction(
                context = context,
                iconResId = android.R.drawable.ic_media_play,
                title = "Play/Pause",
                contentDescription = "Toggle playback",
                action = ACTION_PLAY_PAUSE,
                requestCode = REQ_PLAY_PAUSE,
            ),
        )

        // Expand to Fullscreen
        actions.add(
            buildRemoteAction(
                context = context,
                iconResId = android.R.drawable.ic_menu_zoom,
                title = "Expand",
                contentDescription = "Expand to fullscreen",
                action = ACTION_EXPAND,
                requestCode = REQ_EXPAND,
            ),
        )

        // Close
        actions.add(
            buildRemoteAction(
                context = context,
                iconResId = android.R.drawable.ic_menu_close_clear_cancel,
                title = "Close",
                contentDescription = "Close player",
                action = ACTION_CLOSE,
                requestCode = REQ_CLOSE,
            ),
        )

        // Aspect ratio: clamped to PiP-allowed range, then encoded as an
        // integer Rational. Android's `Rational` constructor only accepts
        // ints; multiplying by 100 gives ~1% precision (a 1920x1080
        // source rounded to the nearest 1% of aspect is well below the
        // pixel rounding error of the PiP compositor).
        val clampedAspect = aspect.coerceIn(0.42f, 2.38f)
        val aspectRational: Rational = if (clampedAspect >= 1f) {
            Rational((clampedAspect * 100f).toInt(), 100)
        } else {
            Rational(100, (100f / clampedAspect).toInt().coerceAtLeast(1))
        }

        val builder = PictureInPictureParams.Builder()
            .setAspectRatio(aspectRational)
            .setActions(actions)

        // Source rect hint for smooth entry animation (Android 12+)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && sourceRectHint != null) {
            builder.setSourceRectHint(sourceRectHint)
        }

        // Notification text (Android 12+)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            chapterTitle?.let { builder.setTitle(it) }
            progressPercentage?.let { builder.setSubtitle(it) }
        }

        return builder.build()
    }

    // ── RemoteAction Builder ───────────────────────────────────────────────

    private fun buildRemoteAction(
        context: Context,
        iconResId: Int,
        title: String,
        contentDescription: String,
        action: String,
        requestCode: Int,
    ): RemoteAction {
        val intent = Intent(action).apply {
            setClass(context, PipActionReceiver::class.java)
        }
        val pendingIntent = PendingIntent.getBroadcast(
            context,
            requestCode,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return RemoteAction(
            Icon.createWithResource(context, iconResId),
            title,
            contentDescription,
            pendingIntent,
        )
    }

    // ── Intent Filter ──────────────────────────────────────────────────────

    fun intentFilter(): IntentFilter {
        return IntentFilter().apply {
            addAction(ACTION_PLAY_PAUSE)
            addAction(ACTION_EXPAND)
            addAction(ACTION_CLOSE)
        }
    }
}

// ── BroadcastReceiver for PiP Actions ──────────────────────────────────────

/**
 * Receives PiP RemoteAction broadcasts and forwards them to the React Native
 * event layer via [com.facebook.react.modules.core.DeviceEventManagerModule.RCTDeviceEventEmitter].
 *
 * Registered/unregistered in `MainActivity.onCreate` / `onDestroy` (since
 * `MainActivity` is where the in-app foreground session lives; `PlayerActivity`
 * shares the receiver registration via the merged module manifest).
 *
 * V12: receiver class lives in the module (same FQN `com.simba.player.PipActionReceiver`).
 * The consumer app's `MainActivity` instantiates / registers it without any
 * import changes — Gradle merges the module's class into the app at build time.
 *
 * v3: Handles 3 actions — play/pause, expand (restore fullscreen), close (end session).
 */
class PipActionReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            PipManager.ACTION_PLAY_PAUSE -> {
                emitEvent(context, "onPipPlayPause", null)
            }
            PipManager.ACTION_EXPAND -> {
                emitEvent(context, "onPipExpand", null)
            }
            PipManager.ACTION_CLOSE -> {
                emitEvent(context, "onPipClose", null)
            }
        }
    }

    private fun emitEvent(context: Context, eventName: String, params: android.os.Bundle?) {
        try {
            val reactContext = getReactContext(context)
            reactContext
                .getJSModule(com.facebook.react.modules.core.DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                ?.emit(eventName, params)
        } catch (_: Exception) {
            // React context not available — receiver may be triggered after
            // the JS bundle has unloaded. Silently swallow (no UI to update).
        }
    }

    private fun getReactContext(context: Context): ReactContext {
        val app = context.applicationContext as? ReactApplication
            ?: throw IllegalStateException("Application is not a ReactApplication")
        // Bridgeless RN (0.76+): prefer `reactHost.currentReactContext`.
        // Legacy bridged: fall back to `reactNativeHost.reactInstanceManager.currentReactContext`.
        // We try bridgeless first because the consumer app runs in
        // bridgeless mode (per V12 plan), but the legacy fallback covers
        // any build that hasn't migrated yet.
        val bridgeless = try {
            app.reactHost?.currentReactContext
        } catch (_: Exception) {
            null
        }
        if (bridgeless != null) return bridgeless
        return app.reactNativeHost?.reactInstanceManager?.currentReactContext
            ?: throw IllegalStateException("ReactContext not available")
    }
}