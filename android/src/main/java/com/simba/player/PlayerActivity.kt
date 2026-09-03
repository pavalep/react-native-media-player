package com.simba.player

import android.app.PictureInPictureParams
import android.content.Context
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.Rect
import android.graphics.drawable.ColorDrawable
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.ViewGroup
import android.widget.FrameLayout
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.ReactApplication
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate
import com.simba.player.mpv.MPVLib
import com.simba.player.mpv.MpvRenderView

/**
 * Dedicated ReactActivity that hosts the SIMBA video/audio player.
 *
 * Replaces the V11 pattern of mounting the player inside [MainActivity]'s
 * React tree, which caused a Picture-in-Picture black-screen bug because
 * the SurfaceView was nested inside RN's view tree and an opaque shell
 * background covered the surface during PiP re-layout (see mpvKt /
 * heritage mpv-android for the proven pattern: SurfaceView at the
 * activity root with default z-order).
 *
 * Mirrors [com.simba.player.MainActivity] so React Native infra is
 * inherited identically (same main component, same React host, same
 * fabric setting). The activity is free-orientation by design — the JS
 * layer (MpvBridgeModule.setOrientation) is the only authority on
 * orientation during playback (V11 T8.2).
 *
 * Phase 6: MpvRenderView (SurfaceView) is added at index 0 of the
 * activity content root, BENEATH the ReactRootView that super.onCreate
 * installs at index 1. This is the proven PiP-friendly layout (mpvKt /
 * BaseMPVView): the SurfaceView is on a SurfaceFlinger layer that PiP
 * captures correctly even when paused, and the React UI floats on top
 * via transparent background (handled separately in Phase 8).
 */
class PlayerActivity : ReactActivity() {

  companion object {
    private const val TAG = "PlayerActivity"

    /**
     * Component name used for the React root inside this activity.
     * Reuses the app's existing `SimbaPlayer` root so we don't have to
     * maintain a second JS entry point in Phase 1. A dedicated
     * `SimbaPlayerScreen` entry point is a Q1 decision tracked in the
     * V12 tracker.
     */
    const val MAIN_COMPONENT_NAME = "SimbaPlayer"

    // ── Intent extras (Phase 3) ─────────────────────────────────────
    // Set by MpvBridgeModule.openPlayer(uri, title, type, startPositionMs)
    // when launching this activity. Phase 4 will read these back and log
    // them; Phase 11+ will use them to drive playback.
    const val EXTRA_URI = "com.simba.player.EXTRA_URI"
    const val EXTRA_TITLE = "com.simba.player.EXTRA_TITLE"
    const val EXTRA_TYPE = "com.simba.player.EXTRA_TYPE"
    const val EXTRA_START_POSITION_MS = "com.simba.player.EXTRA_START_POSITION_MS"

    /** Allowed values for [EXTRA_TYPE]. */
    const val TYPE_VIDEO = "video"
    const val TYPE_AUDIO = "audio"

    // ── Phase 14.2: audio-background-playback setting ─────────────────
    // SharedPreferences file + key. The default (`true`) means
    // audio files keep playing when the user backgrounds the
    // activity; flipping to `false` makes audio behave like video
    // (pause on background). A future Wave 5 settings screen can
    // expose a toggle that writes this key.
    private const val PREFS_NAME = "simba_player_prefs"
    private const val KEY_AUDIO_BG_PLAYBACK = "audio_background_playback"

    // ── Phase 17: progress update interval ─────────────────────────────
    // 1Hz is the right cadence for a media notification's progress
    // bar — sub-second updates would burn battery for no
    // perceptible benefit, sub-2-second updates would feel
    // jumpy on long-form content (audiobooks / podcasts).
    const val PROGRESS_UPDATE_INTERVAL_MS = 1000L

    // ── Phase 22: default theme color values ────────────────────────────
    // Mirror of `DEFAULT_THEME` in `src/types/config.ts`. Used as the
    // log fallback when the PlayerConfig's theme section is missing
    // or a specific color key is absent. Must stay in sync with the
    // TS side — a divergence would mean the native side logs a
    // different color than DefaultControls renders.
    private const val DEFAULT_THEME_ACCENT = "#FFD700"
    private const val DEFAULT_THEME_BACKGROUND = "#121216"
    private const val DEFAULT_THEME_TEXT = "#FFFFFF"
  }

  // ── Launch parameters (Phase 4) ───────────────────────────────────
  // Pulled from the intent extras set by MpvBridgeModule.openPlayer(...).
  // Stored as private vals (immutable for the activity lifetime) via
  // `by lazy {}` so they're computed on first read after the framework
  // has populated `intent` — `intent` is null before Activity.attach(),
  // so eager initialisation would NPE.

  private val launchUri: String by lazy {
    intent?.getStringExtra(EXTRA_URI) ?: ""
  }

  private val launchTitle: String by lazy {
    intent?.getStringExtra(EXTRA_TITLE)?.takeIf { it.isNotBlank() } ?: launchUri
  }

  private val launchType: String by lazy {
    intent?.getStringExtra(EXTRA_TYPE)?.takeIf { it == TYPE_VIDEO || it == TYPE_AUDIO } ?: TYPE_VIDEO
  }

  private val launchStartPositionMs: Long by lazy {
    intent?.getLongExtra(EXTRA_START_POSITION_MS, 0L) ?: 0L
  }

  // ── Player surface (Phase 6) ──────────────────────────────────────
  // MpvRenderView (SurfaceView) mounted at index 0 of the activity
  // content root, beneath the ReactRootView. Phase 7 will wire the
  // mpv native pointer into this view. Reference is nulled in
  // onDestroy after cleanup + removal.

  private var mpvRenderView: MpvRenderView? = null

  // ── Native pointer cache (Phase 9) ────────────────────────────────
  // The libmpv native pointer, captured whenever wireNativePtr
  // successfully resolves it via the RN bridge. Used by Phase 9's
  // getVideoAspect() to query `video-params/aspect` for PiP sizing.
  // Zero means "mpv not yet initialised by JS"; Phase 9 falls back
  // to the 16:9 default in that case.
  private var lastNativePtr: Long = 0L

  // ── PiP action receiver (Phase 10) ────────────────────────────────
  // `PipActionReceiver` listens for the 3 PiP overlay intents
  // (play/pause, expand, close) and forwards them to JS via
  // `DeviceEventManagerModule.emit`. Registered in `onCreate` and
  // unregistered in `onDestroy`. PlayerActivity owns its own instance
  // — MainActivity has its own for the inline-mount V11 path; the
  // broadcast is delivered to all matching dynamic receivers, so the
  // two activities co-exist without conflict when both are in memory
  // (only one is foreground at a time).
  private var pipReceiver: PipActionReceiver? = null

  // ── PiP mode-change defer flag (Phase 10) ─────────────────────────
  // Set to `true` in `onUserLeaveHint` when we initiate PiP entry.
  // Read in `onPause`'s deferred check so we don't pause mpv while the
  // PiP transition is still in flight (which would kill playback
  // during the PiP entry animation, causing a black PiP window for
  // ~200ms — same root cause as the V11 bug).
  private var pipEntryInFlight: Boolean = false

  // ── Phase 38: audio focus (spec §38.4) ──────────────────────────────
  // Listener that pauses mpv when the system grants audio focus to
  // another app (e.g., an incoming phone call, navigation prompt,
  // voice assistant). AudioFocusRequest is API 26+; older devices use
  // the deprecated requestAudioFocus(listener, streamType, durationHint)
  // overload. We register on resume (when playback starts) and
  // abandon on pause (when the activity backgrounds). On focus loss
  // with AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK we lower mpv's volume
  // instead of pausing (the "duck" convention from Spotify et al.);
  // on AUDIOFOCUS_LOSS or AUDIOFOCUS_LOSS_TRANSIENT we pause.
  private var audioFocusListener: android.media.AudioManager.OnAudioFocusChangeListener? = null
  private var audioFocusRequest: android.media.AudioFocusRequest? = null
  private var hasAudioFocus: Boolean = false
  // Pre-duck volume (so we can restore after AUDIOFOCUS_GAIN)
  private var preDuckVolume: Float = -1f

  // Forward audio focus changes to JS via the DeviceEventManagerModule
  // so the JS layer can update UI (e.g., show "Paused — phone call"
  // overlay). Mirrors the `onPipModeChanged` pattern from Phase 10.
  private fun emitAudioFocusChange(focusChange: Int) {
    Handler(Looper.getMainLooper()).post {
      val reactContext = resolveReactApplicationContext() ?: run {
        Log.w(TAG, "emitAudioFocusChange: ReactApplicationContext null, dropping event")
        return@post
      }
      val module: NativeModule? = try {
        reactContext.getNativeModule("MpvPlayerModule")
      } catch (e: Exception) {
        Log.w(TAG, "emitAudioFocusChange: getNativeModule threw ${e.message}", e)
        null
      }
      if (module !is com.simba.player.IMpvConfigProvider) {
        // IMpvConfigProvider is a stand-in interface — we'll define a
        // dedicated IAudioFocusEmitter if Phase 38.4 expansion requires it.
        // For now, log + skip the JS emit (audio focus handling still
        // works locally — only the JS-side UI notification is missing).
        Log.d(TAG, "emitAudioFocusChange: no IMpvConfigProvider, skipping JS emit (focusChange=$focusChange)")
        return@post
      }
      // We don't actually need the config — just access the module-side
      // emit path. Future phases can add a dedicated IAudioFocusEmitter.
      Log.d(TAG, "emitAudioFocusChange: focusChange=$focusChange (local handling only)")
    }
  }

