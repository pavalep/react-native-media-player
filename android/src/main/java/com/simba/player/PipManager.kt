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
 * ## Who owns the action receiver
 *
 * THIS LIBRARY owns it, end to end: [registerActionReceiver] registers
 * [PipActionReceiver] on the application context, once per process. The
 * consumer app does NOT register it and does not need to know the class
 * exists.
 *
 * That ownership is not a preference — it is what makes the buttons
 * work. See [buildRemoteAction] for the measured reason the broadcast
 * has to be IMPLICIT, and [registerActionReceiver] for why there must be
 * exactly ONE registration (two would deliver every action twice, and a
 * play/pause that toggles twice leaves playback exactly where it was —
 * buttons that look alive and do nothing).
 *
 * V12 Phase 9 relocated this object from the consumer app to the module
 * so the consumer's Activity can call `buildPipParams(...)` without
 * crossing the Gradle module boundary. Both sides share the same
 * `com.simba.player.PipManager` FQN, which Gradle resolves to the
 * module's copy at app build time.
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
        // The params carry the three RemoteActions, and the platform's PiP
        // action row is the ONLY way they can ever be fired. So the
        // receiver that serves them has to exist before these params do.
        //
        // Registering here — at the single place the params are built —
        // makes it impossible to hand the platform a set of buttons that
        // nothing is listening for. That was the measured defect on
        // 2026-11-03: the row rendered three buttons at the right size
        // and none of them did anything.
        registerActionReceiver(context)

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

        // Seamless resize (Android 12+). Without it the PiP window animates
        // between two discrete sizes on rotation / return, which reads as a
        // stutter rather than a resize. This is a rendering-quality flag only:
        // it changes how the transition is drawn, never whether PiP is
        // entered, so it carries no behavioural risk.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            builder.setSeamlessResizeEnabled(true)
        }

        // NO `setAutoEnterEnabled` HERE, and that is deliberate.
        //
        // The platform's auto-enter switch makes the SYSTEM transition the
        // activity into PiP when the user leaves the app, without the app
        // being able to do anything first. That is the wrong order for a
        // consumer that draws its own chrome over the picture.
        //
        // The reason is NOT that the window freezes - an Activity in PiP is
        // "paused, but rendering" (source.android.com/docs/core/display/
        // pip). What stops is REACT: RN pauses the React scheduler when
        // the Activity is paused, so a React commit cannot land and no
        // frame is produced. The switch transitions the Activity before
        // the consumer can unmount its chrome, so the chrome is still
        // mounted when the PiP window is created - and with no frame
        // coming, it stays there: dead and scaled down.
        //
        // Measured on device on 2026-11-03: the consumer's full expanded
        // chrome (header band, scrub row, +-10 buttons, the big pause
        // button) was painted into the PiP window, its buttons were DEAD
        // (tapping pause did not pause) and its clock was FROZEN at
        // 51:09 while the real position was 54:15 - while the consumer's
        // own state already said `pipActive: true` and `isExpanded:
        // false`.
        //
        // So auto-enter on leave is the CONSUMER's to perform, in the only
        // order that works: remove the chrome, let the frame that drew it
        // go by, and only then ask for the window. The library's part is
        // to tell the consumer WHEN the user is leaving - the
        // `onUserLeaveHint` event - and to keep the params it hands the
        // platform free of the platform's own auto-enter switch.
        //
        // The consumer's Activity overrides `onUserLeaveHint()`, which
        // works on every API level, unlike the platform switch (API 31+).

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
        // The intent is IMPLICIT — it carries the action and NOTHING else.
        //
        // It used to name the component explicitly
        // (`setClass(context, PipActionReceiver::class.java)`). THAT was
        // the reason the PiP buttons did NOTHING, measured on
        // emulator-5554 (API 37) on 2026-11-03:
        //
        //   * The platform's PiP action row rendered at the correct size,
        //     right beside the platform's own settings / expand / close
        //     buttons — and all three of THOSE worked.
        //   * Tapping ours produced NO broadcast at all:
        //     `dumpsys activity broadcasts` held no record of the action,
        //     and the platform's own gear button opened the PiP settings
        //     screen in the very same gesture.
        //
        // The cause is how the framework resolves an EXPLICIT broadcast:
        // it looks the component up through the MANIFEST.
        // `PipActionReceiver` is not declared there — it is a runtime
        // registration — so the explicit broadcast resolved to no
        // receiver and was dropped before it was ever dispatched
        // (`dumpsys` showed `dispatchTime=--`, foreground and background
        // alike).
        //
        // The same action sent IMPLICITLY was dispatched in 0 ms, and
        // that is the proof: the receiver was registered and matching the
        // whole time. Only the component was the problem.
        //
        // An implicit intent is matched by ACTION, which is exactly what
        // the runtime registration filters on.
        val intent = Intent(action)
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

    /**
     * The filter the runtime registration matches on.
     *
     * `internal` on purpose: registering the receiver is THIS library's
     * job (see [registerActionReceiver]), and a public helper would
     * only invite a consumer to register a second receiver for the same
     * three actions. Two receivers means every action is delivered
     * twice, and a play/pause that toggles twice leaves playback exactly
     * where it was — a row of buttons that look alive and do nothing.
     */
    internal fun intentFilter(): IntentFilter {
        return IntentFilter().apply {
            addAction(ACTION_PLAY_PAUSE)
            addAction(ACTION_EXPAND)
            addAction(ACTION_CLOSE)
        }
    }

    // ── Receiver registration ─────────────────────────────────────────────

    /**
     * Registers [PipActionReceiver] for the three PiP actions — ONCE per
     * process.
     *
     * The application context is used on purpose: the receiver has to
     * outlive any Activity, because the platform's PiP action row can
     * fire while the consumer's Activity is paused inside PiP, and long
     * after a configuration change has replaced it.
     *
     * The once-per-process guard matters because the React context — and
     * with it this module — can be recreated (a debug reload, a process
     * restart), and registering again would deliver every action twice.
     */
    internal fun registerActionReceiver(context: Context) {
        val appContext = context.applicationContext
        synchronized(registrationLock) {
            if (registered) return
            val receiver = PipActionReceiver()
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                appContext.registerReceiver(receiver, intentFilter(), Context.RECEIVER_EXPORTED)
            } else {
                appContext.registerReceiver(receiver, intentFilter())
            }
            registered = true
        }
    }

    private val registrationLock = Any()

    @Volatile
    private var registered = false
}

