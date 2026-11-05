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
 * v3.3.1:
 *  - ONE owner for the playback state: `PlaybackState`, which reads mpv's
 *    REAL properties (`idle-active`, `eof-reached`, `pause`)
 *  - The platform's own auto-enter switch is NOT armed - the app owns the
 *    entry, and the chrome is hidden IN THE ENTRY, before the window is
 *    asked for
 *  - The source-rect hint is a TRANSITION hint, not a crop - the crop
 *    claim is retracted
 *
 * v3.3.0:
 *  - ONE RemoteAction: [Play/Pause], with a state-driven icon
 *  - Notification text with chapter title + progress percentage (Android 12+)
 *  - No NEXT/PREV actions (removed for simplicity)
 *  - The platform's own auto-enter switch, armed only while media is loaded
 *    (Android 12+) - RETRACTED in 3.3.1: the switch is not armed at all
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
     * @param sourceRectHint     The region of the window the VIDEO occupies. It is
     *                           a TRANSITION hint: the platform animates the PiP
     *                           window FROM that region. It does NOT crop the
     *                           app's window — measured on emulator-5554 (API 37)
     *                           on 2026-11-04, with the hint committed the PiP
     *                           window showed the app's FULL chrome, scaled
     *                           down.
     * @param chapterTitle       Current chapter title for notification text (Android 12+).
     * @param progressPercentage Percentage string like "45%" for notification text (Android 12+).
     * @param playing            Whether the video is playing right now — it picks
     *                           the action's icon.
     * @param autoEnter          Whether the Activity may enter PiP by itself when
     *                           the user leaves the app. This is a CONSUMER
     *                           POLICY, checked by the library before it enters -
     *                           it is NOT a platform switch, and the platform's
     *                           own auto-enter switch is never armed.
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

        // Auto-enter (Android 12+). DELIBERATELY NOT ARMED.
        //
        // The platform's auto-enter switch makes the SYSTEM transition the
        // activity into PiP when the user leaves the app. It does that
        // through the Shell transition, and the app's own hooks are never
        // consulted: `Activity.onUserLeaveHint()` did not fire at all on a
        // HOME press (measured on emulator-5554, API 37, 2026-11-04 — zero
        // log lines), and ATMS refuses an explicit entry while the switch
        // is armed ("auto-enter should take in place instead").
        //
        // So with the switch armed the library had NO pre-transition hook
        // at all: the platform froze the window with the consumer's chrome
        // still mounted, and the PiP window showed the whole chrome scaled
        // down.
        //
        // AOSP's own hook for this case is
        // `Activity.onPictureInPictureRequested()` (API 31+): the system
        // asks the app, and the app enters PiP itself. Returning `true`
        // from it also stops the framework from falling back to the legacy
        // `onUserLeaveHint()` path.
        //
        // `autoEnter` therefore stays a CONSUMER POLICY, checked by the
        // library before it enters, and never a platform switch.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && autoEnter) {
            // Intentionally NOT `setAutoEnterEnabled(true)`.
            builder.setAutoEnterEnabled(false)
        }

        // Source rect hint (Android 8.0+, API 26)
        //
        // `PictureInPictureParams.Builder.setSourceRectHint(Rect)` was added
        // in API 26, not API 31 - the API 31 call is the TWO-rect overload.
        // react-native-video and expo-video both hand the hint over from
        // API 26, so gating it on API 31 threw away the entry animation on
        // every device below Android 12 for no reason.
        //
        // This is the rect the PiP window ANIMATES FROM — a transition
        // hint, nothing more. It does not crop the app's window, so it is
        // NOT what keeps the app's chrome out of the PiP window; the
        // consumer's chrome is hidden before the entry, in native code,
        // and that hide is DRAWN before the platform takes the window.
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
        // The state is read through the ONE owner, from mpv's REAL
        // properties (`idle-active`, `eof-reached`, `pause`).
        //
        // It used to read `playback-state` — a property mpv does NOT
        // have. The read failed, the answer was "not playing", and the
        // button called PLAY on an already-playing video: a button that
        // looked alive and did nothing. Measured on emulator-5554
        // (API 37) on 2026-11-04.
        val state = com.simba.player.mpv.PlaybackState.live()
        try {
            if (com.simba.player.mpv.PlaybackState.isPlaying(state)) {
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