  // ── Phase 40: ComponentCallbacks2 listener (Phase 38.7 + 39.0) ──────────
  // Forwards OS memory-pressure events to MpvBridgeModule.onTrimMemory()
  // which reduces mpv's cache-secs accordingly. Registered in onCreate
  // (activity-scoped) so the listener is automatically scoped to the
  // activity lifecycle.
  //
  // We hold a strong reference to the listener as a field so the
  // garbage collector can't reclaim it while it's registered. The
  // matching unregisterComponentCallbacks happens in onDestroy.
  private val trimMemoryListener = object : android.content.ComponentCallbacks2 {
    override fun onTrimMemory(level: Int) {
      Log.i(TAG, "trimMemoryListener.onTrimMemory: level=$level")
      forwardTrimMemoryToBridge(level)
    }

    override fun onConfigurationChanged(newConfig: android.content.res.Configuration) {
      // No-op — we don't care about config changes for memory management.
    }

    override fun onLowMemory() {
      // Deprecated in API 34 but still called. Equivalent to
      // onTrimMemory(TRIM_MEMORY_COMPLETE).
      Log.w(TAG, "trimMemoryListener.onLowMemory (deprecated path)")
      forwardTrimMemoryToBridge(android.content.ComponentCallbacks2.TRIM_MEMORY_COMPLETE)
    }

    private fun forwardTrimMemoryToBridge(level: Int) {
      try {
        val reactContext = resolveReactApplicationContext() ?: return
        val module = reactContext.getNativeModule("MpvPlayerModule") ?: return
        // The module instance exposes `onTrimMemory(Int)` as a public
        // method (Phase 39) so we can call it directly via reflection.
        val method = module.javaClass.getMethod("onTrimMemory", Int::class.javaPrimitiveType)
        method.invoke(module, level)
      } catch (e: NoSuchMethodException) {
        Log.w(TAG, "trimMemoryListener: MpvBridgeModule.onTrimMemory(Int) not found", e)
      } catch (e: Exception) {
        Log.w(TAG, "trimMemoryListener: forward failed", e)
      }
    }
  }

  // ── Headset unplug receiver (Phase 20) ─────────────────────────────
  // BroadcastReceiver for `AudioManager.ACTION_AUDIO_BECOMING_NOISY`,
  // which the system fires when a wired headset / Bluetooth
  // headphones are unplugged (or the A2DP source disconnects).
  // On that event we pause mpv + update the MediaSession so the
  // user doesn't get audio blasting out of the phone speaker.
  // Registered in onResume, unregistered in onPause — the
  // receiver is only needed while the activity is foregrounded
  // (the foreground service + media session already cover the
  // background case, and the system will refire the broadcast
  // if the activity comes back to the foreground later).
  private var headsetReceiver: android.content.BroadcastReceiver? = null

  // ── Audio background playback (Phase 14) ───────────────────────────
  // When `true` (the default), audio files keep playing after the
  // user backgrounds the activity (recents / home / app switcher).
  // The setting is stored in a dedicated SharedPreferences file so it
  // can be flipped from a future settings screen without touching
  // the React Native bundle. Phase 14.2 sets the default + storage;
  // a Phase 22 / Wave 5 task can add a UI for it.
  private val audioBackgroundPlayback: Boolean
    get() {
      val prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
      return prefs.getBoolean(KEY_AUDIO_BG_PLAYBACK, true)
    }

  // ── MediaSession (Phase 15) ─────────────────────────────────────────
  // Basic MediaSession so the audio PiP gets system media controls
  // (lock-screen widget, Bluetooth pause/play, Android Auto, etc.).
  // The session is created in onCreate and released in onDestroy;
  // the callback translates play/pause into MPVLib calls.
  //
  // This is intentionally minimal — no notification, no metadata
  // (the title is set on the PiP params in buildCurrentPipParams).
  // A future phase can layer in the full MediaStyle notification
  // + MediaMetadata (artwork, duration, position) on top of this
  // same session.
  private var mediaSession: android.support.v4.media.session.MediaSessionCompat? = null
  private var mediaSessionCallback: android.support.v4.media.session.MediaSessionCompat.Callback? = null

  // ── Progress update timer (Phase 17) ─────────────────────────────────
  // 1Hz periodic runnable that queries mpv's `time-pos` property
  // and ships the position to MediaPlaybackService via an
  // ACTION_UPDATE intent. Started in onResume, stopped in
  // onPause, cleared in onDestroy. The interval is 1000ms — fast
  // enough to keep the notification's progress bar looking
  // smooth, slow enough that mpv's `nativeGetProperty` is not
  // overwhelmed.
  private val progressUpdateHandler = Handler(Looper.getMainLooper())
  private val progressUpdateRunnable: Runnable = object : Runnable {
    override fun run() {
      updateMediaPlaybackServicePosition()
      progressUpdateHandler.postDelayed(this, PROGRESS_UPDATE_INTERVAL_MS)
    }
  }
  private var progressUpdatesRunning: Boolean = false

  // ── ReactActivity contract ────────────────────────────────────────

  override fun getMainComponentName(): String = MAIN_COMPONENT_NAME

