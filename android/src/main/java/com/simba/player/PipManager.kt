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

/**
 * Manages Android Picture-in-Picture (PiP) overlay actions and parameters
 * for the `PlayerActivity` in `@simba/react-native-media-player`.
 *
 * v3.3.0:
 *  - ONE RemoteAction: [Play/Pause], with a state-driven icon
 *  - Notification text with chapter title + progress percentage (Android 12+)
 *  - No NEXT/PREV actions (removed for simplicity)
 *  - The platform's own auto-enter switch, armed only while media is loaded
 *    (Android 12+)
 *
 * ## Who owns the action receiver
 *
 * THIS LIBRARY owns it, end to end: [registerActionReceiver] registers
 * [PipActionReceiver] on the application context, once per process. The
 * consumer app does NOT register it and does not need to know the class
 * exists.
 *
 * That ownership is not a preference — it is what makes the button
 * work. See [buildRemoteAction] for the measured reason the broadcast
 * has to be IMPLICIT, and [registerActionReceiver] for why there must be
 * exactly ONE registration (two would deliver every action twice, and a
 * play/pause that toggles twice leaves playback exactly where it was —
 * a button that looks alive and does nothing).
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

    /**
     * The ONE action the PiP row carries: play/pause.
     *
     * The expand and close actions this library used to build are GONE:
     * the platform renders its own expand / close / settings affordances
     * in the PiP window, and the library's row was a second copy of them.
     */
    const val ACTION_PLAY_PAUSE = "com.simba.player.PIP_PLAY_PAUSE"

    private const val REQ_PLAY_PAUSE = 1001

    // ── PiP Params Builder ─────────────────────────────────────────────────

    /**
     * Build the PictureInPictureParams the platform builds the PiP window
     * from.
     *
     * ## ONE action, and why
     *
     * The params carry exactly ONE RemoteAction: play/pause.
     *
     * The platform renders its OWN expand / close / settings affordances in
     * the PiP window. The library's own Expand and Close buttons were a
     * SECOND row of the same three controls — the "two rows" symptom — and
     * the platform's own copy is the one that works. Google's own
     * `androidx.core-pip` ships exactly one custom action for the same
     * reason.
     *
     * ## The icon is state-driven
     *
     * The play/pause action shows the PAUSE icon while the video is
     * playing and the PLAY icon while it is paused, and the params are
     * re-committed when the playback state changes so the platform picks
     * the new icon up. A static icon is a lie the user can see.
     *
     * @param context            Application or Activity context for PendingIntents.
     * @param aspect             Video aspect ratio as a float (e.g., 16f / 9f for 16:9).
     *                           Clamped to the Android PiP-allowed range [0.42, 2.38]
     *                           before being encoded as an integer Rational.
     * @param sourceRectHint     The region of the window the VIDEO occupies. The
     *                           platform crops the app's window to this rect, so
     *                           it is what keeps the app's chrome out of the PiP
     *                           window.
     * @param chapterTitle       Current chapter title for notification text (Android 12+).
     * @param progressPercentage Percentage string like "45%" for notification text (Android 12+).
     * @param playing            Whether the video is playing right now — it picks
     *                           the action's icon.
     * @param autoEnter          Whether the platform may enter PiP by itself when
     *                           the user leaves the app (Android 12+). Armed only
     *                           while media is loaded.
     */
    fun buildPipParams(
        context: Context,
        aspect: Float = 16f / 9f,
        sourceRectHint: Rect? = null,
        chapterTitle: String? = null,
        progressPercentage: String? = null,
        playing: Boolean = false,
        autoEnter: Boolean = false,
    ): PictureInPictureParams {
        // The params carry the RemoteAction, and the platform's PiP action
        // row is the ONLY way it can ever be fired. So the receiver that
        // serves it has to exist before these params do.
        //
        // Registering here — at the single place the params are built —
        // makes it impossible to hand the platform a set of buttons that
        // nothing is listening for. That was the measured defect on
        // 2026-11-03: the row rendered three buttons at the right size
        // and none of them did anything.
        registerActionReceiver(context)

        val actions = mutableListOf<RemoteAction>()

        // Play/Pause — the ONE action, with a state-driven icon.
        actions.add(
            buildRemoteAction(
                context = context,
                iconResId = if (playing) {
                    android.R.drawable.ic_media_pause
                } else {
                    android.R.drawable.ic_media_play
                },
                title = if (playing) "Pause" else "Play",
                contentDescription = if (playing) "Pause playback" else "Resume playback",
                action = ACTION_PLAY_PAUSE,
                requestCode = REQ_PLAY_PAUSE,
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

        // Auto-enter (Android 12+).
        //
        // The platform's auto-enter switch makes the SYSTEM transition the
        // activity into PiP when the user leaves the app, and it does that
        // from the LAST COMMITTED params — which is why the library commits
        // them early and keeps them current.
        //
        // It is armed ONLY while media is loaded (`autoEnter`). Arming it
        // with nothing playing would throw the user into a PiP window of a
        // stopped session the moment they browsed the Home screen.
        //
        // While it is armed, ATMS REFUSES an explicit
        // `enterPictureInPictureMode()` — "auto-enter should take in place
        // instead" — so the library's own entry path is a logged no-op on
        // API 31+ and the explicit entry is kept for API 24-30.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && autoEnter) {
            builder.setAutoEnterEnabled(true)
        }

        // Source rect hint (Android 8.0+, API 26)
        //
        // `PictureInPictureParams.Builder.setSourceRectHint(Rect)` was added
        // in API 26, not API 31 - the API 31 call is the TWO-rect overload.
        // react-native-video and expo-video both hand the hint over from
        // API 26, so gating it on API 31 threw away the entry animation on
        // every device below Android 12 for no reason.
        //
        // This is also the rect the platform CROPS the app's window to, so
        // it is what keeps the app's chrome out of the PiP window. That is
        // why the library commits the params early instead of handing them
        // over only at the entry moment.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && sourceRectHint != null) {
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
     * action. Two receivers means every action is delivered twice, and a
     * play/pause that toggles twice leaves playback exactly where it was
     * — a button that looks alive and does nothing.
     *
     * Only the play/pause action is filtered on: it is the ONLY action the
     * params carry (the platform renders its own expand / close), so an
     * expand / close broadcast can no longer arrive.
     */
    internal fun intentFilter(): IntentFilter {
        return IntentFilter().apply {
            addAction(ACTION_PLAY_PAUSE)
        }
    }

    // ── Receiver registration ─────────────────────────────────────────────

    /**
     * Registers [PipActionReceiver] for the PiP action — ONCE per process.
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
 * Receives the PiP RemoteAction broadcast and acts on it NATIVELY.
 *
 * Registered by THIS library, once per process, on the application context
 * — see [PipManager.registerActionReceiver]. The consumer app does not
 * register it and does not need to know the class exists.
 *
 * It is a RUNTIME registration on purpose: the action string is owned by
 * [PipManager] as a Kotlin constant, and a manifest declaration would have
 * to repeat it as a literal — two owners for one fact. The broadcast that
 * constant feeds is implicit, so it matches a runtime registration by
 * action. (An EXPLICIT broadcast would need a manifest declaration instead;
 * see [PipManager.buildRemoteAction] for the measured reason that shape
 * never worked.)
 *
 * ## The action is handled IN THE ENGINE, with no JS round trip
 *
 * The play/pause action used to travel broadcast → JS event → bridge →
 * mpv, and this file's own comment recorded why that shape is fragile: the
 * broadcast can arrive after the JS bundle has unloaded. So the action is
 * delivered to the engine directly, through [PlaybackHost] and
 * [com.simba.player.mpv.MPVLib] — the same way `MediaPlaybackService`'s
 * session callbacks drive playback.
 *
 * The `onPipPlayPause` event still exists in the library's JS API, for
 * consumers that listen to it, but it is NOT the mechanism that pauses
 * playback: the engine call below is, and it happens whether or not there
 * is a JS bundle to receive an event.
 */
class PipActionReceiver : BroadcastReceiver() {

    private companion object {
        const val TAG = "PipActionReceiver"
    }

    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            PipManager.ACTION_PLAY_PAUSE -> togglePlayback()
        }
    }

    /**
     * Toggle playback in the engine.
     *
     * The state is read from mpv at the moment of the tap, so the button
     * toggles what is actually happening rather than what it last
     * believed.
     */
    private fun togglePlayback() {
        val ptr = PlaybackHost.handle()
        if (ptr == 0L) {
            android.util.Log.w(TAG, "cannot toggle playback: no engine handle")
            return
        }
        val state = try {
            com.simba.player.mpv.MPVLib.nativeGetProperty(ptr, "playback-state")
        } catch (t: Throwable) {
            android.util.Log.w(TAG, "cannot read playback-state", t)
            null
        }
        try {
            if (PipNativeEntry.isPlaying(state)) {
                com.simba.player.mpv.MPVLib.nativePause(ptr)
                android.util.Log.i(TAG, "play/pause: paused")
            } else {
                com.simba.player.mpv.MPVLib.nativePlay(ptr)
                android.util.Log.i(TAG, "play/pause: played")
            }
        } catch (t: Throwable) {
            android.util.Log.w(TAG, "cannot toggle playback", t)
            return
        }
        // The action's icon is state-driven, so the committed params have
        // to be re-committed for the platform to pick the new one up.
        com.simba.player.mpv.MpvBridgeModule.onPlaybackStateChanged()
    }
}