// ── BroadcastReceiver for PiP Actions ──────────────────────────────────────

/**
 * Receives PiP RemoteAction broadcasts and forwards them to the React Native
 * event layer via [com.facebook.react.modules.core.DeviceEventManagerModule.RCTDeviceEventEmitter].
 *
 * Registered by THIS library, once per process, on the application context
 * — see [PipManager.registerActionReceiver]. The consumer app does not
 * register it and does not need to know the class exists.
 *
 * It is a RUNTIME registration on purpose: the three action strings are
 * owned by [PipManager] as Kotlin constants, and a manifest declaration
 * would have to repeat them as literals — two owners for one fact. The
 * broadcast those constants feed is implicit, so it matches a runtime
 * registration by action. (An EXPLICIT broadcast would need a manifest
 * declaration instead; see [PipManager.buildRemoteAction] for the
 * measured reason that shape never worked.)
 *
 * v3: Handles 3 actions — play/pause, expand (restore fullscreen), close (end session).
 */
class PipActionReceiver : BroadcastReceiver() {

    private companion object {
        const val TAG = "PipActionReceiver"
    }

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
        } catch (e: Exception) {
            // The React context is not available — the broadcast can arrive
            // after the JS bundle has unloaded, and there is no UI to update
            // in that case.
            //
            // It is still LOGGED, and that is the point. A silent catch
            // here is how the PiP action row could render three buttons
            // that did nothing, with not one line in the log to say so.
            android.util.Log.w(TAG, "cannot emit $eventName: no React context", e)
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