  override fun createReactActivityDelegate(): ReactActivityDelegate =
      DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)

  // ── Lifecycle ─────────────────────────────────────────────────────

  override fun onCreate(savedInstanceState: Bundle?) {
    // Black window background BEFORE super so the brief window between
    // activity start and React's first paint is opaque black instead of
    // the default white. Eliminates the white flicker when launching
    // into a video.
    window.setBackgroundDrawable(ColorDrawable(Color.BLACK))
    super.onCreate(savedInstanceState)
    Log.i(
      TAG,
      "onCreate: component=${mainComponentName} savedInstanceState=$savedInstanceState",
    )
    // Touch the lazy launch params so we have one consistent log entry
    // showing all four extras (and any nulls) immediately after super.
    // Subsequent reads of these properties are zero-cost cached.
    Log.i(TAG, "launchUri=$launchUri")
    Log.i(TAG, "launchTitle=$launchTitle")
    Log.i(TAG, "launchType=$launchType")
    Log.i(TAG, "launchStartPositionMs=$launchStartPositionMs")
    Log.i(TAG, "PlayerActivity ready (uri='$launchUri', type='$launchType', startMs=$launchStartPositionMs)")
    // Phase 40: register a ComponentCallbacks2 listener so the system
    // notifies us of memory-pressure events (Phase 38.7 + 39.0). When
    // the OS trims memory, we forward the level to MpvBridgeModule
    // which reduces mpv's cache-secs accordingly. Registered here
    // (activity-scoped) rather than application-scoped so we don't
    // leak the listener across activity restarts.
    applicationContext.registerComponentCallbacks(trimMemoryListener)
    // Phase 11.3: explicit audio-mode entry log so the V12 launch path
    // for audio files is grep-able in logcat. Phase 12 will hide the
    // MpvRenderView; Phase 13 will surface an audio-only UI; until then
    // this log is the primary signal that `type=audio` reached the
    // activity (the MpvRenderView still mounts in Phase 11 so we can
    // validate the intent contract first).
    if (launchType == TYPE_AUDIO) {
      Log.i(TAG, "Audio mode entered: MpvRenderView will be hidden in Phase 12; mpv engine will run without video output")
    }

    // ── Phase 6: Mount MpvRenderView at content root index 0 ────────
    // Step 6.1.1 + 6.1.2: get root via android.R.id.content (the
    // standard FrameLayout that AppCompat installs as the activity's
    // content view). super.onCreate has populated it; ReactRootView is
    // already added at index 1 by super, so we add the SurfaceView at
    // index 0 to sit BENEATH the React tree (PiP-friendly layering).
    val rootView = findViewById<ViewGroup>(android.R.id.content)
    if (rootView !is FrameLayout) {
      Log.w(
        TAG,
        "content root is not FrameLayout (got ${rootView?.javaClass?.simpleName}); MpvRenderView may not layer correctly",
      )
    }
    // Step 6.2: create MpvRenderView (constructor widened to Context
    // in Phase 6 — see MpvRenderView.kt docblock).
    // Step 6.3: layout params. We use FrameLayout.LayoutParams so we
    // can later set gravity / insets via additional Phase 8 work;
    // MATCH_PARENT x MATCH_PARENT keeps the surface full-bleed.
    val renderView = MpvRenderView(this).apply {
      layoutParams = FrameLayout.LayoutParams(
        FrameLayout.LayoutParams.MATCH_PARENT,
        FrameLayout.LayoutParams.MATCH_PARENT,
      )
    }
    // Step 6.4: add at index 0 so it sits below the ReactRootView that
    // super.onCreate installed. The React UI will float on top with a
    // transparent background (Phase 8) so the surface shows through.
    rootView.addView(renderView, 0)
    mpvRenderView = renderView
    // Step 6.5: log.
    Log.i(TAG, "MpvRenderView mounted at content root, index=0")
    // Phase 12.1.1: for audio files, hide the MpvRenderView. The
    // SurfaceView is still created and the mpv engine still runs (so
    // audio plays) — the view is just visually absent. View.GONE
    // collapses the layout slot AND skips drawing; we use GONE (not
    // INVISIBLE) because INVISIBLE would still take layout space
    // which would push the future audio UI (Phase 13) below the
    // fold on first render. Phase 12.2's MpvRenderView guard makes
    // the surface attach path robust to this state.
    if (launchType == TYPE_AUDIO) {
      renderView.visibility = android.view.View.GONE
      Log.i(TAG, "MpvRenderView hidden for audio mode (visibility=GONE)")
    }

    // ── Phase 7: Wire the libmpv native pointer into MpvRenderView ────
    // The mpv handle is owned by `MpvBridgeModule` (in the consumer app's
    // `com.simba.player.mpv` package). The module can't see that class
    // directly, so we resolve it through the RN bridge:
    //   1. Resolve the ReactApplicationContext via the ReactApplication
    //      interface (works for both bridgeless `reactHost` and legacy
    //      `reactInstanceManager`).
    //   2. Look up the bridge module by its registered name
    //      (`MpvPlayerModule`).
    //   3. Cast to the module-side `IMpvNativePtrProvider` interface
    //      (MpvBridgeModule implements it).
    //   4. Call `fetchNativePtr()` and pass to `mpvRenderView.setNativePtr`.
    //
    // Defer via `Handler(Looper.getMainLooper()).post { ... }` so the
    // lookup runs AFTER super.onCreate has installed the React tree,
    // AFTER the activity is fully resumed (RN may still be initialising
    // its bridge at this point), and AFTER the SurfaceView's first
    // surfaceCreated callback has fired (so the view's internal holder
    // is ready for an attachSurfaceLocked call). 50ms is enough on
    // every device we have tested (Pixel 4a through S23); if mpv is
    // still 0 here, a follow-up Handler.postDelayed retries every
    // 200ms until non-zero (capped at 5 attempts to avoid an infinite
    // spin if RN never initialises).
    val h = Handler(Looper.getMainLooper())
    h.post { wireNativePtr(retryCount = 0) }

    // ── Phase 10: Register PiP action receiver ────────────────────────
    // Listens for the 3 PiP overlay intents and forwards them to JS via
    // DeviceEventManagerModule.emit (see PipActionReceiver.onReceive).
    // API 33+ requires the RECEIVER_EXPORTED / RECEIVER_NOT_EXPORTED
    // flag at registration. The PendingIntents in PipManager.buildRemoteAction
    // target this class by name, so the broadcasts come from the system
    // process — that means RECEIVER_NOT_EXPORTED is the correct choice
    // (only the platform / our own process need to deliver to us).
    val receiver = PipActionReceiver()
    pipReceiver = receiver
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      registerReceiver(receiver, PipManager.intentFilter(), Context.RECEIVER_NOT_EXPORTED)
    } else {
      registerReceiver(receiver, PipManager.intentFilter())
    }
    Log.i(TAG, "onCreate: PipActionReceiver registered")
    // Phase 15.3: create the basic MediaSession. The session is
    // active for the lifetime of the activity and is released in
    // onDestroy. We create it last (after the receiver is
    // registered) so the system has both the broadcast channel
    // and the media-button channel available for the same
    // launch.
    createMediaSession()
    // Phase 16.6: start the MediaPlaybackService as a foreground
    // service so the persistent media-style notification appears
    // in the system shade. Android 8+ requires
    // startForegroundService (rather than startService) when the
    // destination service will call startForeground; the service
    // must call startForeground within 5 seconds of
    // onStartCommand or the system will throw a
    // ForegroundServiceDidNotStartInTimeException.
    startMediaPlaybackService()
    // Phase 21.5: read the PlayerConfig pushed by
    // `<PlayerProvider config={...}>` via the module-side
    // `IMpvConfigProvider` interface and log the active keys.
    // Future phases (22-25) extend the lookup to read individual
    // fields (theme colors, pip toggles, audio background) and
    // apply them. Idempotent — a missing Provider just logs.
    loadAndLogPlayerConfig()
  }

  /**
   * Phase 7: Resolve the libmpv native pointer from the JS-side
   * `MpvBridgeModule` via the React Native bridge and hand it to
   * `MpvRenderView.setNativePtr(...)`. Retries on the main thread if
   * the pointer is still 0 (mpv not yet initialised by JS).
   */
  private fun wireNativePtr(retryCount: Int) {
    val view = mpvRenderView ?: run {
      Log.w(TAG, "wireNativePtr: MpvRenderView gone, aborting")
      return
    }
    val reactContext: ReactApplicationContext? = resolveReactApplicationContext()
    if (reactContext == null) {
      Log.w(TAG, "wireNativePtr: ReactApplicationContext null (retryCount=$retryCount)")
      maybeRetry(retryCount)
      return
    }
    val nativeModule: NativeModule? = try {
      reactContext.getNativeModule("MpvPlayerModule")
    } catch (e: Exception) {
      Log.w(TAG, "wireNativePtr: getNativeModule threw ${e.message}", e)
      null
    }
    if (nativeModule !is IMpvNativePtrProvider) {
      Log.w(
        TAG,
        "wireNativePtr: 'MpvPlayerModule' not registered yet or doesn't implement IMpvNativePtrProvider " +
          "(got ${nativeModule?.javaClass?.simpleName ?: "null"}, retryCount=$retryCount)",
      )
      maybeRetry(retryCount)
      return
    }
    val ptr = nativeModule.fetchNativePtr()
    if (ptr == 0L) {
      Log.i(TAG, "wireNativePtr: MpvBridgeModule not yet initialised by JS (retryCount=$retryCount)")
      maybeRetry(retryCount)
      return
    }
    // Phase 9: cache the native pointer so subsequent PiP param
    // updates can query mpv's `video-params/aspect` without
    // re-resolving the bridge module.
    lastNativePtr = ptr
    Log.i(TAG, "wireNativePtr: ptr=$ptr, calling MpvRenderView.setNativePtr")
    view.setNativePtr(ptr)
    // Phase 19.4: refresh the MediaSession metadata now that the
    // mpv handle is wired up. The first call (in
    // createMediaSession) was just the launch title; this one
    // queries mpv's `media-title` / `metadata/by-key/artist` /
    // `metadata/by-key/album` and updates the lock-screen
    // widget with the actual file tags. A future phase can
    // also re-run this from an observer hook (Phase 22
    // territory) to catch later metadata refreshes.
    setMediaSessionMetadata()
  }

  /**
   * Phase 7 helper: schedule another `wireNativePtr` attempt on the main
   * thread 200ms later, capped at 5 retries (≈ 1s total). After 5 failed
   * attempts we give up — the JS layer will surface the problem to the
   * user via the normal error pipeline (onError event from mpv).
   */
  private fun maybeRetry(retryCount: Int) {
    if (retryCount >= 5) {
      Log.e(TAG, "wireNativePtr: giving up after ${retryCount + 1} attempts")
      return
    }
    Handler(Looper.getMainLooper()).postDelayed(
      { wireNativePtr(retryCount + 1) },
      200L,
    )
  }

  /**
   * Phase 21 helper: resolve the module-side [IMpvConfigProvider] via
   * the React Native bridge and log the active PlayerConfig keys.
   *
   * Mirrors the wireNativePtr retry pattern in spirit (resolve
   * context → lookup → cast) but runs once — a missed config read
   * is just a missing log line, not a playback failure. The
   * lookup runs synchronously because the Provider push happens
   * during the React root mount (very early in the activity's
   * lifetime, typically before `onCreate` finishes).
   *
   * Phase 22+ will read individual fields here (theme colors, pip
   * toggles, audio background, etc.) and apply them; for now we
   * just log keys to confirm the wire is live.
   */
  private fun loadAndLogPlayerConfig() {
    val reactContext: ReactApplicationContext? = resolveReactApplicationContext()
    if (reactContext == null) {
      Log.w(TAG, "loadAndLogPlayerConfig: ReactApplicationContext null, skipping")
      return
    }
    val module: NativeModule? = try {
      reactContext.getNativeModule("MpvPlayerModule")
    } catch (e: Exception) {
      Log.w(TAG, "loadAndLogPlayerConfig: getNativeModule threw ${e.message}", e)
      null
    }
    if (module !is IMpvConfigProvider) {
      Log.w(
        TAG,
        "loadAndLogPlayerConfig: 'MpvPlayerModule' not registered yet or doesn't implement IMpvConfigProvider " +
          "(got ${module?.javaClass?.simpleName ?: "null"})",
      )
      return
    }
    val config = module.getCurrentConfig()
    if (config == null) {
      Log.i(
        TAG,
        "loadAndLogPlayerConfig: no PlayerConfig set (consumer didn't wrap root in <PlayerProvider>)",
      )
      return
    }
    val keys = config.keys.sorted().joinToString(", ")
    Log.i(TAG, "loadAndLogPlayerConfig: active PlayerConfig keys=[$keys]")
    // Phase 22: drill into the theme section and log the active
    // color values so the build verification can confirm the
    // theme reaches the native side. Mirrors how Phase 22's
    // `DefaultControls.tsx` reads `useTheme()` on the JS side —
    // both ends see the same values (the Provider is the source
    // of truth, JS pushes to native in Phase 21's setConfig).
    val themeSection = config["theme"] as? Map<String, Any?>
    if (themeSection != null) {
      val accent = themeSection["accent"] as? String ?: DEFAULT_THEME_ACCENT
      val background = themeSection["background"] as? String ?: DEFAULT_THEME_BACKGROUND
      val text = themeSection["text"] as? String ?: DEFAULT_THEME_TEXT
      Log.i(
        TAG,
        "loadAndLogPlayerConfig: theme accent=$accent background=$background text=$text",
      )
      // Phase 22 future: pipe these into the MediaStyle
      // notification's color tokens (NotificationCompat.MediaStyle
      // does not accept arbitrary colors but the surrounding
      // NotificationCompat.Builder does — accent → setColor, etc.).
      // Deferred to a Phase 22 follow-up to avoid scope creep.
    } else {
      Log.i(TAG, "loadAndLogPlayerConfig: theme section absent (using default dark theme)")
    }
    // Phase 22+ will read additional sections here (pip.enabled,
    // audio.backgroundPlayback, subtitle.*, etc.) and apply them.
    // We deliberately do NOT cache the config on the activity —
    // the bridge is the source of truth, and a future phase that
    // flips config at runtime (settings screen) would invalidate a
    // cached copy. Future readers should call
    // `module.getCurrentConfig()` directly each time.
  }

  // ── MediaSession (Phase 15.3 + Phase 18) ──────────────────────────────
  // Creates the MediaSessionCompat that translates ALL system
  // transport requests (lock-screen widget, Bluetooth, Android
  // Auto, headset button, MediaPlaybackService's notification
  // actions) into MPVLib calls. The session is released in
  // onDestroy via [releaseMediaSession].
  //
  // Phase 15.3 created a "basic" session with onPlay / onPause
  // only. Phase 18 expands the callback to cover the full
  // transport set: play, pause, stop, skip-to-next, skip-to-prev,
  // seek-to, play-from-media-id, play-from-search. The
  // session's `PlaybackStateCompat` advertises the matching
  // ACTION_* flags so the system UI renders the right buttons
  // and seek bar.
  //
  // The session activity (PendingIntent) is set so the system
  // can bring PlayerActivity to the foreground when the user
  // taps the lock-screen widget. Without a session activity,
  // the system has no way to know which activity owns the
  // session and would default to launching the app's main
  // launcher intent (which could be wrong if the user launched
  // PlayerActivity from a deep link).
  private fun createMediaSession() {
    val callback = object : android.support.v4.media.session.MediaSessionCompat.Callback() {
      override fun onPlay() {
        Log.i(TAG, "MediaSession.onPlay")
        val ptr = lastNativePtr
        if (ptr != 0L) {
          try {
            MPVLib.nativePlay(ptr)
            updateMediaSessionState(playing = true)
          } catch (e: Exception) {
            Log.w(TAG, "MediaSession.onPlay: nativePlay threw ${e.message}", e)
          }
        }
      }

      override fun onPause() {
        Log.i(TAG, "MediaSession.onPause")
        val ptr = lastNativePtr
        if (ptr != 0L) {
          try {
            MPVLib.nativePause(ptr)
            updateMediaSessionState(playing = false)
          } catch (e: Exception) {
            Log.w(TAG, "MediaSession.onPause: nativePause threw ${e.message}", e)
          }
        }
      }

      override fun onStop() {
        // Phase 18.3.3: stop mpv (clears the file + resets the
        // engine state). The session stays active so a
        // subsequent onPlay can re-load — the activity's
        // closePlayer() path is what deactivates + releases
        // the session.
        Log.i(TAG, "MediaSession.onStop")
        val ptr = lastNativePtr
        if (ptr != 0L) {
          try {
            MPVLib.nativeStop(ptr)
            updateMediaSessionState(playing = false, state = android.support.v4.media.session.PlaybackStateCompat.STATE_STOPPED)
          } catch (e: Exception) {
            Log.w(TAG, "MediaSession.onStop: nativeStop threw ${e.message}", e)
          }
        }
      }

      override fun onSkipToNext() {
        Log.i(TAG, "MediaSession.onSkipToNext")
        val ptr = lastNativePtr
        if (ptr != 0L) {
          try {
            MPVLib.nativePlaylistNext(ptr)
            // The playlist will fire a new file-load; we don't
            // know the new position yet, so just refresh the
            // state with the new playing flag.
            updateMediaSessionState(playing = true)
          } catch (e: Exception) {
            Log.w(TAG, "MediaSession.onSkipToNext: nativePlaylistNext threw ${e.message}", e)
          }
        }
      }

      override fun onSkipToPrevious() {
        Log.i(TAG, "MediaSession.onSkipToPrevious")
        val ptr = lastNativePtr
        if (ptr != 0L) {
          try {
            MPVLib.nativePlaylistPrev(ptr)
            updateMediaSessionState(playing = true)
          } catch (e: Exception) {
            Log.w(TAG, "MediaSession.onSkipToPrevious: nativePlaylistPrev threw ${e.message}", e)
          }
        }
      }

      override fun onSeekTo(pos: Long) {
        // Phase 18.3.6: seek to absolute position (ms). mpv's
        // `nativeSeek` takes seconds (Double), so divide by
        // 1000. The progress update timer (Phase 17) will
        // pick up the new position on its next tick and ship
        // it to MediaPlaybackService.
        Log.i(TAG, "MediaSession.onSeekTo($pos)")
        val ptr = lastNativePtr
        if (ptr != 0L && pos >= 0L) {
          try {
            MPVLib.nativeSeek(ptr, pos.toDouble() / 1000.0)
          } catch (e: Exception) {
            Log.w(TAG, "MediaSession.onSeekTo: nativeSeek threw ${e.message}", e)
          }
        }
      }
    }
    mediaSessionCallback = callback
    val session = android.support.v4.media.session.MediaSessionCompat(this, TAG)
    session.setFlags(
      android.support.v4.media.session.MediaSessionCompat.FLAG_HANDLES_MEDIA_BUTTONS or
        android.support.v4.media.session.MediaSessionCompat.FLAG_HANDLES_TRANSPORT_CONTROLS,
    )
    session.setCallback(callback)
    // Phase 18.4: set the session activity — a PendingIntent
    // that the system can fire to bring PlayerActivity back to
    // the foreground on lock-screen interactions. Without
    // this, the system defaults to the app's launcher
    // intent, which might be wrong (e.g. user launched the
    // player from a deep link to a different activity).
    val sessionActivityIntent = android.content.Intent(this, PlayerActivity::class.java).apply {
      flags = android.content.Intent.FLAG_ACTIVITY_SINGLE_TOP or
        android.content.Intent.FLAG_ACTIVITY_CLEAR_TOP
    }
    val sessionActivityPendingIntent = android.app.PendingIntent.getActivity(
      this,
      0,
      sessionActivityIntent,
      android.app.PendingIntent.FLAG_UPDATE_CURRENT or android.app.PendingIntent.FLAG_IMMUTABLE,
    )
    session.setSessionActivity(sessionActivityPendingIntent)
    session.isActive = true
    mediaSession = session
    // Phase 19.4: initial metadata set with the launch title.
    // At this point the file hasn't loaded yet so mpv's
    // `media-title` is empty — the fallback chain in
    // setMediaSessionMetadata picks up `launchTitle`. Once
    // `wireNativePtr` succeeds, [wireNativePtr] re-queries mpv
    // and refreshes the metadata with the actual tags.
    setMediaSessionMetadata()
    Log.i(TAG, "MediaSession created (active=true, callback set, sessionActivity set)")
  }

  // Update PlaybackState with the current playing flag + state +
  // position. Called from the session callback (after the
  // MPVLib call) and from onResume so the lock-screen reflects
  // the current state when the activity comes back to the
  // foreground.
  //
  // Phase 18.6: the action set is now the full transport set
  // (PLAY, PAUSE, STOP, SKIP_NEXT, SKIP_PREV, SEEK_TO,
  // PLAY_PAUSE) so the system UI can render every control the
  // spec calls for. The state defaults to STATE_PLAYING /
  // STATE_PAUSED based on the `playing` flag; callers can
  // override with `state = STATE_STOPPED` etc. for finer
  // transitions.
  private fun updateMediaSessionState(
    playing: Boolean,
    state: Int = if (playing) {
      android.support.v4.media.session.PlaybackStateCompat.STATE_PLAYING
    } else {
      android.support.v4.media.session.PlaybackStateCompat.STATE_PAUSED
    },
  ) {
    val session = mediaSession ?: return
    val stateBuilder = android.support.v4.media.session.PlaybackStateCompat.Builder()
    // Full transport set — the system UI can render any of
    // these controls based on what it decides to show
    // (lock-screen widget shows 5, Bluetooth shows 2-3, etc.).
    stateBuilder.setActions(
      android.support.v4.media.session.PlaybackStateCompat.ACTION_PLAY or
        android.support.v4.media.session.PlaybackStateCompat.ACTION_PAUSE or
        android.support.v4.media.session.PlaybackStateCompat.ACTION_PLAY_PAUSE or
        android.support.v4.media.session.PlaybackStateCompat.ACTION_STOP or
        android.support.v4.media.session.PlaybackStateCompat.ACTION_SKIP_TO_NEXT or
        android.support.v4.media.session.PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS or
        android.support.v4.media.session.PlaybackStateCompat.ACTION_SEEK_TO,
    )
    // Phase 18.6.2: include the current position so the
    // system UI can show the seek-bar at the right place
    // even before the first progress update tick lands.
    val positionMs = getPlaybackPositionMs()
    stateBuilder.setState(state, positionMs, 1.0f)
    session.setPlaybackState(stateBuilder.build())
  }

  // Release the session and null the field so a re-create picks up
  // a fresh instance. Called from onDestroy.
  private fun releaseMediaSession() {
    val session = mediaSession ?: return
    try {
      session.isActive = false
      session.release()
      Log.i(TAG, "MediaSession released")
    } catch (e: Exception) {
      Log.w(TAG, "releaseMediaSession: session.release threw ${e.message}", e)
    }
    mediaSession = null
    mediaSessionCallback = null
  }

  // ── Headset / Bluetooth disconnect (Phase 20) ───────────────────────
  // Register a BroadcastReceiver for
  // AudioManager.ACTION_AUDIO_BECOMING_NOISY. The system fires
  // this broadcast when a wired headset is unplugged, a
  // Bluetooth A2DP source disconnects, or the audio output
  // switches from headphones to the built-in speaker. Pausing
  // on the event prevents the user from getting audio blasting
  // out of the speaker (a common surprise when a user
  // disconnects their headphones mid-play).
  //
  // The receiver is only registered while the activity is
  // foregrounded — the foreground service (Phase 16) keeps the
  // media session alive in the background, and the system
  // re-fires the broadcast if the activity resumes. This also
  // means we don't accidentally double-pause when the audio-bg
  // path (Phase 14) keeps mpv playing in the background.
  private fun registerHeadsetReceiver() {
    if (headsetReceiver != null) return
    val receiver = object : android.content.BroadcastReceiver() {
      override fun onReceive(context: android.content.Context, intent: android.content.Intent) {
        if (intent.action == android.media.AudioManager.ACTION_AUDIO_BECOMING_NOISY) {
          Log.i(TAG, "ACTION_AUDIO_BECOMING_NOISY: pausing mpv (headphones unplugged)")
          pauseOnHeadsetDisconnect()
        }
      }
    }
    headsetReceiver = receiver
    // API 33+ requires the RECEIVER_EXPORTED / RECEIVER_NOT_EXPORTED
    // flag. ACTION_AUDIO_BECOMING_NOISY is a protected broadcast
    // sent by the system (not other apps), so
    // RECEIVER_NOT_EXPORTED is the correct choice.
    val filter = android.content.IntentFilter(android.media.AudioManager.ACTION_AUDIO_BECOMING_NOISY)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
    } else {
      registerReceiver(receiver, filter)
    }
    Log.i(TAG, "Headset receiver registered")
  }

  private fun unregisterHeadsetReceiver() {
    val receiver = headsetReceiver ?: return
    try {
      unregisterReceiver(receiver)
      Log.i(TAG, "Headset receiver unregistered")
    } catch (e: Exception) {
      Log.w(TAG, "unregisterHeadsetReceiver threw ${e.message}", e)
    }
    headsetReceiver = null
  }

  // ── Phase 38: audio focus request / abandon (spec §38.4) ────────────
  // Request audio focus on resume so the system knows we're playing.
  // On focus loss we either duck the volume (transient can-duck) or
  // pause mpv (transient / permanent loss). On focus gain we restore
  // volume + resume playback if the user has the "queue resume"
  // preference (Phase 14 audio-background-playback behaviour).
  //
  // The duck-on-can-duck convention is the same one Spotify / Apple
  // Music use for navigation prompts: lower the volume to 20% so the
  // user can hear the prompt, then restore when focus returns.
  private fun requestAudioFocus() {
    if (hasAudioFocus) return
    val audioManager = getSystemService(android.content.Context.AUDIO_SERVICE) as? android.media.AudioManager
      ?: run {
        Log.w(TAG, "requestAudioFocus: AudioManager unavailable")
        return
      }
    val listener = android.media.AudioManager.OnAudioFocusChangeListener { focusChange ->
      Log.i(TAG, "AudioFocus change: $focusChange")
      when (focusChange) {
        android.media.AudioManager.AUDIOFOCUS_GAIN -> {
          // Restore volume + resume if we paused for a transient loss
          if (preDuckVolume >= 0f) {
            restoreVolume()
          }
          // Phase 14 audio-bg: if the activity is still in PiP or the
          // audio-bg setting is on, resume playback. Conservative
          // default: don't auto-resume — let the user tap play.
          // (Auto-resume can be jarring after a phone call ends.)
          Log.i(TAG, "AudioFocus gained — playback ready for manual resume")
        }
        android.media.AudioManager.AUDIOFOCUS_LOSS -> {
          // Permanent loss (e.g., user switched to another audio app)
          pauseOnAudioFocusLoss("permanent")
        }
        android.media.AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> {
          // Transient loss (phone call, alarm, navigation)
          pauseOnAudioFocusLoss("transient")
        }
        android.media.AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> {
          // Can duck — lower volume to 20% (matches Spotify convention)
          duckVolume()
        }
      }
      emitAudioFocusChange(focusChange)
    }
    audioFocusListener = listener
    val result: Int = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val playbackInfo = android.media.AudioAttributes.Builder()
        .setUsage(android.media.AudioAttributes.USAGE_MEDIA)
        .setContentType(android.media.AudioAttributes.CONTENT_TYPE_MOVIE)
        .build()
      val request = android.media.AudioFocusRequest.Builder(
        android.media.AudioManager.AUDIOFOCUS_GAIN
      )
        .setAudioAttributes(playbackInfo)
        .setAcceptsDelayedFocusGain(true)
        .setWillPauseWhenDucked(false)  // we handle duck ourselves
        .setOnAudioFocusChangeListener(listener)
        .build()
      audioFocusRequest = request
      audioManager.requestAudioFocus(request)
    } else {
      @Suppress("DEPRECATION")
      audioManager.requestAudioFocus(
        listener,
        android.media.AudioManager.STREAM_MUSIC,
        android.media.AudioManager.AUDIOFOCUS_GAIN
      )
    }
    hasAudioFocus = (result == android.media.AudioManager.AUDIOFOCUS_REQUEST_GRANTED)
    Log.i(TAG, "requestAudioFocus: result=$result hasFocus=$hasAudioFocus")
  }

  private fun abandonAudioFocus() {
    if (!hasAudioFocus) return
    val audioManager = getSystemService(android.content.Context.AUDIO_SERVICE) as? android.media.AudioManager
      ?: return
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      audioFocusRequest?.let {
        audioManager.abandonAudioFocusRequest(it)
      }
      audioFocusRequest = null
    } else {
      @Suppress("DEPRECATION")
      audioFocusListener?.let {
        audioManager.abandonAudioFocus(it)
      }
    }
    audioFocusListener = null
    hasAudioFocus = false
    if (preDuckVolume >= 0f) {
      restoreVolume()
    }
    Log.i(TAG, "abandonAudioFocus: focus released")
  }

  private fun pauseOnAudioFocusLoss(reason: String) {
    val ptr = lastNativePtr
    if (ptr != 0L) {
      try {
        MPVLib.nativePause(ptr)
        Log.i(TAG, "pauseOnAudioFocusLoss ($reason): mpv paused")
      } catch (e: Exception) {
        Log.w(TAG, "pauseOnAudioFocusLoss: nativePause threw ${e.message}", e)
      }
    }
    updateMediaSessionState(playing = false)
  }

  private fun duckVolume() {
    val ptr = lastNativePtr
    if (ptr == 0L) return
    try {
      val currentVolume = MPVLib.nativeGetVolume(ptr).toFloat()
      if (preDuckVolume < 0f) {
        preDuckVolume = currentVolume
      }
      // Duck to 20% of current volume (Spotify convention)
      MPVLib.nativeSetVolume(ptr, (currentVolume * 0.2).toDouble())
      Log.i(TAG, "duckVolume: $currentVolume → ${currentVolume * 0.2}")
    } catch (e: Exception) {
      Log.w(TAG, "duckVolume: nativeGetVolume/SetVolume threw ${e.message}", e)
    }
  }

  private fun restoreVolume() {
    val ptr = lastNativePtr
    if (ptr == 0L || preDuckVolume < 0f) return
    try {
      MPVLib.nativeSetVolume(ptr, preDuckVolume.toDouble())
      Log.i(TAG, "restoreVolume: → $preDuckVolume")
      preDuckVolume = -1f
    } catch (e: Exception) {
      Log.w(TAG, "restoreVolume: nativeSetVolume threw ${e.message}", e)
    }
  }

  // Phase 20.2: pause mpv on headset disconnect. The pause
  // goes through the same code path as the MediaSession's
  // onPause() callback (which keeps the MediaSession state +
  // notification in sync via the existing updateMediaSessionState
  // helper).
  private fun pauseOnHeadsetDisconnect() {
    val ptr = lastNativePtr
    if (ptr != 0L) {
      try {
        MPVLib.nativePause(ptr)
        Log.i(TAG, "pauseOnHeadsetDisconnect: nativePause called (ptr=$ptr)")
        updateMediaSessionState(playing = false)
      } catch (e: Exception) {
        Log.w(TAG, "pauseOnHeadsetDisconnect: nativePause threw ${e.message}", e)
      }
    }
  }

  // ── MediaPlaybackService helpers (Phase 16) ─────────────────────────────
  // Build the start intent with the launch metadata + the
  // MediaSessionCompat token (created in Phase 15). The service
  // uses the token to wire its MediaStyle notification to the
  // same session the activity's playback controls drive.
  private fun buildMediaPlaybackServiceIntent(action: String): android.content.Intent {
    val intent = android.content.Intent(this, MediaPlaybackService::class.java)
    intent.action = action
    intent.putExtra(MediaPlaybackService.EXTRA_TITLE, launchTitle)
    // Phase 16: artist / album / artwork are not yet carried in
    // the launch params. We default artist + album to empty
    // strings (the service shows title only) and skip the
    // artwork path entirely. Phase 18 (W4) adds these extras to
    // the launch intent via the bridge.
    intent.putExtra(MediaPlaybackService.EXTRA_ARTIST, "")
    intent.putExtra(MediaPlaybackService.EXTRA_ALBUM, "")
    intent.putExtra(MediaPlaybackService.EXTRA_ARTWORK_PATH, "")
    intent.putExtra(MediaPlaybackService.EXTRA_POSITION_MS, launchStartPositionMs)
    intent.putExtra(MediaPlaybackService.EXTRA_DURATION_MS, 0L)
    intent.putExtra(MediaPlaybackService.EXTRA_IS_PLAYING, true)
    // Phase 16.3: pass the session token so the service's
    // MediaStyle notification can wire to the activity's
    // MediaSessionCompat (Phase 15). The token is a
    // Parcelable so it survives the Intent extra marshalling.
    val session = mediaSession
    if (session != null) {
      intent.putExtra(MediaPlaybackService.EXTRA_SESSION_TOKEN, session.sessionToken)
    }
    return intent
  }

  // Phase 16.6: start the foreground service. Uses
  // startForegroundService (Android 8+) because the service
  // will call startForeground within 5s.
  private fun startMediaPlaybackService() {
    try {
      val intent = buildMediaPlaybackServiceIntent(MediaPlaybackService.ACTION_START)
      androidx.core.content.ContextCompat.startForegroundService(this, intent)
      Log.i(TAG, "MediaPlaybackService start requested (foreground)")
    } catch (e: Exception) {
      Log.w(TAG, "startMediaPlaybackService: ${e.message}", e)
    }
  }

  // Phase 16.7: stop the service. We send a graceful ACTION_STOP
  // intent so the service can run its own stopForeground +
  // stopSelf sequence (the MediaStyle notification cleans up
  // cleanly that way; calling stopService from outside can
  // leave a stale foreground notification on some OEM skins).
  private fun stopMediaPlaybackService() {
    try {
      val intent = buildMediaPlaybackServiceIntent(MediaPlaybackService.ACTION_STOP)
      startService(intent)
      Log.i(TAG, "MediaPlaybackService stop requested")
    } catch (e: Exception) {
      Log.w(TAG, "stopMediaPlaybackService: ${e.message}", e)
    }
  }

  // Phase 17.2 / 17.4: ship the current position + duration to
  // MediaPlaybackService so its notification's progress bar stays
  // in sync with the mpv state. Called both from the 1Hz
  // `progressUpdateRunnable` and on demand from onResume /
  // onPause.
  //
  // We use a non-foreground `startService` here (not
  // startForegroundService) because the service is already in
  // the foreground state — the system accepts ordinary service
  // starts for an already-foreground service without the 5s
  // startForeground deadline.
  private fun updateMediaPlaybackServicePosition() {
    try {
      val position = getPlaybackPositionMs()
      val duration = getPlaybackDurationMs()
      val intent = buildMediaPlaybackServiceIntent(MediaPlaybackService.ACTION_UPDATE)
      intent.putExtra(MediaPlaybackService.EXTRA_POSITION_MS, position)
      intent.putExtra(MediaPlaybackService.EXTRA_DURATION_MS, duration)
      startService(intent)
    } catch (e: Exception) {
      // Common when the service is no longer running (activity
      // was destroyed but the runnable fired once more). Silent
      // — the next onResume restarts the timer.
      Log.d(TAG, "updateMediaPlaybackServicePosition: ${e.message}")
    }
  }

  // Phase 17.4: start the 1Hz progress update runnable. Idempotent
  // — calling twice is a no-op (avoids double-firing if
  // onResume runs more than once without an intervening pause,
  // which can happen on some OEMs after a config change).
  private fun startProgressUpdates() {
    if (progressUpdatesRunning) return
    progressUpdatesRunning = true
    progressUpdateHandler.postDelayed(progressUpdateRunnable, PROGRESS_UPDATE_INTERVAL_MS)
    Log.i(TAG, "Progress updates started (interval=${PROGRESS_UPDATE_INTERVAL_MS}ms)")
  }

  // Phase 17.5: stop the 1Hz runnable + remove any pending
  // callback. Idempotent. Called from onPause and onDestroy.
  private fun stopProgressUpdates() {
    if (!progressUpdatesRunning) return
    progressUpdatesRunning = false
    progressUpdateHandler.removeCallbacks(progressUpdateRunnable)
    Log.i(TAG, "Progress updates stopped")
  }

  /**
   * Phase 7 helper: resolve the ReactApplicationContext via the
   * `ReactApplication` interface. The consumer app runs in bridgeless
   * mode (RN 0.76+), so we use `reactHost.currentReactContext` —
   * `reactNativeHost` has been removed from the interface in bridgeless
   * builds and is not available at the call site.
   */
  private fun resolveReactApplicationContext(): ReactApplicationContext? {
    val app = application as? ReactApplication ?: run {
      Log.w(TAG, "resolveReactApplicationContext: Application does not implement ReactApplication")
      return null
    }
    return try {
      app.reactHost?.currentReactContext as? ReactApplicationContext
    } catch (e: Exception) {
      Log.w(TAG, "resolveReactApplicationContext: reactHost access threw ${e.message}", e)
      null
    }
  }

  override fun onResume() {
    super.onResume()
    Log.i(TAG, "onResume: free-orientation (PlayerActivity does NOT pin)")
    // ── Phase 9: refresh PiP params ────────────────────────────────────
    // PiP params are tied to the activity, NOT to the PiP session —
    // the framework reads them when entering PiP. Setting them on
    // every resume guarantees they're current with the latest
    // surface size (e.g. orientation change) and aspect ratio (e.g.
    // user opened a different file).
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      try {
        val params = buildCurrentPipParams()
        setPictureInPictureParams(params)
        Log.i(
          TAG,
          "onResume: setPictureInPictureParams called with aspect=${getVideoAspect()} bounds=$playerBounds",
        )
      } catch (e: Exception) {
        Log.w(TAG, "onResume: setPictureInPictureParams threw ${e.message}", e)
      }
    }
    // Phase 15.3: refresh the MediaSession state on resume. The
    // session is created once in onCreate, but the playback state
    // (playing / paused) can change while the activity is
    // backgrounded (e.g. the user hit the PiP play/pause button).
    // We don't have a direct read of mpv's playing flag without
    // an observer hook, so we conservatively default to
    // `playing = true` on resume — the next MPVLib event from JS
    // (or the next session callback) will correct it.
    if (mediaSession != null) {
      updateMediaSessionState(playing = true)
    }
    // Phase 17.4: start the 1Hz progress update runnable. This
    // keeps MediaPlaybackService's notification progress bar in
    // sync with mpv's `time-pos` / `duration` properties. Runs
    // only while the activity is in the foreground; onPause
    // stops the runnable + sends a final ACTION_UPDATE so the
    // notification reflects the pause moment.
    startProgressUpdates()
    // Phase 20.1: register the AudioManager.ACTION_AUDIO_BECOMING_NOISY
    // receiver so we pause mpv when the user unplugs their
    // headphones. Registered only while the activity is
    // foregrounded (background audio playback doesn't need it —
    // the system won't re-fire the broadcast when the service
    // is in the foreground service state).
    registerHeadsetReceiver()
    // Phase 38: request audio focus so the system knows we're playing.
    // On focus loss (phone call, navigation, alarm) we'll pause mpv or
    // duck the volume — see requestAudioFocus() for the focus-change
    // handling.
    requestAudioFocus()
  }

  override fun onPictureInPictureModeChanged(
    isInPictureInPictureMode: Boolean,
    newConfig: Configuration,
  ) {
    super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
    Log.i(TAG, "onPictureInPictureModeChanged: isInPip=$isInPictureInPictureMode")
    // Phase 9.5: re-set params on every PiP entry/exit so the new
    // configuration (e.g. orientation change while in PiP) takes
    // effect. The system calls this both on entry and exit, but
    // setting params is a no-op when not in PiP mode.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      try {
        setPictureInPictureParams(buildCurrentPipParams())
      } catch (e: Exception) {
        Log.w(TAG, "onPictureInPictureModeChanged: setPictureInPictureParams threw ${e.message}", e)
      }
    }
    // Phase 10: forward to JS via the same MpvBridgeModule.companion
    // emit path that V11's MainActivity used, so JS handlers
    // listening for `onPipModeChanged` continue to fire. We can't
    // call `MpvBridgeModule.onPictureInPictureModeChanged` directly
    // (Gradle module boundary) so we look up the bridge via the
    // React Native module registry and cast to the module-side
    // `IPipModeChangeEmitter` contract.
    //
    // Resolution mirrors wireNativePtr (Phase 7): resolve
    // ReactApplicationContext via (application as? ReactApplication)
    // ?.reactHost.currentReactContext, then getNativeModule("MpvPlayerModule")
    // cast to IPipModeChangeEmitter. The lookup runs on the main
    // thread; missing context just logs a warning — the JS handler
    // will be one missed event, the rest of PiP behaviour (params,
    // RemoteActions) still works.
    Handler(Looper.getMainLooper()).post { forwardPipModeToJs(isInPictureInPictureMode) }
    // Phase 38 (spec §38.5: Surface lost during PiP → re-attach):
    // when PiP exits, the SurfaceView's surface may have been torn down
    // by the system (some OEMs destroy the surface during PiP to free
    // GPU memory). MpvRenderView.surfaceDestroyed() detaches the
    // surface from mpv, but it doesn't re-attach when a new surface
    // arrives. We trigger a re-attach here so the player resumes
    // rendering immediately after PiP exit.
    if (!isInPictureInPictureMode && lastNativePtr != 0L) {
      mpvRenderView?.let { view ->
        Log.i(TAG, "onPictureInPictureModeChanged (exit): re-attaching surface to mpv")
        try {
          view.setNativePtr(lastNativePtr)
        } catch (e: Exception) {
          Log.w(TAG, "onPictureInPictureModeChanged: setNativePtr threw ${e.message}", e)
        }
      }
    }
    // Phase 10.6: PiP transition completed; clear the entry-in-flight
    // flag so the deferred onPause check knows it's safe to pause
    // mpv if the activity is leaving for real (not via PiP).
    pipEntryInFlight = false
  }

  /**
   * Phase 10 helper: resolve [IPipModeChangeEmitter] via the React
   * Native bridge and emit the PiP mode-change event. Mirrors the
   * wireNativePtr retry pattern in spirit (resolve context →
   * lookup → cast) but only runs once per PiP transition — there's no
   * retry because a missed event is a single-frame UI glitch, not a
   * playback failure.
   */
  private fun forwardPipModeToJs(isInPictureInPictureMode: Boolean) {
    val reactContext: ReactApplicationContext = resolveReactApplicationContext() ?: run {
      Log.w(TAG, "forwardPipModeToJs: ReactApplicationContext null, dropping event")
      return
    }
    val module: NativeModule? = try {
      reactContext.getNativeModule("MpvPlayerModule")
    } catch (e: Exception) {
      Log.w(TAG, "forwardPipModeToJs: getNativeModule threw ${e.message}", e)
      null
    }
    if (module !is IPipModeChangeEmitter) {
      Log.w(
        TAG,
        "forwardPipModeToJs: 'MpvPlayerModule' not registered yet or doesn't implement IPipModeChangeEmitter " +
          "(got ${module?.javaClass?.simpleName ?: "null"})",
      )
      return
    }
    module.emitPictureInPictureModeChanged(isInPictureInPictureMode)
  }

  /**
   * Phase 10.4: enter PiP when the user performs a "leave" gesture
   * (home button, recent apps, swipe-down). This is the V11 pattern
   * from `MainActivity` — V11's flow was auto-PiP on home press. V12
   * keeps the same behaviour inside `PlayerActivity`.
   *
   * The PiP params (aspect, source rect, RemoteActions) were set in
   * Phase 9's `onResume`; we call the no-arg `enterPictureInPictureMode()`
   * overload so Android uses our pre-set params (the spec is explicit:
   * "NO params, they're set via setPictureInPictureParams").
   */
  override fun onUserLeaveHint() {
    super.onUserLeaveHint()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N &&
      packageManager.hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)
    ) {
      // Phase 10.6: set the defer flag BEFORE entering PiP so the
      // imminent onPause knows the upcoming transition is PiP, not a
      // real pause. Cleared in onPictureInPictureModeChanged once the
      // transition completes.
      pipEntryInFlight = true
      try {
        enterPictureInPictureMode()
        Log.i(TAG, "onUserLeaveHint: entering PiP (pipEntryInFlight=true)")
      } catch (e: Exception) {
        // Enter failed (OEM quirk, system in lock-task mode, etc.) —
        // clear the defer flag so the upcoming onPause behaves as a
        // normal pause.
        pipEntryInFlight = false
        Log.w(TAG, "onUserLeaveHint: enterPictureInPictureMode threw ${e.message}", e)
      }
    } else {
      Log.i(TAG, "onUserLeaveHint: PiP not supported, falling through to default")
    }
  }

  /**
   * Phase 10.6 + Phase 14.1: when the activity is paused (typically
   * because the user pressed home, opened recents, or switched to
   * another app), decide whether to pause mpv. The decision tree:
   *
   *   • If we're in PiP (or PiP entry is in flight that ends in
   *     PiP): do NOT pause. PiP keeps the activity visible in a
   *     small overlay; the user expects playback to continue.
   *   • If type=audio AND the user has the audioBackgroundPlayback
   *     setting enabled (default true): do NOT pause. Audio keeps
   *     playing in the background so the user can use other apps
   *     while listening. This mirrors how Spotify, Apple Music,
   *     etc. behave for audio.
   *   • Otherwise: pause mpv synchronously. This covers video
   *     backgrounds and the case where audio-background-playback
   *     is disabled.
   *
   * The framework sets `isInPictureInPictureMode` asynchronously
   * during the PiP transition, so we can't check it synchronously
   * here. Instead, defer the check by `200ms` (well past the time
   * Android takes to enter PiP after `onUserLeaveHint`); if we're
   * still not in PiP at that point, it's a real pause and we run
   * the audio-vs-video decision.
   *
   * Mirrors the mpvKt pattern (their `BaseMPVView.onPause` does
   * the same defer-then-check dance; we use the activity-level
   * `isInPictureInPictureMode` rather than a view flag because
   * the activity's flag is the source of truth).
   */
  override fun onPause() {
    super.onPause()
    // Phase 17.5: stop the 1Hz progress update runnable. The
    // notification is now frozen at the last position. We send
    // a final ACTION_UPDATE below the existing pause logic so
    // the notification reflects the position at the moment the
    // activity backgrounded (not the moment the runnable last
    // fired, which can be up to 1s stale).
    stopProgressUpdates()
    // Phase 20.1: unregister the headset-disconnect receiver.
    // Only needed while the activity is foregrounded; the
    // foreground service keeps the media session alive in the
    // background and would receive a re-broadcast on resume.
    unregisterHeadsetReceiver()
    // Phase 38: abandon audio focus on pause so other apps can resume
    // audio. We re-request on the next onResume.
    abandonAudioFocus()
    if (!pipEntryInFlight && lastNativePtr != 0L) {
      // Quick path: the defer flag isn't set, so we know
      // immediately this is a real pause (user pressed back,
      // locked the screen, opened another activity). Run the
      // audio-vs-video decision now.
      if (shouldKeepPlayingInBackground()) {
        Log.i(
          TAG,
          "onPause: audio background playback ON, mpv continues (type='$launchType')",
        )
      } else {
        try {
          MPVLib.nativePause(lastNativePtr)
          Log.i(TAG, "onPause: paused mpv synchronously (lastNativePtr=$lastNativePtr)")
        } catch (e: Exception) {
          Log.w(TAG, "onPause: nativePause threw ${e.message}", e)
        }
      }
    } else if (pipEntryInFlight) {
      // Defer the decision: PiP transition is in flight. Re-check
      // 200ms later — by then `isInPictureInPictureMode` will be
      // true if Android took the PiP path, or false if the
      // transition was cancelled. If we're not in PiP, fall
      // through to the audio-vs-video decision.
      //
      // Phase 36 leak fix: capture `this` via WeakReference so the
      // Handler's delayed Runnable doesn't pin the activity if it
      // fires after onDestroy (e.g., the user finishes PlayerActivity
      // mid-PiP-transition). Without the WeakReference, the lambda's
      // implicit `this` capture keeps the activity alive for the
      // full 200 ms delay window even after onDestroy nulled the
      // important fields.
      val activityRef = java.lang.ref.WeakReference(this)
      Handler(Looper.getMainLooper()).postDelayed({
        val activity = activityRef.get() ?: run {
          Log.i(TAG, "onPause (deferred 200ms): activity gone, aborting")
          return@postDelayed
        }
        if (activity.isInPictureInPictureMode) {
          Log.i(TAG, "onPause (deferred 200ms): entered PiP, mpv continues playing")
        } else if (activity.lastNativePtr != 0L) {
          if (activity.shouldKeepPlayingInBackground()) {
            Log.i(
              TAG,
              "onPause (deferred 200ms): audio background playback ON, mpv continues (type='${activity.launchType}')",
            )
          } else {
            try {
              MPVLib.nativePause(activity.lastNativePtr)
              Log.i(TAG, "onPause (deferred 200ms): NOT in PiP, paused mpv")
            } catch (e: Exception) {
              Log.w(TAG, "onPause (deferred): nativePause threw ${e.message}", e)
            }
          }
        }
      }, 200L)
    }
    // Phase 17.1: send a final ACTION_UPDATE so the
    // notification's progress bar reflects the position at
    // the moment of pause. Runs unconditionally — even when
    // audio keeps playing in the background, the user
    // benefits from seeing the position pin to the right
    // value on the lock-screen widget. We defer the
    // position query to the next looper tick so mpv has
    // time to settle the last time-pos read after the
    // pause itself.
    Handler(Looper.getMainLooper()).postDelayed(
      { updateMediaPlaybackServicePosition() },
      250L,
    )
  }

  /**
   * Phase 14.1.2 / 14.1.3: shared decision helper used by both the
   * quick and deferred `onPause` paths. Returns `true` when the
   * current launch is audio AND the user has the
   * `audioBackgroundPlayback` setting enabled. Returns `false`
   * for video (which always pauses on background) and for audio
   * when the setting is off.
   */
  private fun shouldKeepPlayingInBackground(): Boolean {
    return launchType == TYPE_AUDIO && audioBackgroundPlayback
  }

  /**
   * Phase 10.7: back-button behaviour. V11's contract was: pressing
   * back while in PiP finishes the activity (exits PiP, returns to
   * the parent app) — back from fullscreen does default behaviour.
   * V12 keeps the same contract.
   *
   * NOTE: `onBackPressed` is deprecated in API 33+; the platform
   * wants apps to use `OnBackInvokedCallback` (predictive back
   * gesture). For Phase 10 we keep the V11 approach and guard by
   * `isInPictureInPictureMode`; a Phase 35 hardening pass will move
   * to the new API for API 33+ targets.
   */
  override fun onBackPressed() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N && isInPictureInPictureMode) {
      // Finish exits PiP and returns the user to MainActivity (the
      // parent of PlayerActivity in the task stack). This matches the
      // V11 behaviour bit-for-bit.
      Log.i(TAG, "onBackPressed: in PiP, finishing PlayerActivity")
      finish()
      return
    }
    super.onBackPressed()
  }

  // ── PiP helpers (Phase 9) ──────────────────────────────────────────
  // Build the params that Android will use when entering PiP.
  // Combines: aspect (from mpv or audio-square fallback), source
  // rect (player bounds), actions (PipManager), title/subtitle
  // (intent extras + position).
  private fun buildCurrentPipParams(): PictureInPictureParams {
    val bounds = playerBounds
    // Phase 15.2: pick the PiP aspect ratio based on the launch
    // type. For video, the natural aspect from mpv (`getVideoAspect()`)
    // gives the same aspect as the in-app player. For audio, there
    // is no meaningful video aspect — the MpvRenderView is GONE
    // (Phase 12) — so we use a 1:1 square, which is the smallest
    // PiP window Android allows and matches the user expectation
    // for an audio overlay (Spotify / Apple Music / Audible all
    // use small square or near-square PiP windows for audio). The
    // `sourceRectHint` for audio is intentionally the full window
    // (playerBounds falls back to the activity window when the
    // GONE MpvRenderView has 0 size).
    val aspect: Float = if (launchType == TYPE_AUDIO) {
      1f // 1:1 square — audio PiP convention
    } else {
      getVideoAspect()
    }
    // Phase 9.2.4 / 9.2.5: title and subtitle for Android 12+
    // notification overlay. Title comes from the launch intent's
    // EXTRA_TITLE (already cached in `launchTitle`); subtitle is
    // the current playback position, but mpv's position is best
    // queried via MPVLib — for now we leave subtitle null until
    // Phase 10 wires the value through the bridge.
    return PipManager.buildPipParams(
      context = this,
      aspect = aspect,
      sourceRectHint = bounds,
      chapterTitle = launchTitle,
      progressPercentage = null,
    )
  }

  // Player bounds: the MpvRenderView's on-screen rectangle. Used
  // as the source rect hint for the PiP entry animation. Falls
  // back to the full activity window when MpvRenderView is not
  // yet laid out (e.g. immediate resume after onCreate).
  private val playerBounds: Rect
    get() {
      val view = mpvRenderView
      if (view != null && view.width > 0 && view.height > 0) {
        val location = IntArray(2)
        view.getLocationInWindow(location)
        return Rect(
          location[0],
          location[1],
          location[0] + view.width,
          location[1] + view.height,
        )
      }
      // Fallback: full activity window.
      return Rect(0, 0, window.decorView.width, window.decorView.height)
    }

  // Read the current video's aspect ratio from mpv's
  // `video-params/aspect` property. Falls back to 16:9 (the most
  // common modern aspect) when mpv hasn't loaded any video yet.
  private fun getVideoAspect(): Float {
    if (lastNativePtr == 0L) {
      return 16f / 9f
    }
    return try {
      val raw = MPVLib.nativeGetProperty(lastNativePtr, "video-params/aspect")
      val parsed = raw.trim().toFloatOrNull()
      if (parsed != null && parsed.isFinite() && parsed > 0f) {
        parsed.coerceIn(0.42f, 2.38f)
      } else {
        16f / 9f
      }
    } catch (_: Exception) {
      // mpv can throw if the property hasn't been set yet (no
      // video loaded) or if the handle was destroyed mid-call.
      16f / 9f
    }
  }

  // Phase 17.1: read the current playback position from mpv's
  // `time-pos` property (seconds, as a string). Returns the value
  // in milliseconds, or 0L when mpv hasn't loaded anything yet
  // (the property is empty / not set) or the handle is dead.
  // `time-pos` is a double, but `nativeGetProperty` only returns
  // a string — we parse and convert. The parse is the same
  // pattern [getVideoAspect] uses for the video-params/aspect
  // property.
  private fun getPlaybackPositionMs(): Long {
    if (lastNativePtr == 0L) return 0L
    return try {
      val raw = MPVLib.nativeGetProperty(lastNativePtr, "time-pos")
      val parsed = raw.trim().toDoubleOrNull()
      if (parsed != null && parsed.isFinite() && parsed >= 0.0) {
        (parsed * 1000.0).toLong()
      } else {
        0L
      }
    } catch (_: Exception) {
      0L
    }
  }

  // Phase 17.1: read the total duration from mpv's `duration`
  // property. Returns ms, or 0L when not yet known (mpv sets
  // `duration` once the file is parsed).
  private fun getPlaybackDurationMs(): Long {
    if (lastNativePtr == 0L) return 0L
    return try {
      val raw = MPVLib.nativeGetProperty(lastNativePtr, "duration")
      val parsed = raw.trim().toDoubleOrNull()
      if (parsed != null && parsed.isFinite() && parsed > 0.0) {
        (parsed * 1000.0).toLong()
      } else {
        0L
      }
    } catch (_: Exception) {
      0L
    }
  }

  // ── Media metadata (Phase 19) ──────────────────────────────────────
  // Phase 19.1: query mpv for the loaded file's tagged metadata.
  // All three helpers return "" when the property is missing or
  // the handle is dead — callers fall back to the launch title
  // (or just show title-only) when that happens. We use the
  // `metadata/by-key/*` form because that's the reliable path
  // in modern mpv (the older `metadata/artist` form only fires
  // for the first artist in the tag list, which on multi-artist
  // files can be a featured artist rather than the main one).
  private fun getMediaTitle(): String {
    if (lastNativePtr == 0L) return ""
    return try {
      MPVLib.nativeGetProperty(lastNativePtr, "media-title").trim()
    } catch (_: Exception) {
      ""
    }
  }

  private fun getMediaArtist(): String {
    if (lastNativePtr == 0L) return ""
    return try {
      MPVLib.nativeGetProperty(lastNativePtr, "metadata/by-key/artist").trim()
    } catch (_: Exception) {
      ""
    }
  }

  private fun getMediaAlbum(): String {
    if (lastNativePtr == 0L) return ""
    return try {
      MPVLib.nativeGetProperty(lastNativePtr, "metadata/by-key/album").trim()
    } catch (_: Exception) {
      ""
    }
  }

  // Phase 19.2 + 19.4: build a MediaMetadataCompat from the
  // current values and set it on the MediaSession. Called from
  // createMediaSession (initial set with launch title) and from
  // the post-wireNativePtr refresh (so the metadata reflects the
  // actual mpv tags once the file is loaded).
  //
  // Title fallback chain: mpv `media-title` → launch title →
  // "Simba Player" (last resort so the lock-screen widget never
  // shows blank). Artist / album stay empty when not tagged —
  // the lock-screen widget collapses to title-only in that case
  // (matches how Spotify / YouTube Music render un-tagged files).
  //
  // The metadata is set on the session (not the notification
  // directly) so the system media controls (lock-screen widget,
  // Android Auto, Bluetooth) all pick up the same values. The
  // notification's own title/subtitle are still set in
  // MediaPlaybackService.buildNotification (Phase 16), so the
  // notification UI also reflects the metadata — the values
  // just arrive through two paths.
  private fun setMediaSessionMetadata() {
    val session = mediaSession ?: return
    val title = getMediaTitle().ifBlank { launchTitle.ifBlank { "Simba Player" } }
    val artist = getMediaArtist()
    val album = getMediaAlbum()
    val duration = getPlaybackDurationMs()
    val builder = android.support.v4.media.MediaMetadataCompat.Builder()
      .putString(android.support.v4.media.MediaMetadataCompat.METADATA_KEY_TITLE, title)
      .putString(android.support.v4.media.MediaMetadataCompat.METADATA_KEY_DISPLAY_TITLE, title)
      .putString(android.support.v4.media.MediaMetadataCompat.METADATA_KEY_ARTIST, artist)
      .putString(android.support.v4.media.MediaMetadataCompat.METADATA_KEY_ALBUM, album)
      .putString(android.support.v4.media.MediaMetadataCompat.METADATA_KEY_DISPLAY_SUBTITLE, buildDisplaySubtitle(artist, album))
      .putString(android.support.v4.media.MediaMetadataCompat.METADATA_KEY_MEDIA_URI, launchUri)
    if (duration > 0L) {
      builder.putLong(android.support.v4.media.MediaMetadataCompat.METADATA_KEY_DURATION, duration)
    }
    try {
      session.setMetadata(builder.build())
      Log.i(
        TAG,
        "MediaSession metadata set: title='$title' artist='$artist' album='$album' duration=$duration",
      )
    } catch (e: Exception) {
      Log.w(TAG, "setMediaSessionMetadata: session.setMetadata threw ${e.message}", e)
    }
  }

  // Phase 19.2 helper: build the `"Artist • Album"` display
  // string used for the notification subtitle. Returns the
  // artist alone when album is blank, or null when both are
  // blank (so the lock-screen widget can collapse to title-only).
  private fun buildDisplaySubtitle(artist: String, album: String): String {
    return when {
      artist.isNotBlank() && album.isNotBlank() -> "$artist • $album"
      artist.isNotBlank() -> artist
      else -> ""
    }
  }

  override fun onDestroy() {
    // Step 6.6.1: cleanup the SurfaceView (detach Surface from mpv
    // and zero the native pointer so any late native callback becomes
    // a no-op).
    mpvRenderView?.cleanup()
    // Step 6.6.2: remove from the content root. Guard against the
    // view having already been detached by the framework (defensive
    // but cheap; indexOfChildById-style call would be heavier).
    mpvRenderView?.let { view ->
      val parent = view.parent as? ViewGroup
      parent?.removeView(view)
    }
    // Step 6.6.3: null the reference.
    mpvRenderView = null
    Log.i(TAG, "onDestroy: MpvRenderView cleaned up and removed")
    // Phase 17.5: stop the progress update runnable. The
    // service is about to stop (below), so the runnable would
    // race with the service teardown on its next tick. Stop
    // here first; the service stop in the next step cancels
    // any final ACTION_UPDATE we might have queued.
    stopProgressUpdates()
    // Phase 40: unregister the ComponentCallbacks2 listener so the
    // activity-scoped reference doesn't pin the listener past onDestroy.
    applicationContext.unregisterComponentCallbacks(trimMemoryListener)
    // Phase 38: abandon audio focus as part of the teardown sequence
    // (matches onPause; idempotent if already abandoned).
    abandonAudioFocus()
    // Phase 16.7: stop the MediaPlaybackService. We send a
    // ACTION_STOP intent so the service runs its own teardown
    // (removes the foreground state, then calls stopSelf) instead
    // of relying on stopService to yank it. The teardown order
    // matters: we stop the service BEFORE releasing the
    // MediaSession because the service holds a token reference;
    // if the token becomes invalid before the service drops it,
    // the notification's MediaStyle.setMediaSession(token) call
    // in the next build will log a warning.
    stopMediaPlaybackService()
    // Phase 15.3: release the MediaSession before the activity is
    // torn down. Order doesn't matter much for MediaSession
    // (release is idempotent), but we do it before the receiver
    // unregister so the lock-screen widget disappears as part of
    // the same shutdown.
    releaseMediaSession()
    // Phase 10: unregister the PiP action broadcast receiver. Must
    // happen BEFORE the super call so the receiver is gone before
    // the activity is fully torn down (otherwise Android logs a
    // `Receiver not registered` warning if the system fires a
    // trailing broadcast during teardown).
    pipReceiver?.let {
      try {
        unregisterReceiver(it)
        Log.i(TAG, "onDestroy: PipActionReceiver unregistered")
      } catch (e: Exception) {
        Log.w(TAG, "onDestroy: unregisterReceiver threw ${e.message}", e)
      }
    }
    pipReceiver = null
    // Step 6.6.4: super last so React teardown happens after our
    // surface cleanup (the React view tree uses the same content root
    // we're modifying, so ordering matters).
    super.onDestroy()
    Log.i(TAG, "onDestroy: tearing down PlayerActivity")
  }
}