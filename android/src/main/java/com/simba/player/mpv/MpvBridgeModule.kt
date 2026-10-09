package com.simba.player.mpv

import android.content.Intent
import android.graphics.Bitmap
import android.media.MediaMetadataRetriever
import android.util.Log
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.module.annotations.ReactModule
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.facebook.fbreact.specs.NativeMpvPlayerSpec
import com.simba.player.IMpvConfigProvider
import com.simba.player.IPipModeChangeEmitter
import com.simba.player.PlaybackHost
import org.json.JSONArray
import org.json.JSONObject

/**
 * Turbo Module / Native Module bridge between React Native JS and libmpv.
 *
 * Registered as "MpvPlayerModule" — matches the TS Spec name in
 * NativeMpvPlayer.ts.
 */
@ReactModule(name = MpvBridgeModule.NAME)
class MpvBridgeModule(reactContext: ReactApplicationContext) :
    NativeMpvPlayerSpec(reactContext),
    IMpvConfigProvider,
    IPipModeChangeEmitter {

    companion object {
        const val NAME = "MpvPlayerModule"
        private const val TAG = "MpvBridgeModule"

        // ── captureFrame: resume-rail thumbnails ──────────────────────────
        // `MediaMetadataRetriever` needs a real filesystem path for its
        // output. `filesDir` (NOT cacheDir) is deliberate: the platform
        // is free to evict cacheDir at any moment, and a thumbnail that
        // disappears silently blanks a Continue-Watching cell on the
        // next cold start with no error anywhere.
        private const val RESUME_THUMB_DIR = "simba-resume-thumbs"

        // Poster-sized defaults, mirrored in TS as
        // `DEFAULT_FRAME_WIDTH` / `DEFAULT_FRAME_HEIGHT` /
        // `DEFAULT_FRAME_QUALITY` (src/hooks/useResumeThumbnail.ts).
        //
        // 640x360 is exactly 16:9, so the dominant case (film / TV /
        // YouTube landscape video) scales without distortion, and
        // ~230 kpx lands around 25-40 kB per JPEG at quality 80.
        // Portrait sources should pass `width = 0`, which the platform
        // reads as "leave the width unconstrained" so the source
        // aspect ratio survives.
        private const val DEFAULT_FRAME_WIDTH = 640
        private const val DEFAULT_FRAME_HEIGHT = 360
        private const val DEFAULT_FRAME_QUALITY = 80

        // Position granularity for the output filename. A resume
        // position drifts by seconds between renders (and the user may
        // stop anywhere), so bucketing to 30s means repeated calls for
        // "roughly where they left off" overwrite ONE file instead of
        // re-encoding a near-duplicate JPEG on every scroll/re-render.
        private const val FRAME_POSITION_BUCKET_MS = 30_000L

        // v1.10.0 — hot-path property tracing.
        //
        // `time-pos` is mpv's per-frame property, so tracing every property
        // change costs a logd write 30-60x/second on the player event
        // thread. Off in every build config; flip to `true` locally when
        // diagnosing a property that is observed but never arrives.
        //
        // Deliberately a `const val`, not a system property or env lookup:
        // a runtime lookup would itself run on the hot path, and
        // `Log.isLoggable()` is not free either. A constant lets R8 inline
        // the branch away in release entirely.
        private const val TRACE_PROPERTY_EVENTS = false

        // V22.0.0 / 1.5.10 (D-034): activity-aware launchParams guard.
        //
        // Background: `lastLaunchParams` (declared further down) is the
        // canonical handoff from `openPlayer(...)` to the next
        // `PlayerActivity` mount. The previous architecture had
        // `useLaunchParams()` consume it from BOTH MainActivity's React
        // tree and PlayerActivity's React tree - both activities mount
        // the same JS App and both wrap in `<SimbaPlayerRoot>` which
        // calls the hook on mount. Result on cold start: stale
        // lastLaunchParams from a prior `openPlayer` call got consumed
        // by MainActivity's tree, and `<PlayerRoot />` got rendered over
        // the Home screen (the V22 user regression).
        //
        // The fix: PlayerActivity's `onCreate` sets this flag to
        // `true` and `onDestroy` resets to `false`. `useLaunchParams()`
        // consults it via the synchronous `isCurrentActivityPlayer()`
        // bridge method and returns `null` (without touching
        // lastLaunchParams) when we are in any non-PlayerActivity host.
        // The flag is process-wide (companion object), so React tree
        // boundaries don't matter.
        @Volatile
        @JvmStatic
        var currentActivityIsPlayer: Boolean = false

        // Holds the ReactApplicationContext from RN init time so non-module
        // call sites (e.g. MainActivity.onPictureInPictureModeChanged) can
        // emit DeviceEventManagerModule events. Bridgeless RN: MainActivity's
        // reactInstanceManager getter throws, and reactHost.currentReactContext
        // can be null when PiP fires before RN fully initializes, so we cannot
        // safely resolve the context from MainActivity itself.
        @Volatile
        private var instance: ReactApplicationContext? = null

        // Phase 39: tracks whether debug logging is enabled (for the
        // `onLog` event emitter path). Mirrored in the instance field
        // `debugLoggingEnabled` so the @ReactMethod can read/write
        // without going through the companion. The companion
        // reference is for any future helper that needs to check
        // the flag from outside the instance.
        @Volatile
        var debugLoggingEnabled: Boolean = false
            private set

        /**
         * Phase 13: snapshot of the launch params the most recent
         * [openPlayer] call handed to `PlayerActivity`. Populated
         * before `startActivity` and consumed (cleared) by the next
         * [getLaunchParams] call. PlayerActivity's JS calls
         * `getLaunchParams()` on mount to rebuild its PlaybackContext
         * state — the launched activity's React context is fresh and
         * has no MainActivity PlaybackContext state to inherit.
         */
        @Volatile
        private var lastLaunchParams: LaunchParams? = null

        /**
         * D-039: PlayerActivity is the source of truth for launch
         * params read from its Intent extras, but the JS tree inside
         * the launched activity reads them back via [getLaunchParams]
         * which inspects [lastLaunchParams]. Without this push, any
         * PlayerActivity launch that bypasses [openPlayer] (deep link,
         * app shortcut, `am start`, ADB) leaves JS `getLaunchParams()`
         * returning null and `<PlayerRoot />` renders the empty
         * fallback. Populated from [com.simba.player.PlayerActivity.onCreate]
         * immediately after the `launchUri` / `launchTitle` /
         * `launchType` / `launchStartPositionMs` lazy vals are first
         * touched. No-op if `uri` is blank — MainActivity (which has
         * no player intent extras) won't accidentally clobber a real
         * launch in flight.
         */
        @JvmStatic
        fun setLaunchParamsFromIntent(
            uri: String,
            title: String,
            type: String,
            startPositionMs: Long,
        ) {
            if (uri.isBlank()) return
            lastLaunchParams = LaunchParams(uri, title, type, startPositionMs)
            Log.i(
                TAG,
                "[PlaybackTrace][Bridge][setLaunchParamsFromIntent] populated from Intent extras uri='$uri' type='$type' startMs=$startPositionMs",
            )
        }

        /**
         * Phase 13.3: simple value class for the launch params
         * cached for [getLaunchParams]. Mirrors the four intent
         * extras that PlayerActivity reads from its own `by lazy {}`
         * `launchUri` / `launchTitle` / `launchType` /
         * `launchStartPositionMs` properties.
         */
        data class LaunchParams(
            val uri: String,
            val title: String,
            val type: String,
            val startPositionMs: Long,
        )

        /**
         * Phase 21: cached PlayerConfig pushed by `<PlayerProvider
         * config={...}>` via `setConfig(configJson)`. Stored as a
         * Kotlin Map so module code (PlayerActivity) can read
         * individual keys without re-parsing JSON. `@Volatile` because
         * the push happens on the React Native JS thread while the
         * read happens on the Android main thread.
         *
         * `null` when no Provider has wrapped the consumer app's
         * root — PlayerActivity logs that case explicitly so the
         * build verification can confirm the wire is live.
         */
        @Volatile
        private var currentConfig: Map<String, Any?>? = null

        /**
         * Phase 21: recursive JSONObject → Kotlin Map converter. Used
         * by [setConfig] so the stored config can be consumed
         * without going through `WritableMap`. Keeps nested objects
         * (theme / pip / audio sections) typed as nested maps.
         */
        private fun jsonObjectToMap(obj: JSONObject): Map<String, Any?> {
            val out = LinkedHashMap<String, Any?>(obj.length())
            val it = obj.keys()
            while (it.hasNext()) {
                val k = it.next()
                out[k] = jsonValueToKotlin(obj.get(k))
            }
            return out
        }

        private fun jsonValueToKotlin(v: Any?): Any? = when (v) {
            null, JSONObject.NULL -> null
            is JSONObject -> jsonObjectToMap(v)
            is JSONArray -> {
                val list = ArrayList<Any?>(v.length())
                for (i in 0 until v.length()) {
                    list.add(jsonValueToKotlin(v.get(i)))
                }
                list
            }
            else -> v
        }

        /**
         * Called from [com.simba.player.MainActivity.onPictureInPictureModeChanged].
         * Uses the ReactApplicationContext captured at module construction
         * (well before any PiP lifecycle event can fire) to emit the event.
         * Mirrors the companion sendEvent pattern from
         * https://yor-dev.com/react-native-picture-in-picture-native-in-android/
         */
        fun onPictureInPictureModeChanged(isInPictureInPictureMode: Boolean) {
            Log.i(TAG, "companion.onPictureInPictureModeChanged: isInPip=$isInPictureInPictureMode instance=${instance != null}")
            val ctx = instance ?: run {
                Log.w(TAG, "onPictureInPictureModeChanged: module instance not initialized yet")
                return
            }
            // Do NOT cycle the surface binding here. Cycling detaches →
            // re-attaches → triggers a mpv VO reinit → kills MediaCodec
            // (decoder falls back to software, ~1s render gap, PiP
            // shows black). Instead, the SurfaceView with
            // setZOrderMediaOverlay(true) and force-window=yes keeps the
            // gpu video output rendering into the attached surface, and
            // the PiP compositor samples that surface layer directly.
            val params = Arguments.createMap().apply {
                putBoolean("isInPip", isInPictureInPictureMode)
            }
            try {
                ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                    .emit("onPipModeChanged", params)
                Log.i(TAG, "companion.onPictureInPictureModeChanged: emit succeeded")
            } catch (e: Exception) {
                Log.w(TAG, "onPictureInPictureModeChanged: emit threw", e)
            }
        }
    }

    // ── IPipModeChangeEmitter (Phase 10) ────────────────────────────────
    // Phase 10: PlayerActivity (in the module) cannot call
    // `MpvBridgeModule.onPictureInPictureModeChanged` directly because
    // of the Gradle module boundary. It looks us up via the React Native
    // bridge (`getNativeModule("MpvPlayerModule") as? IPipModeChangeEmitter`)
    // and calls this method. We delegate to the companion method so the
    // single source of truth for PiP mode-change events stays in the
    // companion (the JS event name + payload contract is defined there).
    override fun emitPictureInPictureModeChanged(isInPictureInPictureMode: Boolean) {
        onPictureInPictureModeChanged(isInPictureInPictureMode)
    }

    init {
        // Capture the ReactApplicationContext for the companion sendEvent path.
        // Phase 36: clear the static reference when the module is destroyed so
        // the React context can be GC'd normally. `onCatalystInstanceDestroy`
        // is the React Native contract for "this context is gone"; clearing
        // `instance` here lets the old ReactApplicationContext (and its
        // ReactHost / ReactInstanceManager / bridge references) be reclaimed
        // when the consumer app's debug reload or process restart happens.
        instance = reactContext
    }

    override fun getName(): String = NAME

    // ── State ──────────────────────────────────────────────────────────────

    /**
     * V20 Phase A: the libmpv handle, *delegated* to [PlaybackHost].
     *
     * This is deliberately a property, not a field. It holds no state of
     * its own — [PlaybackHost] is the single owner, because the handle is
     * a process-global in C++ (`g_mpv`) and a React Native TurboModule
     * dies with its React context, which would leave the handle owned by
     * something that is not alive when playback still needs it.
     *
     * Keeping the name means the ~30 existing read sites are unchanged;
     * what changed is that a read can no longer return a stale copy,
     * because there is no longer a copy to be stale.
     */
    private var nativePtr: Long
        get() = PlaybackHost.handle()
        set(value) {
            if (value == 0L) PlaybackHost.clearHandle() else PlaybackHost.publishHandle(value)
        }

    /** Event emitter for JS-side event listeners. */
    private val eventEmitter: DeviceEventManagerModule.RCTDeviceEventEmitter by lazy {
        reactApplicationContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
    }

    /**
     * Property observers requested by JS before native initialization completes.
     * Keep them until the handle exists instead of silently dropping them.
     */
    private val pendingObservedProperties = linkedSetOf<String>()

    /**
     * Serial executor for [captureFrame].
     *
     * Two things force it to exist at all:
     *  1. `MediaMetadataRetriever.getScaledFrameAtTime()` does real
     *     I/O — opening a (possibly remote, range-requested) source,
     *     seeking a decoder, and JPEG-encoding the result. On a cold
     *     Continue-Watching rail that is tens of ms PER ITEM, which on
     *     the JS or UI thread is a dropped-frame stall (and on the UI
     *     thread, an ANR if the source is remote). The existing
     *     `screenshot()` is a blocking-sync `@ReactMethod` and must NOT
     *     be used as a template for this.
     *  2. `MediaMetadataRetriever` holds native codec handles. Two
     *     concurrent retrievers on the same source multiply peak
     *     memory, so requests are queued on ONE thread and the
     *     in-flight count stays at exactly 1.
     *
     * Shut down in `onCatalystInstanceDestroy` so a dev reload does
     * not leave an idle thread behind per module instance.
     */
    private val frameExecutor: ExecutorService =
        Executors.newSingleThreadExecutor { runnable ->
            Thread(runnable, "simba-frame-extractor")
        }

    // ── MPVLib Listener → JS Event Bridge ──────────────────────────────────

    private val mpvListener = object : MPVLib.MpvEventListener {
        override fun onMpvEvent(event: String, jsonPayload: String) {
            Log.i(TAG, "[PlaybackTrace][Bridge][listener:event] name=$event payload=$jsonPayload")
            // Map to JS event name conventions
            val jsEvent = when (event) {
                "fileLoaded"        -> "onFileLoaded"
                "startFile"         -> "onStartFile"
                "endFile"           -> "onEndFile"
                "playbackRestart"   -> "onPlaybackRestart"
                "seek"              -> "onSeek"
                "surfaceAttached"   -> "onSurfaceAttached"
                else                -> event
            }
            try {
                val payload = JsonUtil.jsonStringToReactMap(jsonPayload)
                eventEmitter.emit(jsEvent, payload)
            } catch (e: Exception) {
                Log.w(TAG, "Failed to emit event $jsEvent: ${e.message}")
            }
        }

        override fun onMpvPropertyChanged(name: String, jsonValue: String) {
            // v1.10.0: this was an unconditional Log.i carrying the full
            // JSON payload of EVERY property change. `time-pos` changes once
            // per video frame, so this fired 30-60x/second on the player's
            // event thread, each call building the message string
            // (Kotlin string templates are evaluated before Log.i can decide
            // to discard them) and performing a synchronous write to logd.
            // Gate it behind the same debug switch as the JS dlog(); the
            // property value is still delivered to JS regardless.
            if (TRACE_PROPERTY_EVENTS) {
                Log.d(TAG, "[PlaybackTrace][Bridge][listener:property] name=$name value=$jsonValue")
            }
            // v1.10.0: dedupe the generic stream. Every property below already
            // gets a dedicated, typed event (onPositionChanged, onBuffering,
            // onCacheState, onSeekable, ...), and `onPropertyChanged` was
            // emitted for all of them too — so `time-pos` crossed the bridge
            // twice per frame and the JS reducer ran twice. Emitting the
            // generic event ONLY for properties that have no dedicated event
            // keeps the JS `onPropertyChanged` contract intact for anything
            // that reads it while removing the double delivery.
            val hasDedicatedEvent = when (name) {
                "time-pos", "duration", "volume", "speed", "pause",
                "idle-active", "eof-reached", "seekable", "seeking",
                "cache-buffering-state", "paused-for-cache",
                "demuxer-cache-state" -> true
                else -> false
            }
            if (!hasDedicatedEvent) {
                try {
                    val payload = Arguments.createMap().apply {
                        putString("property", name)
                        putString("value", jsonValue)
                    }
                    eventEmitter.emit("onPropertyChanged", payload)
                } catch (e: Exception) {
                    Log.w(TAG, "Property change emit failed: ${e.message}")
                }
            }
            // P33.4: re-emit `cache-buffering-state` updates as `onBuffering`
            // so the JS UI can show a buffering spinner for slow streams
            // (notably archive.org which progressively buffers before the
            // first frame). mpv reports the property as:
            //   • a node map {"percent": <0..100>} while actively buffering
            //   • the literal string "false" once the cache is full / idle
            // We always emit 100 on the "false" case so the JS guard
            //   `percent > 0 && percent < 100` correctly drops the spinner.
            when (name) {
                "cache-buffering-state" -> {
                    val percent = parseBufferingPercent(jsonValue)
                    try {
                        val bufPayload = Arguments.createMap().apply {
                            putDouble("percent", percent)
                            putBoolean("isBuffering", percent < 100.0)
                        }
                        eventEmitter.emit("onBuffering", bufPayload)
                    } catch (e: Exception) {
                        Log.w(TAG, "onBuffering emit failed: ${e.message}")
                    }
                }
                // `paused-for-cache` is the universal stall signal. Do not
                // encode it as a fabricated fill percentage; the JS layer gets
                // the explicit boolean and preserves the last honest cache fill.
                "paused-for-cache" -> {
                    val isBuffering = jsonValue.trim().equals("true", ignoreCase = true)
                    try {
                        val bufPayload = Arguments.createMap().apply {
                            putDouble("percent", if (isBuffering) 0.0 else 100.0)
                            putBoolean("isBuffering", isBuffering)
                        }
                        eventEmitter.emit("onBuffering", bufPayload)
                    } catch (e: Exception) {
                        Log.w(TAG, "onBuffering (paused-for-cache) emit failed: ${e.message}")
                    }
                }
                // `demuxer-cache-state` carries the buffered ranges — the
                // grey overlay on the seek bar. Each range is
                // `{start, end, flags}` in MPV; we extract `start`/`end`
                // (in seconds, relative to the stream start) and forward
                // them as a list so JS can paint the buffered region.
                "demuxer-cache-state" -> {
                    try {
                        val parsed = parseCacheState(jsonValue)
                        val rangesArray = Arguments.createArray()
                        parsed.ranges.forEach { r ->
                            val range = Arguments.createMap().apply {
                                putDouble("start", r.first)
                                putDouble("end", r.second)
                            }
                            rangesArray.pushMap(range)
                        }
                        val cachePayload = Arguments.createMap().apply {
                            putArray("ranges", rangesArray)
                            putDouble("fill", parsed.fill)
                        }
                        eventEmitter.emit("onCacheState", cachePayload)
                    } catch (e: Exception) {
                        Log.w(TAG, "onCacheState emit failed: ${e.message}")
                    }
                }
                // `seekable` is a flag — true once MPV knows enough about
                // the stream to permit seeks. False for live streams and
                // unknown-length sources. The seek bar dims when false.
                "seekable" -> {
                    val seekable = jsonValue.trim().equals("true", ignoreCase = true)
                    try {
                        val seekablePayload = Arguments.createMap().apply {
                            putBoolean("seekable", seekable)
                        }
                        eventEmitter.emit("onSeekable", seekablePayload)
                    } catch (e: Exception) {
                        Log.w(TAG, "onSeekable emit failed: ${e.message}")
                    }
                }
                "seeking" -> {
                    val seeking = jsonValue.trim().equals("true", ignoreCase = true)
                    try {
                        val seekingPayload = Arguments.createMap().apply {
                            putBoolean("seeking", seeking)
                        }
                        eventEmitter.emit("onSeeking", seekingPayload)
                    } catch (e: Exception) {
                        Log.w(TAG, "onSeeking emit failed: ${e.message}")
                    }
                }
                // Keep the dedicated JS event contract backed by mpv's generic
                // property observer stream. These events are consumed by both
                // the playback controller and TransportContext for low-latency
                // state updates; polling remains as a defensive fallback.
                "time-pos" -> emitNumericEvent("onPositionChanged", "position", jsonValue)
                "duration" -> emitNumericEvent("onDurationChanged", "duration", jsonValue)
                "volume" -> emitNumericEvent("onVolumeChanged", "volume", jsonValue)
                "speed" -> emitNumericEvent("onSpeedChanged", "speed", jsonValue)
                "pause" -> {
                    val paused = jsonValue.trim().trim('"').equals("true", ignoreCase = true)
                    emitPlaybackStateEvent(if (paused) "paused" else "playing")
                }
                "idle-active", "eof-reached" -> emitPlaybackStateEvent(getPlaybackState())
            }
        }

        override fun onMpvError(code: Int, recoverable: Boolean, message: String, requestId: String?) {
            Log.e(TAG, "[PlaybackTrace][Bridge][listener:error] code=$code recoverable=$recoverable requestId=${requestId ?: "none"} message=$message")
            // Phase 38: map the libmpv int code to a structured Phase 38
            // string code so consumers can switch on a stable contract.
            // The mapping is best-effort — codes outside our known set
            // get the generic E_DECODE_FAILED.
            val mappedCode = when {
                !recoverable -> "E_RENDERER_GONE"
                message.contains("network", ignoreCase = true) ||
                message.contains("Connection refused", ignoreCase = true) ||
                message.contains("Connection timed out", ignoreCase = true) -> "E_NETWORK_FAILURE"
                message.contains("codec", ignoreCase = true) ||
                message.contains("format", ignoreCase = true) ||
                message.contains("unsupported", ignoreCase = true) -> "E_UNSUPPORTED_CODEC"
                message.contains("No such file", ignoreCase = true) ||
                message.contains("not found", ignoreCase = true) -> "E_FILE_NOT_FOUND"
                else -> "E_DECODE_FAILED"
            }
            // Phase 38.6 (deferred → Phase 39): for non-recoverable errors
            // (the renderer process died), emit the structured event
            // with recoverable=false so consumers know to call
            // initPlayer() + loadFile() to recover.
            emitErrorEvent(mappedCode, message, null)
            val payload = Arguments.createMap().apply {
                putString("code", mappedCode)
                putInt("nativeCode", code)
                putBoolean("recoverable", recoverable)
                putString("message", message)
                if (!requestId.isNullOrBlank()) putString("requestId", requestId)
            }
            eventEmitter.emit("onError", payload)
        }
    }

    private fun emitNumericEvent(eventName: String, key: String, rawValue: String) {
        val value = rawValue.trim().trim('"').toDoubleOrNull() ?: return
        try {
            val payload = Arguments.createMap().apply {
                putDouble(key, value)
            }
            eventEmitter.emit(eventName, payload)
        } catch (e: Exception) {
            Log.w(TAG, "$eventName emit failed: ${e.message}")
        }
    }

    private fun emitPlaybackStateEvent(state: String) {
        try {
            val payload = Arguments.createMap().apply {
                putString("state", state)
            }
            eventEmitter.emit("onPlaybackStateChanged", payload)
        } catch (e: Exception) {
            Log.w(TAG, "onPlaybackStateChanged emit failed: ${e.message}")
        }
    }

    // ── Screen Brightness ──

    @ReactMethod
    @Override
    override fun setScreenBrightness(brightness: Double) {
        val activity = getCurrentActivity() ?: return
        val layout = activity.window.attributes
        layout.screenBrightness = brightness.toFloat().coerceIn(0.0f, 1.0f)
        activity.window.attributes = layout
    }

    @ReactMethod(isBlockingSynchronousMethod = true)
    @Override
    override fun getScreenBrightness(): Double {
        val activity = getCurrentActivity() ?: return 1.0
        val b = activity.window.attributes.screenBrightness
        return if (b < 0f) 1.0 else b.toDouble()
    }

    // ── Keep Screen On (W2.12) ──
    // Toggles WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON on the
    // current activity. The flag is window-level so the activity does
    // not need to be the player activity; the FLAG_KEEP_SCREEN_ON keeps
    // the device awake as long as the flag is set, regardless of which
    // view is in the foreground. The JS caller (VideoHost) flips this
    // on when entering 'playing' and off on pause/finish/close.

    @ReactMethod
    @Override
    override fun setKeepScreenOn(enabled: Boolean) {
        val activity = getCurrentActivity() ?: return
        activity.runOnUiThread {
            if (enabled) {
                activity.window.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            } else {
                activity.window.clearFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            }
        }
    }

    // ── Orientation / Immersive (v11 T8.1) ──────────────────────────────
    // setOrientation pins the activity to a fixed orientation; the
    // JS caller toggles between 'portrait' / 'landscape' when the
    // user taps the fullscreen chip. We use the user-locked
    // variants (USER_PORTRAIT / USER_LANDSCAPE) so the user can
    // still rotate the device within the locked axis but the
    // activity does not flip on a pocket-grab during playback.
    // 'sensor' is the un-locked mode for the optional
    // device-tilt-follows-orientation case.
    //
    // setImmersive drives the system bars via
    // WindowInsetsControllerCompat (the modern replacement for
    // the deprecated setSystemUiVisibility). The behaviour is
    // BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE so the user can
    // still recover the bars with an edge swipe, and the immersive
    // flag auto-clears when the activity loses foreground.
    //
    // v11 T8.1 error fix: setImmersive(false) is called from BOTH
    // exit paths (the fullscreen chip + the close button) so the
    // bars re-show on every tested OEM, even if the user backs
    // out via the system back button or a swipe-down dismiss
    // before the chip is reached.

    @ReactMethod
    @Override
    override fun setOrientation(mode: String) {
        val activity = getCurrentActivity()
        if (activity == null) {
            // v1.9.3 — this used to be a bare `?: return`. That is a
            // silent no-op: the JS side flips its "locked" flag, the
            // glyph swaps to a padlock, and the video keeps rotating as
            // if nothing was requested. A control that reports success
            // while doing nothing is worse than one that errors, so the
            // refusal is logged at the same level the caller can find.
            android.util.Log.w(TAG, "setOrientation('$mode') ignored: no current activity")
            return
        }
        activity.runOnUiThread {
            val requested = when (mode.lowercase()) {
                // v1.9.3 — these were USER_PORTRAIT / USER_LANDSCAPE.
                //
                // The `USER_` variants respect the SYSTEM auto-rotate
                // switch: with auto-rotate off, asking for landscape is
                // silently ignored by the platform. That is exactly the
                // reported symptom — tap the lock, the glyph changes,
                // the video does not move.
                //
                // An app asking to PIN the window is making an explicit
                // user decision about this one activity, so it must win
                // over a global device preference. The plain constants
                // are the correct ones for an explicit per-activity
                // request.
                "portrait"  -> android.content.pm.ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
                "landscape" -> android.content.pm.ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
                // 'sensor' is the opposite case: it MEANS "follow the
                // device", so honouring the user's rotation lock is the
                // point of the mode, and FULL_SENSOR already does that.
                "sensor"    -> android.content.pm.ActivityInfo.SCREEN_ORIENTATION_FULL_SENSOR
                else        -> android.content.pm.ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
            }
            activity.requestedOrientation = requested
            android.util.Log.d(
                TAG,
                "setOrientation('$mode') -> requestedOrientation=$requested (was ${activity.requestedOrientation})",
            )
        }
    }

    @ReactMethod
    @Override
    override fun setImmersive(enabled: Boolean) {
        val activity = getCurrentActivity() ?: return
        activity.runOnUiThread {
            val window = activity.window
            val controller = androidx.core.view.WindowInsetsControllerCompat(window, window.decorView)
            if (enabled) {
                androidx.core.view.WindowCompat.setDecorFitsSystemWindows(window, false)
                controller.hide(androidx.core.view.WindowInsetsCompat.Type.systemBars())
                controller.systemBarsBehavior =
                    androidx.core.view.WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            } else {
                androidx.core.view.WindowCompat.setDecorFitsSystemWindows(window, true)
                controller.show(androidx.core.view.WindowInsetsCompat.Type.systemBars())
                controller.systemBarsBehavior =
                    androidx.core.view.WindowInsetsControllerCompat.BEHAVIOR_DEFAULT
            }
        }
    }

    // ── Playback ──

    @ReactMethod
    @Override
    override fun play() {
        ensurePtr()
        Log.i(TAG, "[PlaybackTrace][Bridge][play] ptr=$nativePtr")
        MPVLib.nativePlay(nativePtr)
        Log.i(TAG, "[PlaybackTrace][Bridge][play] nativePlay returned")
    }

    @ReactMethod
    @Override
    override fun pause() {
        ensurePtr()
        Log.i(TAG, "[PlaybackTrace][Bridge][pause] ptr=$nativePtr")
        MPVLib.nativePause(nativePtr)
        Log.i(TAG, "[PlaybackTrace][Bridge][pause] nativePause returned")
    }

    @ReactMethod
    @Override
    override fun stop() {
        ensurePtr()
        Log.i(TAG, "[PlaybackTrace][Bridge][stop] ptr=$nativePtr")
        MPVLib.nativeStop(nativePtr)
    }

    @ReactMethod
    @Override
    override fun togglePlayPause() {
        ensurePtr()
        MPVLib.nativeTogglePlayPause(nativePtr)
    }

    @ReactMethod
    @Override
    override fun seekForward(seconds: Double) {
        ensurePtr()
        MPVLib.nativeSeekRelative(nativePtr, seconds)
    }

    @ReactMethod
    @Override
    override fun seekBackward(seconds: Double) {
        ensurePtr()
        MPVLib.nativeSeekRelative(nativePtr, -seconds)
    }

    @ReactMethod
    @Override
    override fun seekAbsolute(position: Double) {
        ensurePtr()
        Log.i(TAG, "[PlaybackTrace][Bridge][seekAbsolute] position=$position ptr=$nativePtr")
        MPVLib.nativeSeek(nativePtr, position)
    }

    @ReactMethod
    @Override
    override fun stepFrame(direction: Double) {
        ensurePtr()
        MPVLib.nativeStepFrame(nativePtr, direction.toInt())
    }

    @ReactMethod(isBlockingSynchronousMethod = true)
    @Override
    override fun screenshot(): String {
        ensurePtr()
        val tempFile = File(reactApplicationContext.cacheDir, "screenshot_temp.png")
        return MPVLib.nativeScreenshot(nativePtr, tempFile.absolutePath)
    }

    /**
     * Capture a thumbnail screenshot for a given file URI and save it to the
     * app's cache directory with a unique name derived from the URI hash.
     * Returns the absolute path to the saved thumbnail file.
     *
     * The thumbnail persists in cache and is used by the recent-files list to
     * show a preview of where the user left off.
     *
     * ## NAME WARNING — this is the LIVE-frame capture
     *
     * `captureThumbnail` reads as "thumbnail for this uri", but the `uri`
     * is used for NOTHING except hashing the output filename. The pixels
     * come from `MPVLib.nativeScreenshot(nativePtr, ...)`, i.e. whatever
     * the one initialised mpv handle is showing right now. So it:
     *  - requires `initPlayer()` to have run (`ensurePtr()`),
     *  - requires that something is actually loaded (pause counts, an
     *    empty player yields mpv's "no video" error string),
     *  - CANNOT target a position — there is no time argument.
     *
     * It is kept exactly as-is for backwards compatibility. Callers that
     * want "the frame at position X" — resume rails, scrub previews,
     * bookmark art — must use [captureFrame], which takes a timestamp
     * and needs no player instance at all.
     */
    @ReactMethod(isBlockingSynchronousMethod = true)
    @Override
    override fun captureThumbnail(uri: String): String {
        ensurePtr()
        val cacheDir = reactApplicationContext.cacheDir
        val hash = uri.hashCode().toLong() and 0x7FFFFFFF
        val thumbFile = File(cacheDir, "thumb_${hash}.png")
        return MPVLib.nativeScreenshot(nativePtr, thumbFile.absolutePath)
    }

    /**
     * Extract ONE frame at [positionMs] from [uri] and write it as a JPEG.
     * Resolves the absolute file path, or `null` when no frame exists.
     *
     * ## Why a separate method (not `captureThumbnail`)
     *
     * The "frame where the user left off" thumbnail cannot come from mpv:
     * `captureThumbnail` has no time argument, needs a live player, and
     * grabs the current surface (see its NAME WARNING above). Android's
     * standard API for "make a thumbnail from a data source" is
     * [MediaMetadataRetriever.getScaledFrameAtTime] — AOSP documents it as
     * "useful for generating a thumbnail for an input data source", it
     * accepts a local path or an http(s) URL (via range requests), and it
     * needs no decoder instance, no playback, and no surface. That is
     * exactly the Continue-Watching rail's requirement: many sources, no
     * player, one image each.
     *
     * ## Contract
     *
     *  - Resolves `null` — NEVER rejects — for every "no frame here" case:
     *    live/non-seekable stream, unsupported container, unreachable URL,
     *    position past the end of the media, no video track. `null` is the
     *    documented "no thumbnail, fall back to poster art" signal, so a
     *    consumer can render a placeholder with no `try`/`catch` and no
     *    blank `<Image>`.
     *  - Rejects ONLY on programmer error: `E_INVALID_URI` (blank uri) and
     *    `E_INVALID_POSITION` (NaN / Infinity / negative positionMs).
     *
     * ## Threading
     *
     * Validates synchronously (cheap, so the error reaches JS with the
     * same stack the caller wrote), then hands the real work to
     * [frameExecutor] — a single background thread. Opening a remote
     * source, seeking and JPEG-encoding is tens of ms; doing it inline
     * would stall the JS thread per rail item and risk an ANR when the
     * source is on the network.
     *
     * ## Output
     *
     * `filesDir/simba-resume-thumbs/frame_<hash>_<bucketMs>.jpg`. The
     * filename never contains the raw URI (a signed URL's `?`, `/` and `%`
     * would break the path), and the position is bucketed to 30s so a
     * drifting resume position overwrites one file instead of
     * accumulating near-duplicates.
     */
    @ReactMethod
    @Override
    override fun captureFrame(
        uri: String,
        positionMs: Double,
        options: ReadableMap?,
        promise: Promise,
    ) {
        if (uri.isBlank()) {
            Log.w(TAG, "[PlaybackTrace][Bridge][captureFrame] blank uri, rejecting with E_INVALID_URI")
            promise.reject("E_INVALID_URI", "captureFrame requires a non-empty uri")
            return
        }
        if (positionMs.isNaN() || positionMs.isInfinite() || positionMs < 0) {
            Log.w(
                TAG,
                "[PlaybackTrace][Bridge][captureFrame] invalid positionMs=$positionMs, rejecting with E_INVALID_POSITION",
            )
            promise.reject(
                "E_INVALID_POSITION",
                "captureFrame requires a finite, non-negative positionMs (got $positionMs)",
            )
            return
        }

        val width = readFrameOption(options, "width", DEFAULT_FRAME_WIDTH)
        val height = readFrameOption(options, "height", DEFAULT_FRAME_HEIGHT)
        val quality = readFrameOption(options, "quality", DEFAULT_FRAME_QUALITY).coerceIn(0, 100)
        val timeUs = (positionMs * 1000.0).toLong()

        try {
            frameExecutor.execute {
                promise.resolve(extractFrameToFile(uri, timeUs, width, height, quality))
            }
        } catch (e: RejectedExecutionException) {
            // The module was torn down between the JS call and this
            // dispatch. That is a lifecycle event, not a media error, so
            // it answers with the same "no thumbnail" result every
            // unavailable-frame case produces.
            Log.w(TAG, "[PlaybackTrace][Bridge][captureFrame] executor rejected: ${e.message}")
            promise.resolve(null)
        }
    }

    /**
     * The actual frame extraction, always on [frameExecutor]'s thread.
     * Returns the written JPEG's absolute path, or `null`.
     *
     * `release()` is in the `finally` and is NOT optional: an
     * unreleased `MediaMetadataRetriever` pins native codec/OMX handles
     * for the lifetime of the process, and a rail that extracts a frame
     * per item would leak one per item until the app died.
     */
    private fun extractFrameToFile(
        uri: String,
        timeUs: Long,
        width: Int,
        height: Int,
        quality: Int,
    ): String? {
        val retriever = MediaMetadataRetriever()
        var bitmap: Bitmap? = null
        try {
            applyFrameDataSource(retriever, uri)

            // A still frame needs a video track. This checks
            // `METADATA_KEY_HAS_VIDEO` ("yes"/"no"), NOT
            // `retriever.hasVideoTrack()` — that method does not exist on
            // MediaMetadataRetriever and the Kotlin compile gate (via the
            // example app) is what catches it. Audio-only and unsupported
            // containers answer "no" or throw; both land on the `null`
            // answer via the return below or the catch.
            val hasVideo =
                retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_HAS_VIDEO)
            if (hasVideo != null && hasVideo != "yes") {
                Log.w(TAG, "[PlaybackTrace][Bridge][captureFrame] no video track in $uri, no frame")
                return null
            }

            // Duration guard. A live stream reports no duration, in which
            // case we let the frame call below decide (it fails, and we
            // return null) rather than guessing.
            val durationMs =
                retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0L
            if (durationMs > 0 && timeUs > durationMs * 1000) {
                Log.w(
                    TAG,
                    "[PlaybackTrace][Bridge][captureFrame] position ${timeUs / 1000}ms is past " +
                        "duration ${durationMs}ms, no frame",
                )
                return null
            }

            val frame = scaledFrameAt(retriever, timeUs, width, height)
                ?: run {
                    Log.w(TAG, "[PlaybackTrace][Bridge][captureFrame] no frame at ${timeUs / 1000}ms in $uri")
                    return null
                }
            bitmap = frame

            val dir = File(reactApplicationContext.filesDir, RESUME_THUMB_DIR)
            if (!dir.exists() && !dir.mkdirs()) {
                Log.w(TAG, "[PlaybackTrace][Bridge][captureFrame] could not create $dir")
                return null
            }
            val outFile = File(dir, frameFileName(uri, timeUs / 1000))
            FileOutputStream(outFile).use { stream ->
                if (!frame.compress(Bitmap.CompressFormat.JPEG, quality, stream)) {
                    Log.w(TAG, "[PlaybackTrace][Bridge][captureFrame] JPEG encode failed for $outFile")
                    return null
                }
            }
            Log.i(
                TAG,
                "[PlaybackTrace][Bridge][captureFrame] wrote $outFile (${width}x$height q=$quality)",
            )
            return outFile.absolutePath
        } catch (e: Exception) {
            // Every media failure lands here: unreachable URL, malformed
            // container, decoder refusal on a non-seekable stream. All of
            // them are "no thumbnail", not an error the caller should see.
            Log.w(TAG, "[PlaybackTrace][Bridge][captureFrame] extraction failed for $uri: ${e.message}", e)
            return null
        } finally {
            bitmap?.recycle()
            retriever.release()
        }
    }

    /**
     * Point [retriever] at the right data source for [uri].
     *
     * Which overload is correct depends on the scheme, and picking the
     * wrong one fails at runtime rather than at compile time:
     *
     *  - `content://` needs `(Context, Uri)`, which resolves through the
     *    ContentResolver. Nothing else can open it.
     *  - `http(s)://` needs the plain `String` overload — THAT is the
     *    one that issues byte-range requests, which is what makes
     *    extracting a frame from a remote file feasible at all. The
     *    `(Context, Uri)` overload would route a network URL through the
     *    ContentResolver and fail.
     *
     * There is deliberately no `(Context, Uri, Map<String, String>)` call.
     * That overload's only purpose is to carry HTTP headers, and this
     * caller has none to send; adding it meant a bare `emptyMap()` whose
     * type argument could not be inferred, which made overload resolution
     * fall through to `setDataSource(FileDescriptor, long, long)` and
     * report three type mismatches about arguments that were never wrong.
     */
    private fun applyFrameDataSource(retriever: MediaMetadataRetriever, uri: String) {
        if (uri.startsWith("content://")) {
            retriever.setDataSource(reactApplicationContext, android.net.Uri.parse(uri))
            return
        }
        if (uri.startsWith("http://") || uri.startsWith("https://")) {
            retriever.setDataSource(uri)
            return
        }
        val path = if (uri.startsWith("file://")) android.net.Uri.parse(uri).path ?: uri else uri
        retriever.setDataSource(path)
    }

    /**
     * Frame grab with the platform's scaling API on API 27+, and an
     * explicit decode-then-scale below it (minSdk here is 24).
     *
     * `width`/`height` of 0 mean "unconstrained" — the platform then
     * keeps the source aspect ratio instead of forcing the frame into
     * the requested box, which is what a portrait source in a 16:9
     * default box needs.
     */
    private fun scaledFrameAt(
        retriever: MediaMetadataRetriever,
        timeUs: Long,
        width: Int,
        height: Int,
    ): Bitmap? {
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O_MR1) {
            return retriever.getScaledFrameAtTime(
                timeUs,
                MediaMetadataRetriever.OPTION_CLOSEST_SYNC,
                width,
                height,
            )
        }
        val full = retriever.getFrameAtTime(timeUs, MediaMetadataRetriever.OPTION_CLOSEST_SYNC)
            ?: return null
        if (width <= 0 && height <= 0) return full
        val targetH = if (height > 0) height else full.height
        val targetW = if (width > 0) {
            width
        } else {
            (full.width.toDouble() * targetH / full.height).toInt().coerceAtLeast(1)
        }
        if (targetW == full.width && targetH == full.height) return full
        return Bitmap.createScaledBitmap(full, targetW, targetH, true)
    }

    /**
     * `frame_<hash>_<bucketMs>.jpg` — same `hashCode() and 0x7FFFFFFF`
     * idiom [captureThumbnail] uses, so the two stay visually
     * consistent, plus the coarse position bucket.
     */
    private fun frameFileName(uri: String, positionMs: Long): String {
        val hash = uri.hashCode().toLong() and 0x7FFFFFFF
        val bucket = (positionMs / FRAME_POSITION_BUCKET_MS) * FRAME_POSITION_BUCKET_MS
        return "frame_${hash}_${bucket}.jpg"
    }

    /**
     * Read one integer-ish option out of the JS options map, falling back
     * to the default when the key is absent, null, not a number, or
     * negative. Never throws — a malformed option is a missing option.
     */
    private fun readFrameOption(options: ReadableMap?, key: String, fallback: Int): Int {
        if (options == null || !options.hasKey(key) || options.isNull(key)) return fallback
        return try {
            val value = options.getDouble(key)
            if (value.isNaN() || value.isInfinite() || value < 0) fallback else value.toInt()
        } catch (e: Exception) {
            Log.w(TAG, "[PlaybackTrace][Bridge][captureFrame] option '$key' is not a number: ${e.message}")
            fallback
        }
    }

    // ── File Loading ───────────────────────────────────────────────────────

    @ReactMethod
    @Override
    override fun loadFile(path: String) {
        ensurePtr()
        val resolvedPath = normalizeMpvInput(resolveContentUri(path))
        Log.i(TAG, "[PlaybackTrace][Bridge][loadFile] requested=$path resolved=$resolvedPath ptr=$nativePtr")
        try {
            MPVLib.nativeLoadFile(nativePtr, resolvedPath)
            Log.i(TAG, "[PlaybackTrace][Bridge][loadFile] nativeLoadFile returned")
        } catch (e: Exception) {
            Log.e(TAG, "[PlaybackTrace][Bridge][loadFile] nativeLoadFile threw: ${e.message}", e)
            throw e
        }
    }

    @ReactMethod
    @Override
    override fun loadFileWithRequestId(path: String, requestId: String) {
        ensurePtr()
        if (requestId.isBlank()) {
            loadFile(path)
            return
        }
        val resolvedPath = normalizeMpvInput(resolveContentUri(path))
        Log.i(TAG, "[PlaybackTrace][Bridge][loadFileWithRequestId] requested=$path resolved=$resolvedPath requestId=$requestId ptr=$nativePtr")
        try {
            MPVLib.nativeLoadFileWithRequestId(nativePtr, resolvedPath, requestId)
            Log.i(TAG, "[PlaybackTrace][Bridge][loadFileWithRequestId] nativeLoadFileWithRequestId returned requestId=$requestId")
        } catch (e: Exception) {
            Log.e(TAG, "[PlaybackTrace][Bridge][loadFileWithRequestId] failed: ${e.message}", e)
            throw e
        }
    }

    /**
     * Grant persistable URI permission for a content:// URI so it survives
     * app restarts and device reboots.
     *
     * We only request READ permission because we never write to user files.
     * Requesting WRITE when the picker only granted READ causes a
     * SecurityException that silently fails the entire grant, leaving the
     * URI inaccessible after restart.
     */
    @ReactMethod
    @Override
    override fun grantPersistablePermission(uri: String) {
        try {
            val contentUri = android.net.Uri.parse(uri)
            val takeFlags = Intent.FLAG_GRANT_READ_URI_PERMISSION
            reactApplicationContext.contentResolver
                .takePersistableUriPermission(contentUri, takeFlags)
            Log.i(TAG, "Persistable read permission granted for: $uri")
        } catch (e: SecurityException) {
            Log.e(TAG, "Persistable permission DENIED for $uri: ${e.message}")
        } catch (e: Exception) {
            Log.w(TAG, "Could not grant persistable permission for $uri: ${e.message}")
        }
    }

    /**
     * Verify that a content:// URI is still accessible (returns true/false).
     * This is used by JS to check whether a recent-file entry with a content://
     * URI is still valid — it tries to open the URI via ContentResolver and
     * checks if it returns a valid file descriptor.
     *
     * Returns false if the file was deleted or the persistable permission was
     * revoked (e.g. after app data clear or OS-level permission reset).
     */
    @ReactMethod(isBlockingSynchronousMethod = true)
    @Override
    override fun verifyContentUri(uri: String): Boolean {
        if (!uri.startsWith("content://")) return true // non-content URIs assumed valid
        return try {
            val context = reactApplicationContext
            val contentUri = android.net.Uri.parse(uri)
            val parcelFd = context.contentResolver.openFileDescriptor(contentUri, "r")
            if (parcelFd != null) {
                parcelFd.close()
                true
            } else {
                false
            }
        } catch (e: Exception) {
            Log.w(TAG, "verifyContentUri FAILED for $uri: ${e.message}")
            false
        }
    }

    /**
     * Resolve a content:// URI to an fd://N path so MPV can read it directly
     * from the original file without copying to cache.
     *
     * Uses Android's ContentResolver to open the content URI, extracts the raw
     * file descriptor, and returns "fd://<N>" for MPV's built-in fd:// protocol.
     * MPV closes the fd automatically when playback ends.
     */
    private fun normalizeMpvInput(uri: String): String {
        if (!uri.startsWith("http://") && !uri.startsWith("https://")) return uri
        // Archive and other API providers occasionally return raw spaces in
        // path segments. libmpv's curl backend rejects those as an illegal
        // URL, so encode only whitespace/control characters and preserve
        // already-escaped URLs and valid query delimiters.
        return uri
            .replace(" ", "%20")
            .replace("\t", "%09")
            .replace("\r", "%0D")
            .replace("\n", "%0A")
    }

    private fun resolveContentUri(uri: String): String {
        if (!uri.startsWith("content://")) return uri
        try {
            val context = reactApplicationContext
            val contentUri = android.net.Uri.parse(uri)
            val parcelFd = context.contentResolver.openFileDescriptor(contentUri, "r")
                ?: return uri
            val fd = parcelFd.detachFd()
            val fdUri = "fd://$fd"
            Log.i(TAG, "Resolved content:// URI to $fdUri")
            return fdUri
        } catch (e: Exception) {
            Log.e(TAG, "Failed to resolve content:// URI: ${e.message}")
            return uri
        }
    }

    @ReactMethod
    @Override
    override fun loadPlaylist(paths: ReadableArray, startIndex: Double) {
        ensurePtr()
        val arr = Array(paths.size()) { i ->
            normalizeMpvInput(resolveContentUri(paths.getString(i) ?: ""))
        }
        MPVLib.nativeLoadPlaylist(nativePtr, arr, startIndex.toInt())
    }

    @ReactMethod(isBlockingSynchronousMethod = true)
    @Override
    override fun getFileInfo(): String {
        ensurePtr()
        return JSONObject().apply {
            put("path", try { MPVLib.nativeGetProperty(nativePtr, "path") } catch (_: Exception) { "" })
            put("title", try { MPVLib.nativeGetProperty(nativePtr, "media-title") } catch (_: Exception) { "" })
            put("duration", getDuration())
        }.toString()
    }

    @ReactMethod(isBlockingSynchronousMethod = true)
    @Override
    override fun getVideoParams(): String {
        ensurePtr()
        val w = try { MPVLib.nativeGetProperty(nativePtr, "width") } catch (_: Exception) { "0" }
        val h = try { MPVLib.nativeGetProperty(nativePtr, "height") } catch (_: Exception) { "0" }
        val fps = try { MPVLib.nativeGetProperty(nativePtr, "estimated-vf-fps") } catch (_: Exception) { "0" }
        val codec = try { MPVLib.nativeGetProperty(nativePtr, "video-codec") } catch (_: Exception) { "" }
        return JSONObject().apply {
            put("videoWidth", w.toDoubleOrNull() ?: 0.0)
            put("videoHeight", h.toDoubleOrNull() ?: 0.0)
            put("aspectRatio", if (h.toDoubleOrNull() ?: 0.0 > 0)
                (w.toDoubleOrNull() ?: 1.0) / (h.toDoubleOrNull() ?: 1.0) else 1.0)
            put("fps", fps.toDoubleOrNull() ?: 0.0)
            put("codec", codec.trim('"'))
        }.toString()
    }

    // ── Tracks ─────────────────────────────────────────────────────────────

    @ReactMethod(isBlockingSynchronousMethod = true)
    @Override
    override fun getTracks(): String {
        ensurePtr()
        return try {
            MPVLib.nativeGetProperty(nativePtr, "track-list")
        } catch (_: Exception) { "[]" }
    }

    /**
     * `selectTrack(trackId)` was REMOVED. It carried no track type, and its
     * native implementation hardcoded mpv's "vid" property, so selecting a
     * subtitle retargeted the VIDEO track. Use `setTrack(type, trackId)`
     * instead — it maps video/audio/sub to vid/aid/sid and handles disabling
     * via a negative id.
     */
    @ReactMethod
    @Override
    override fun setTrack(type: String, trackId: Double) {
        ensurePtr()
        val prop = when (type) {
            "video" -> "vid"
            "audio" -> "aid"
            "sub" -> "sid"
            else -> return
        }
        val id = trackId.toInt()
        val value = if (id < 0) "no" else id.toString()
        MPVLib.setPropertyString(nativePtr, prop, value)
    }

    @ReactMethod
    @Override
    override fun cycleTrack(type: String) {
        ensurePtr()
        when (type) {
            "video" -> MPVLib.nativeSetProperty(nativePtr, "cycle", "\"video\"")
            "audio" -> MPVLib.nativeSetProperty(nativePtr, "cycle", "\"audio\"")
            "sub"   -> MPVLib.nativeSetProperty(nativePtr, "cycle", "\"sub\"")
        }
    }

    @ReactMethod
    @Override
    override fun setTrackVisibility(trackType: String, visible: Boolean) {
        // No-op: mpv handles track visibility automatically
    }

    // ── Chapters ───────────────────────────────────────────────────────────

    @ReactMethod(isBlockingSynchronousMethod = true)
    @Override
    override fun getChapters(): String {
        ensurePtr()
        return try {
            MPVLib.nativeGetProperty(nativePtr, "chapter-list")
        } catch (_: Exception) { "[]" }
    }

    @ReactMethod
    @Override
    override fun seekChapter(direction: Double) {
        ensurePtr()
        if (direction > 0) {
            MPVLib.nativeSetProperty(nativePtr, "chapter", "1")
        } else {
            MPVLib.nativeSetProperty(nativePtr, "chapter", "-1")
        }
    }

    @ReactMethod(isBlockingSynchronousMethod = true)
    @Override
    override fun getCurrentChapter(): String {
        ensurePtr()
        return try {
            MPVLib.nativeGetProperty(nativePtr, "chapter-metadata")
        } catch (_: Exception) { "{}" }
    }

    // ── Volume / Audio ─────────────────────────────────────────────────────

    @ReactMethod
    @Override
    override fun setVolume(volume: Double) {
        ensurePtr()
        Log.i(TAG, "[PlaybackTrace][Bridge][setVolume] volume=$volume ptr=$nativePtr")
        MPVLib.nativeSetVolume(nativePtr, volume)
    }

    @ReactMethod(isBlockingSynchronousMethod = true)
    @Override
    override fun getVolume(): Double {
        ensurePtr()
        return MPVLib.nativeGetVolume(nativePtr)
    }

    @ReactMethod
    @Override
    override fun setMuted(muted: Boolean) {
        ensurePtr()
        MPVLib.nativeSetMuted(nativePtr, muted)
    }

    @ReactMethod(isBlockingSynchronousMethod = true)
    @Override
    override fun getMuted(): Boolean {
        ensurePtr()
        return MPVLib.nativeGetMuted(nativePtr)
    }

    @ReactMethod(isBlockingSynchronousMethod = true)
    @Override
    override fun getAudioDevices(): String {
        ensurePtr()
        return try {
            val devices = MPVLib.nativeGetProperty(nativePtr, "audio-device-list")
            Log.i(TAG, "[PlaybackTrace][Bridge][getAudioDevices] $devices")
            devices
        } catch (e: Exception) {
            Log.e(TAG, "[PlaybackTrace][Bridge][getAudioDevices] failed: ${e.message}", e)
            "[]"
        }
    }

    @ReactMethod
    @Override
    override fun setAudioDevice(deviceName: String) {
        ensurePtr()
        Log.i(TAG, "[PlaybackTrace][Bridge][setAudioDevice] device=$deviceName ptr=$nativePtr")
        MPVLib.nativeSetProperty(nativePtr, "audio-device", "\"$deviceName\"")
    }

    /**
     * V16.0.6 / D-032 / B-010 proper fix — `toggleMute()` is an abstract
     * method on the codegen-generated `NativeMpvPlayerSpec` (1.5.5), so the
     * Kotlin class MUST override it to satisfy the new-arch TurboModule
     * contract. The lib's public surface previously went through
     * `setMuted(!getMuted())` instead; this is the spec-compliant single
     * primitive.
     *
     * Reads the current `nativeGetMuted` value, flips it, and writes back
     * via `nativeSetMuted`. Both helpers already exist on MPVLib; we don't
     * need to talk to mpv via raw `nativeSetProperty` strings.
     */
    @ReactMethod
    @Override
    override fun toggleMute() {
        ensurePtr()
        val currentlyMuted = MPVLib.nativeGetMuted(nativePtr)
        val nextMuted = !currentlyMuted
        MPVLib.nativeSetMuted(nativePtr, nextMuted)
        Log.i(
            TAG,
            "[PlaybackTrace][Bridge][toggleMute] flipped mute $currentlyMuted → $nextMuted",
        )
    }

    // ── Playback Speed ─────────────────────────────────────────────────────

    @ReactMethod
    @Override
    override fun setSpeed(speed: Double) {
        ensurePtr()
        MPVLib.nativeSetSpeed(nativePtr, speed)
    }

    @ReactMethod(isBlockingSynchronousMethod = true)
    @Override
    override fun getSpeed(): Double {
        ensurePtr()
        return MPVLib.nativeGetSpeed(nativePtr)
    }

    // ── Loop / Repeat ──────────────────────────────────────────────────────

    @ReactMethod
    @Override
    override fun setLoopMode(mode: String) {
        ensurePtr()
        val m = when (mode) {
            "file"     -> 1
            "playlist" -> 2
            else       -> 0
        }
        MPVLib.nativeSetLoopMode(nativePtr, m)
    }

    @ReactMethod(isBlockingSynchronousMethod = true)
    @Override
    override fun getLoopMode(): String {
        ensurePtr()
        return when (MPVLib.nativeGetLoopMode(nativePtr)) {
            1 -> "file"
            2 -> "playlist"
            else -> "none"
        }
    }

    @ReactMethod
    @Override
    override fun setPlaylistLoop(loop: Boolean) {
        ensurePtr()
        MPVLib.nativeSetLoopMode(nativePtr, if (loop) 2 else 0)
    }

    // ── Properties ─────────────────────────────────────────────────────────

    @ReactMethod(isBlockingSynchronousMethod = true)
    @Override
    override fun getProperty(name: String): String {
        ensurePtr()
        return MPVLib.nativeGetProperty(nativePtr, name)
    }

    @ReactMethod
    @Override
    override fun setProperty(name: String, value: String) {
        ensurePtr()
        MPVLib.nativeSetProperty(nativePtr, name, value)
    }

    @ReactMethod
    @Override
    override fun observeProperty(name: String) {
        if (name.isBlank()) return
        Log.i(TAG, "[PlaybackTrace][Bridge][observeProperty] name=$name initialized=${nativePtr != 0L}")
        pendingObservedProperties.add(name)
        if (nativePtr == 0L) {
            Log.i(TAG, "Queued property observer '$name' until initPlayer()")
            return
        }
        try {
            MPVLib.nativeObserveProperty(nativePtr, name)
        } catch (e: Exception) {
            Log.w(TAG, "observeProperty('$name') failed: ${e.message}")
        }
    }

    @ReactMethod
    @Override
    override fun unobserveProperty(name: String) {
        pendingObservedProperties.remove(name)
        if (nativePtr == 0L) return
        try {
            MPVLib.nativeUnobserveProperty(nativePtr, name)
        } catch (e: Exception) {
            Log.w(TAG, "unobserveProperty('$name') failed: ${e.message}")
        }
    }

    // ── Video/Audio Filters ────────────────────────────────────────────────

    @ReactMethod
    @Override
    override fun setVideoFilter(filter: String, enabled: Boolean) {
        ensurePtr()
        MPVLib.nativeSetVideoFilter(nativePtr, filter, enabled)
    }

    @ReactMethod
    @Override
    override fun setAudioFilter(filter: String, enabled: Boolean) {
        ensurePtr()
        MPVLib.nativeSetAudioFilter(nativePtr, filter, enabled)
    }

    // ── Playlist ───────────────────────────────────────────────────────────

    @ReactMethod(isBlockingSynchronousMethod = true)
    @Override
    override fun getPlaylist(): String {
        ensurePtr()
        return try {
            MPVLib.nativeGetProperty(nativePtr, "playlist")
        } catch (_: Exception) { "[]" }
    }

    @ReactMethod
    @Override
    override fun playlistNext() {
        ensurePtr()
        MPVLib.nativePlaylistNext(nativePtr)
    }

    @ReactMethod
    @Override
    override fun playlistPrev() {
        ensurePtr()
        MPVLib.nativePlaylistPrev(nativePtr)
    }

    @ReactMethod
    @Override
    override fun playlistRemove(index: Double) {
        ensurePtr()
        MPVLib.nativePlaylistRemove(nativePtr, index.toInt())
    }

    @ReactMethod
    @Override
    override fun playlistShuffle() {
        ensurePtr()
        MPVLib.nativePlaylistShuffle(nativePtr)
    }

    @ReactMethod
    @Override
    override fun playlistClear() {
        ensurePtr()
        MPVLib.nativePlaylistClear(nativePtr)
    }

    // ── State Queries ──────────────────────────────────────────────────────

    @ReactMethod(isBlockingSynchronousMethod = true)
    @Override
    override fun getPosition(): Double {
        val position = if (nativePtr != 0L) MPVLib.nativeGetPosition(nativePtr) else 0.0
        Log.d(TAG, "[PlaybackTrace][Bridge][getPosition] ptr=$nativePtr position=$position")
        return position
    }

    @ReactMethod(isBlockingSynchronousMethod = true)
    @Override
    override fun getDuration(): Double {
        val duration = if (nativePtr != 0L) MPVLib.nativeGetDuration(nativePtr) else 0.0
        Log.d(TAG, "[PlaybackTrace][Bridge][getDuration] ptr=$nativePtr duration=$duration")
        return duration
    }

    @ReactMethod(isBlockingSynchronousMethod = true)
    @Override
    override fun getPlaybackState(): String {
        if (nativePtr == 0L) {
            Log.d(TAG, "[PlaybackTrace][Bridge][getPlaybackState] ptr=0 state=idle")
            return "idle"
        }
        return try {
            val idle = MPVLib.nativeGetProperty(nativePtr, "idle-active")
                .trim('"').toBoolean()
            if (idle) {
                Log.d(TAG, "[PlaybackTrace][Bridge][getPlaybackState] ptr=$nativePtr state=idle idle=true")
                return "idle"
            }

            val ended = MPVLib.nativeGetProperty(nativePtr, "eof-reached")
                .trim('"').toBoolean()
            if (ended) {
                Log.d(TAG, "[PlaybackTrace][Bridge][getPlaybackState] ptr=$nativePtr state=stopped eof=true")
                return "stopped"
            }

            val paused = MPVLib.nativeGetProperty(nativePtr, "pause")
                .trim('"').toBoolean()
            val state = if (paused) "paused" else "playing"
            Log.d(TAG, "[PlaybackTrace][Bridge][getPlaybackState] ptr=$nativePtr state=$state idle=$idle eof=$ended pause=$paused")
            state
        } catch (e: Exception) {
            Log.e(TAG, "[PlaybackTrace][Bridge][getPlaybackState] failed: ${e.message}", e)
            "idle"
        }
    }

    @ReactMethod(isBlockingSynchronousMethod = true)
    @Override
    override fun isMuted(): Boolean {
        return if (nativePtr != 0L) MPVLib.nativeGetMuted(nativePtr) else false
    }

    // V22.0.0 / 1.5.10 (D-034): activity-aware launchParams guard.
    //
    // Returns true while PlayerActivity is the foreground React host,
    // false otherwise (MainActivity foreground, no React host, or
    // about to attach). Mirrors the static
    // `MpvBridgeModule.currentActivityIsPlayer` which PlayerActivity
    // toggles in onCreate/onDestroy.
    //
    // Why a static companion flag rather than `getCurrentActivity()
    // is PlayerActivity`: in `newArchEnabled=true` bridgeless mode,
    // `getCurrentActivity()` can return null mid-attach (RN hasn't
    // finished initializing), and the JS render path needs an
    // authoritative answer the instant MainActivity's React tree
    // mounts. The static flag set in `Activity.onCreate` (before
    // React even renders) is always authoritative.
    @ReactMethod(isBlockingSynchronousMethod = true)
    @Override
    override fun isCurrentActivityPlayer(): Boolean {
        return currentActivityIsPlayer
    }

    // ── Lifecycle ──────────────────────────────────────────────────────────

    private fun prepareMpvCaBundle(): String {
        val target = File(reactApplicationContext.filesDir, "mpv/cacert.pem")
        return try {
            if (!target.exists() || target.length() < 1024L) {
                target.parentFile?.mkdirs()
                reactApplicationContext.assets.open("mpv/cacert.pem").use { input ->
                    target.outputStream().use { output -> input.copyTo(output) }
                }
            }
            Log.i(TAG, "[PlaybackTrace][Bridge][tls] caFile=${target.absolutePath} bytes=${target.length()}")
            target.absolutePath
        } catch (error: Exception) {
            Log.e(TAG, "[PlaybackTrace][Bridge][tls] failed to prepare CA bundle: ${error.message}", error)
            ""
        }
    }

    @ReactMethod(isBlockingSynchronousMethod = true)
    @Override
    override fun initPlayer(): Boolean {
        Log.i(TAG, "[PlaybackTrace][Bridge][initPlayer] call currentPtr=$nativePtr")
        if (nativePtr != 0L) {
            Log.w(TAG, "[PlaybackTrace][Bridge][initPlayer] Already initialized ptr=$nativePtr")
            return true
        }
        val caFilePath = prepareMpvCaBundle()
        nativePtr = MPVLib.nativeCreate(caFilePath)
        Log.i(TAG, "[PlaybackTrace][Bridge][initPlayer] nativeCreate returned ptr=$nativePtr")
        if (nativePtr == 0L) {
            Log.e(TAG, "Failed to create mpv instance")
            return false
        }
        pendingObservedProperties.forEach { property ->
            try {
                MPVLib.nativeObserveProperty(nativePtr, property)
            } catch (e: Exception) {
                Log.w(TAG, "Deferred observeProperty('$property') failed: ${e.message}")
            }
        }
        Log.i(TAG, "mpv initialized, nativePtr=$nativePtr, observers=${pendingObservedProperties.size}")
        return true

    }

    @ReactMethod
    @Override
    override fun destroy() {
        if (nativePtr != 0L) {
            MPVLib.nativeDestroy()
            nativePtr = 0L
            Log.i(TAG, "mpv destroyed")
        }
    }

    // ── Phase 39: logging & debug mode (spec §39) ──────────────────────
    /**
     * Toggle verbose native logging. When enabled:
     *  - mpv's msg-level is set to "all" (every log line forwarded)
     *  - The bridge emits `onLog` events to JS for every mpv log message
     *  - A `[MpvLib]` logcat tag is set on the mpv log receiver
     *
     * When disabled (default):
     *  - mpv's msg-level is set to "info" (only informational and above)
     *  - No `onLog` events emitted
     *
     * The toggle is idempotent — calling with the current value is a no-op.
     */
    @ReactMethod
    @Override
    override fun setDebugLogging(enabled: Boolean) {
        debugLoggingEnabled = enabled
        if (nativePtr != 0L) {
            try {
                MPVLib.setPropertyString(nativePtr, "msg-level", if (enabled) "all" else "info")
                Log.i(TAG, "[PlaybackTrace][Bridge][setDebugLogging] enabled=$enabled (mpv msg-level=${if (enabled) "all" else "info"})")
            } catch (e: Exception) {
                Log.w(TAG, "[PlaybackTrace][Bridge][setDebugLogging] setPropertyString failed: ${e.message}", e)
            }
        }
    }

    /**
     * Phase 39: dump all currently-observed mpv properties to logcat.
     * Returns the count of properties dumped (for test verification).
     *
     * Format:
     *   [dumpProperties] property=time-pos value="123.456" requested=true
     *   [dumpProperties] property=duration value="600" requested=true
     *   ...
     */
    @ReactMethod(isBlockingSynchronousMethod = true)
    @Override
    override fun dumpObservedProperties(): Double {
        val count = pendingObservedProperties.size
        Log.i(TAG, "[PlaybackTrace][Bridge][dumpObservedProperties] $count properties observed:")
        pendingObservedProperties.sorted().forEach { name ->
            val value: String? = try {
                if (nativePtr != 0L) MPVLib.nativeGetProperty(nativePtr, name) else null
            } catch (e: Exception) {
                "<nativeGetProperty failed: ${e.message}>"
            }
            Log.i(TAG, "[PlaybackTrace][Bridge][dumpProperties] property=$name value=\"$value\" requested=true")
        }
        return count.toDouble()
    }

    /**
     * Phase 39 + Phase 38.7: react to system memory pressure by reducing
     * mpv's cache. Registered as a ComponentCallbacks2 listener in
     * PlayerActivity.onCreate; called by the system when the process
     * is at a trim level.
     *
     * Levels:
     *  - TRIM_MEMORY_RUNNING_MODERATE (5)  → cache-secs=10
     *  - TRIM_MEMORY_RUNNING_LOW (10)      → cache-secs=5
     *  - TRIM_MEMORY_RUNNING_CRITICAL (15) → cache-secs=2
     *  - TRIM_MEMORY_BACKGROUND (40)       → cache-secs=10
     *  - TRIM_MEMORY_COMPLETE (80)         → cache-secs=0
     *
     * Public so PlayerActivity can register the listener (it has the
     * Application context for ComponentCallbacks2 registration).
     */
    fun onTrimMemory(level: Int) {
        if (nativePtr == 0L) return
        val cacheSecs: Int = when (level) {
            android.content.ComponentCallbacks2.TRIM_MEMORY_RUNNING_MODERATE -> 10
            android.content.ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW -> 5
            android.content.ComponentCallbacks2.TRIM_MEMORY_RUNNING_CRITICAL -> 2
            android.content.ComponentCallbacks2.TRIM_MEMORY_BACKGROUND -> 10
            android.content.ComponentCallbacks2.TRIM_MEMORY_COMPLETE -> 0
            else -> return  // unknown level — no change
        }
        try {
            MPVLib.setPropertyString(nativePtr, "cache-secs", cacheSecs.toString())
            Log.w(TAG, "[PlaybackTrace][Bridge][onTrimMemory] level=$level → cache-secs=$cacheSecs")
        } catch (e: Exception) {
            Log.w(TAG, "[PlaybackTrace][Bridge][onTrimMemory] setPropertyString failed: ${e.message}", e)
        }
    }

    @ReactMethod
    fun addListener(eventName: String) {
        // Required by NativeEventEmitter. MPVLib listener registration is
        // owned by initialize()/onCatalystInstanceDestroy(), not JS callers.
    }

    @ReactMethod
    fun removeListeners(count: Double) {
        // Required by NativeEventEmitter. Keep the native listener attached
        // for the lifetime of this module instance.
    }

    override fun initialize() {
        super.initialize()
        MPVLib.addListener(mpvListener)
        // Phase 39: native module init logging. Logs the key
        // properties of the bridge on init so dev tools can confirm
        // the module is wired + report version/build info. Use
        // `adb logcat -s MpvBridgeModule` to see the line.
        Log.i(
            TAG,
            "[PlaybackTrace][Bridge][initialize] MpvPlayerModule v0.1.0 init: " +
                "package=${reactApplicationContext.packageName} " +
                "debugLogging=$debugLoggingEnabled",
        )
    }

    override fun onCatalystInstanceDestroy() {
        destroy()
        MPVLib.removeListener(mpvListener)
        // Phase 36: clear the static ReactApplicationContext reference so the
        // bridge context can be reclaimed. Companion-level static fields hold
        // the only strong reference to the React context across reloads;
        // without this clear the previous context leaks forever (the new
        // module instance overwrites `instance` but the old context is still
        // pinned until the new instance is created — which can be minutes
        // apart during dev reload, or never on release builds).
        instance = null
        pendingObservedProperties.clear()
        // `frameExecutor` (captureFrame) is per-instance, so without this
        // a debug reload leaves an idle "simba-frame-extractor" thread
        // behind for every module instance the app has ever built.
        // Queued-but-unstarted tasks are dropped; an in-flight
        // extraction finishes and its (now-unused) retriever releases
        // itself in its own `finally`.
        frameExecutor.shutdown()
        super.onCatalystInstanceDestroy()
    }

    // ── PlayerActivity Launch (V12 Phase 3 + Phase 11) ─────────────────────
    // Hands off to the dedicated `com.simba.player.PlayerActivity` (which
    // lives in the `@simba/react-native-media-player` library module and
    // therefore cannot be referenced directly from this app-side class —
    // we go through the fully-qualified name on the Intent target).
    //
    // The `type` extra is the key new piece in Phase 11: it tells
    // PlayerActivity which rendering path to take. `"video"` mounts the
    // SurfaceView; `"audio"` will hide it (Phase 12) and surface an
    // audio-only UI (Phase 13). PlayerActivity.EXTRA_* / TYPE_* constants
    // are mirrored into the intent extras here so PlayerActivity can read
    // them back in `onCreate` via its `by lazy {}` launch params.
    //
    // Reject codes (matched by the TS Spec's `E_*` contract in
    // NativeMpvPlayer.ts):
    //   • E_INVALID_TYPE           — `type` is neither "video" nor "audio"
    //   • E_AUDIO_REQUIRES_SERVICE — `type` IS "audio". V20 Phase C
    //     narrowed this method to video only. Audio is no longer forced
    //     into a window it has nothing to draw in; it goes through
    //     [startAudioPlayback], which starts the media service with no
    //     Activity at all. Rejecting rather than quietly still opening an
    //     Activity is deliberate: a stale JS bundle sending "audio" here
    //     gets a named, greppable failure instead of a full-screen blank
    //     player with no notification and no media keys.
    //   • E_NO_ACTIVITY            — no current activity (RN bridge down)
    //   • E_ACTIVITY_NOT_FOUND     — PlayerActivity not declared in manifest
    //   • E_SECURITY               — manifest restriction refused the launch
    //   • E_OPEN_PLAYER_FAILED     — anything else (e.g. flag mismatch)
    @ReactMethod
    @Override
    override fun openPlayer(
        uri: String,
        title: String,
        type: String,
        startPositionMs: Double,
        promise: Promise,
    ) {
        // V20 Phase C: audio no longer belongs here. See the docblock.
        if (type == com.simba.player.PlayerActivity.TYPE_AUDIO) {
            Log.w(TAG, "[PlaybackTrace][Bridge][openPlayer] type='audio' is no longer a window launch, rejecting E_AUDIO_REQUIRES_SERVICE")
            promise.reject(
                "E_AUDIO_REQUIRES_SERVICE",
                "openPlayer is video-only as of 1.13.0; audio must use startAudioPlayback() so it does not need a window",
            )
            return
        }
        // 3.3: validate `type` — defensive against the JS layer ever
        // passing a typo (the TS Spec already types it as the union
        // `'video' | 'audio'`, but a stale bundle could skip the check).
        if (type != com.simba.player.PlayerActivity.TYPE_VIDEO) {
            Log.w(TAG, "[PlaybackTrace][Bridge][openPlayer] invalid type='$type', rejecting with E_INVALID_TYPE")
            promise.reject("E_INVALID_TYPE", "type must be 'video', got '$type'")
            return
        }
        // 3.4: require a current activity. In bridgeless RN this is null
        // before the first activity attaches, after the last activity
        // detaches, or in headless contexts. Without an activity we
        // cannot launch PlayerActivity.
        val activity = getCurrentActivity() ?: run {
            Log.w(TAG, "[PlaybackTrace][Bridge][openPlayer] no current activity, rejecting with E_NO_ACTIVITY")
            promise.reject("E_NO_ACTIVITY", "no current activity available to launch PlayerActivity")
            return
        }
        // 3.5: build the intent. Title falls back to the URI when blank
        // so the notification / lock-screen widget always has a display
        // string. We use FLAG_ACTIVITY_NEW_TASK because we are launching
        // from a non-Activity context (the bridge runs in the React
        // context's main looper; the startActivity call is technically
        // from the activity, but the flag is harmless and makes the
        // intent correct if the activity is ever swapped for a
        // background-launched one).
        val resolvedTitle = title.takeIf { it.isNotBlank() } ?: uri
        val intent = android.content.Intent(
            activity,
            com.simba.player.PlayerActivity::class.java,
        ).apply {
            putExtra(com.simba.player.PlayerActivity.EXTRA_URI, uri)
            putExtra(com.simba.player.PlayerActivity.EXTRA_TITLE, resolvedTitle)
            putExtra(com.simba.player.PlayerActivity.EXTRA_TYPE, type)
            putExtra(
                com.simba.player.PlayerActivity.EXTRA_START_POSITION_MS,
                startPositionMs.toLong(),
            )
        }
        // 3.6: launch + 3.7: catch the three documented failure modes
        // plus a generic catch-all. The order matters: ActivityNotFound
        // and SecurityException are subclasses of each other on some
        // OEMs, so we check the more specific one first.
        try {
            // Phase 13: cache the resolved launch params in the
            // companion so the JS layer inside the launched
            // PlayerActivity can read them back via
            // [getLaunchParams] on mount (the launched activity's
            // JS context is fresh — it doesn't have the
            // PlaybackContext state from MainActivity, so we
            // have to ship the params through the bridge).
            lastLaunchParams = LaunchParams(uri, resolvedTitle, type, startPositionMs.toLong())
            activity.startActivity(intent)
            Log.i(
                TAG,
                "[PlaybackTrace][Bridge][openPlayer] launched PlayerActivity uri='$uri' type='$type' startMs=${startPositionMs.toLong()}",
            )
            promise.resolve(true)
        } catch (e: android.content.ActivityNotFoundException) {
            Log.w(TAG, "[PlaybackTrace][Bridge][openPlayer] PlayerActivity not found: ${e.message}")
            emitErrorEvent("E_ACTIVITY_NOT_FOUND", "PlayerActivity is not declared in the manifest", e)
            promise.reject("E_ACTIVITY_NOT_FOUND", "PlayerActivity is not declared in the manifest", e)
        } catch (e: SecurityException) {
            Log.w(TAG, "[PlaybackTrace][Bridge][openPlayer] security refusal: ${e.message}")
            emitErrorEvent("E_SECURITY", "Manifest restriction refused PlayerActivity launch", e)
            promise.reject("E_SECURITY", "Manifest restriction refused PlayerActivity launch", e)
        } catch (e: Throwable) {
            Log.e(TAG, "[PlaybackTrace][Bridge][openPlayer] launch failed", e)
            emitErrorEvent("E_OPEN_PLAYER_FAILED", e.message ?: "openPlayer failed", e)
            promise.reject("E_OPEN_PLAYER_FAILED", e.message ?: "openPlayer failed", e)
        }
    }

    // ── Audio playback without an Activity (V20 Phase C) ────────────────────
    // The primitive that makes the mini player possible.
    //
    // Until now the only way to start `MediaPlaybackService` was
    // `PlayerActivity.onCreate`. So the media session, the notification
    // and media-key routing existed only while a window was open, and
    // audio was forced into a full-screen Activity purely to get the
    // service running. That is an Activity used as a launcher for
    // something it does not draw — audio has no surface, no PiP
    // requirement, and nothing to show in a window.
    //
    // So this method does, natively and in this order:
    //
    //   1. engine   ensure a handle, load the file, seek, play
    //   2. service  startForegroundService with the media metadata
    //
    // Engine first is the whole design. The service builds its
    // notification out of the engine's `duration` / `time-pos`, so
    // loading first means the notification is right on its first frame
    // rather than being visibly corrected a second later. Doing this as
    // two JS round-trips would leave a real gap where the file is
    // loaded and playing but nothing owns it: audio with no
    // notification, no media keys, and no session — which is exactly
    // the defect class this whole phase set out to remove.
    //
    // No Activity is required. `reactApplicationContext` outlives every
    // window, which is the same reason the engine itself is a
    // process-global rather than an Activity field.

    @ReactMethod
    @Override
    override fun startAudioPlayback(options: ReadableMap?, promise: Promise) {
        val uri = optString(options, "uri").orEmpty()
        if (uri.isBlank()) {
            Log.w(TAG, "[PlaybackTrace][Bridge][startAudioPlayback] blank uri, rejecting E_INVALID_URI")
            promise.reject("E_INVALID_URI", "options.uri is required")
            return
        }

        // `ensurePtr` throws; a Promise caller needs a named code, not a
        // bridge-level exception with no rejection. Create the engine if
        // JS has not already done so — a cold start can legitimately
        // reach audio before anything called `initPlayer()`.
        if (nativePtr == 0L && !initPlayer()) {
            Log.e(TAG, "[PlaybackTrace][Bridge][startAudioPlayback] no engine handle, rejecting E_ENGINE_UNAVAILABLE")
            promise.reject("E_ENGINE_UNAVAILABLE", "libmpv instance unavailable; initPlayer() returned false")
            return
        }
        val handle = nativePtr
        if (handle == 0L) {
            Log.e(TAG, "[PlaybackTrace][Bridge][startAudioPlayback] handle still zero after init, rejecting E_ENGINE_UNAVAILABLE")
            promise.reject("E_ENGINE_UNAVAILABLE", "libmpv instance unavailable; handle is zero")
            return
        }

        val resolvedPath = normalizeMpvInput(resolveContentUri(uri))
        try {
            MPVLib.nativeLoadFile(handle, resolvedPath)
        } catch (e: Throwable) {
            Log.e(TAG, "[PlaybackTrace][Bridge][startAudioPlayback] nativeLoadFile failed for '$resolvedPath'", e)
            promise.reject("E_LOAD_FAILED", e.message ?: "mpv refused '$uri'", e)
            return
        }

        // Seek is applied regardless of `autoPlay`: resuming a paused
        // episode at a bookmark is a real case, and it would be odd for
        // the position to depend on whether we happen to start playing.
        val startPositionMs = optDouble(options, "startPositionMs") ?: 0.0
        if (startPositionMs > 0.0) {
            try {
                MPVLib.nativeSeek(handle, startPositionMs / 1000.0)
            } catch (e: Throwable) {
                // A seek that cannot land is not fatal to playback —
                // the file is loaded and will play from the top. Say so
                // rather than dropping it.
                Log.w(TAG, "[PlaybackTrace][Bridge][startAudioPlayback] initial seek to ${startPositionMs.toLong()}ms failed: ${e.message}")
            }
        }

        val autoPlay = optBoolean(options, "autoPlay") ?: true
        if (autoPlay) {
            try {
                MPVLib.nativePlay(handle)
            } catch (e: Throwable) {
                Log.e(TAG, "[PlaybackTrace][Bridge][startAudioPlayback] nativePlay failed", e)
                promise.reject("E_LOAD_FAILED", e.message ?: "mpv could not start playback", e)
                return
            }
        }

        val title = optString(options, "title")?.takeIf { it.isNotBlank() } ?: uri
        val intent = android.content.Intent(
            reactApplicationContext,
            com.simba.player.MediaPlaybackService::class.java,
        ).apply {
            action = com.simba.player.MediaPlaybackService.ACTION_START
            putExtra(com.simba.player.MediaPlaybackService.EXTRA_TITLE, title)
            putExtra(com.simba.player.MediaPlaybackService.EXTRA_ARTIST, optString(options, "artist").orEmpty())
            putExtra(com.simba.player.MediaPlaybackService.EXTRA_ALBUM, optString(options, "album").orEmpty())
            putExtra(com.simba.player.MediaPlaybackService.EXTRA_ARTWORK_PATH, optString(options, "artworkPath").orEmpty())
            putExtra(com.simba.player.MediaPlaybackService.EXTRA_POSITION_MS, startPositionMs.toLong())
            putExtra(com.simba.player.MediaPlaybackService.EXTRA_DURATION_MS, 0L)
            putExtra(com.simba.player.MediaPlaybackService.EXTRA_IS_PLAYING, autoPlay)
        }

        try {
            // startForegroundService, not startService: the service calls
            // startForeground in its onStartCommand, and Android 8+
            // throws ForegroundServiceDidNotStartInTimeException if it
            // was started as a background service instead.
            androidx.core.content.ContextCompat.startForegroundService(reactApplicationContext, intent)
        } catch (e: Throwable) {
            // Background-start restrictions, or a missing
            // FOREGROUND_SERVICE permission / service declaration.
            // Named loudly: this is the case where audio is loaded and
            // playing with no notification and no media keys, and a
            // silent failure here is how that gets shipped.
            Log.e(TAG, "[PlaybackTrace][Bridge][startAudioPlayback] startForegroundService failed", e)
            promise.reject("E_START_SERVICE_FAILED", e.message ?: "could not start MediaPlaybackService", e)
            return
        }

        Log.i(
            TAG,
            "[PlaybackTrace][Bridge][startAudioPlayback] playing uri='$resolvedPath' title='$title' startMs=${startPositionMs.toLong()} autoPlay=$autoPlay",
        )
        promise.resolve(true)
    }

    /**
     * The one teardown, for both lanes.
     *
     * Renamed from `stopAudioPlayback` because the body never was
     * audio-specific: it stops the process-global engine and sends the
     * service `ACTION_STOP`, neither of which knows or cares which lane
     * loaded the media. The old name became a lie the moment video
     * needed it too — and video does, because `exitPipAndFinish()` only
     * finishes the Activity. Closing the window left the engine running
     * with the notification still posted, so "back" looked like it closed
     * the player while the audio carried on with no window to stop it.
     *
     * Idempotent: safe with nothing loaded, and safe when the service is
     * already gone (the engine is still stopped in that case, because
     * leaving media running with no way to stop it is the worse failure).
     */
    @ReactMethod
    @Override
    override fun stopPlayback() {
        val context = reactApplicationContext
        val serviceUp = com.simba.player.MediaPlaybackService.isRunning()
        // Stop the engine unconditionally. If the service is already
        // gone, the session's own stop callback is not around to do it,
        // and leaving media running with no way to stop it is the worse
        // failure of the two.
        if (nativePtr != 0L) {
            try {
                MPVLib.nativeStop(nativePtr)
            } catch (e: Throwable) {
                Log.w(TAG, "[PlaybackTrace][Bridge][stopPlayback] nativeStop threw ${e.message}")
            }
        } else {
            Log.w(TAG, "[PlaybackTrace][Bridge][stopPlayback] no engine handle; nothing to stop")
        }

        if (!serviceUp) {
            Log.i(TAG, "[PlaybackTrace][Bridge][stopPlayback] service not running; engine stopped, nothing to tear down")
            return
        }
        try {
            // Ordinary startService: the service is already foreground,
            // so there is no startForeground deadline to meet.
            context.startService(
                android.content.Intent(context, com.simba.player.MediaPlaybackService::class.java).apply {
                    action = com.simba.player.MediaPlaybackService.ACTION_STOP
                },
            )
        } catch (e: Throwable) {
            Log.e(TAG, "[PlaybackTrace][Bridge][stopPlayback] could not deliver ACTION_STOP", e)
        }
    }

    @ReactMethod(isBlockingSynchronousMethod = true)
    @Override
    override fun isAudioPlaybackServiceRunning(): Boolean =
        com.simba.player.MediaPlaybackService.isRunning()

    /**
     * `ReadableMap` reads that tolerate absent keys.
     *
     * A JS caller that writes `{uri, startPositionMs: undefined}` hands us
     * a key that *exists* and holds null, so `hasKey` alone would send
     * `getDouble` into a throw on the bridge thread. These treat
     * "absent" and "explicitly null" the same way, which is what the
     * TS optional-property contract already means to a caller.
     */
    private fun optString(options: ReadableMap?, key: String): String? {
        if (options == null || !options.hasKey(key) || options.isNull(key)) return null
        return try {
            options.getString(key)
        } catch (_: Throwable) {
            null
        }
    }

    private fun optDouble(options: ReadableMap?, key: String): Double? {
        if (options == null || !options.hasKey(key) || options.isNull(key)) return null
        return try {
            options.getDouble(key)
        } catch (_: Throwable) {
            null
        }
    }

    private fun optBoolean(options: ReadableMap?, key: String): Boolean? {
        if (options == null || !options.hasKey(key) || options.isNull(key)) return null
        return try {
            options.getBoolean(key)
        } catch (_: Throwable) {
            null
        }
    }

    /**
     * Phase 13.3: one-shot accessor for the launch params the most
     * recent [openPlayer] call handed to `PlayerActivity`. PlayerActivity
     * (a fresh React context) calls this on mount so its JS can rebuild
     * a `PlaybackEntry` from the same intent extras that PlayerActivity's
     * own `by lazy {}` `launchUri` / `launchTitle` / `launchType` /
     * `launchStartPositionMs` properties read.
     *
     * Returns `null` when called from MainActivity (no recent
     * `openPlayer` invocation) — the App.tsx effect that calls this
     * is a no-op in that case, and the regular V11 inline-mount path
     * runs.
     *
     * One-shot semantics: the params are cleared after the first
     * read so a re-read in the same activity does not double-apply.
     * A second invocation from a different activity (e.g. an
     * expand-from-PiP path) would no-op on the cleared state, which
     * is correct — that path uses MainActivity's PlaybackContext, not
     * PlayerActivity's.
     */
    @ReactMethod
    @Override
    override fun getLaunchParams(promise: Promise) {
        val params = lastLaunchParams
        if (params == null) {
            // No launch pending (or already consumed) — resolve with JS `null`
            // so the consumer's `await bridge.getLaunchParams()` sees the same
            // nullable shape the spec promised (`Promise<LaunchParams | null>`).
            promise.resolve(null)
            return
        }
        // Clear immediately — we want the next call (in the same
        // activity or any other) to see null. The first read is the
        // only meaningful one.
        lastLaunchParams = null
        val map = Arguments.createMap()
        map.putString("uri", params.uri)
        map.putString("title", params.title)
        map.putString("type", params.type)
        map.putDouble("startPositionMs", params.startPositionMs.toDouble())
        Log.i(TAG, "[PlaybackTrace][Bridge][getLaunchParams] returning uri='${params.uri}' type='${params.type}'")
        promise.resolve(map)
    }

    // ── PlayerConfig (Phase 21) ──────────────────────────────────────────────
    //
    // Phase 21: `<PlayerProvider config={...}>` calls this with the
    // JSON-serialised PlayerConfig. We parse + cache as a Kotlin Map
    // so module code (PlayerActivity) can read individual keys
    // without re-parsing JSON. PlayerActivity looks the cached
    // config up via the module-side [IMpvConfigProvider] interface
    // (mirrors the IMpvNativePtrProvider / IPipModeChangeEmitter
    // pattern from Phases 7 + 10).
    //
    // Idempotent: re-calling with the same JSON is safe (just
    // overwrites the cache). The TS-side `PlayerProvider` only
    // pushes when the resolved config actually changes
    // (`useMemo` on `JSON.stringify(config ?? {})`), so the
    // re-push rate is minimal even under React's frequent
    // re-renders.

    @ReactMethod
    @Override
    override fun setConfig(configJson: String, promise: Promise) {
        try {
            val parsed: Map<String, Any?>? = if (configJson.isBlank()) {
                null
            } else {
                val obj = JSONObject(configJson)
                jsonObjectToMap(obj)
            }
            currentConfig = parsed
            val keys = parsed?.keys?.sorted()?.joinToString(", ") ?: "(none)"
            Log.i(
                TAG,
                "[PlaybackTrace][Bridge][setConfig] stored config top-level keys=[$keys]",
            )
            // Resolve with the count of top-level keys so the JS side
            // gets a cheap ack (matches the convention of
            // `setConfig` returning the applied key count — useful
            // for tests verifying the wire is live).
            promise.resolve(parsed?.size ?: 0)
        } catch (e: Exception) {
            Log.w(TAG, "[PlaybackTrace][Bridge][setConfig] parse failed: ${e.message}", e)
            // Phase 38: emit onError event so JS can render a UI before
            // the Promise rejection propagates. The Promise.reject below
            // is the primary contract; the event is supplementary.
            emitErrorEvent("E_CONFIG_PARSE_FAILED", e.message ?: "setConfig parse failed", e)
            promise.reject("E_CONFIG_PARSE_FAILED", e.message ?: "setConfig parse failed", e)
        }
    }

    // IMpvConfigProvider (Phase 21): module-side accessor used by
    // PlayerActivity to read the active PlayerConfig without
    // crossing the Gradle boundary. Returns the Kotlin Map cached
    // by [setConfig], or null when no Provider has wrapped the
    // consumer app's root.
    override fun getCurrentConfig(): Map<String, Any?>? = currentConfig

    // ── Picture-in-Picture ─────────────────────────────────────────────────

    /**
     * Enter Android Picture-in-Picture mode for the current activity.
     * Called from JS after UI elements have been hidden.
     *
     * @param chapterTitle  Optional — current chapter title shown in PiP notification.
     * @param progressPct   Optional — progress percentage string like "45 %".
     */
    @ReactMethod
    @Override
    override fun enterPip(chapterTitle: String?, progressPct: String?) {
        val activity = getCurrentActivity()
        if (activity == null || android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.N) return
        // v1.9.3 — SPEC invariant I7 (a TS signature must agree with the
        // native reality it forwards to).
        //
        // These two params were declared `String` (non-null, REQUIRED)
        // while `MpvPlayerModule.ts` declares them optional. TurboModule
        // enforces the KOTLIN arity, so the JS call
        // `enterPip()` with zero arguments was rejected before it ever
        // reached this body:
        //
        //   Exception in HostFunction: TurboModule method "enterPip"
        //   called with 0 arguments (expected argument count: 2)
        //
        // The Kotlin side is now nullable, which is what the TS contract
        // has always claimed, so both zero-arg and two-arg calls are
        // legal. The defaults below keep the PiP notification useful
        // rather than blank.
        val title = chapterTitle?.takeIf { it.isNotBlank() } ?: "Simba Player"
        val pct = progressPct?.takeIf { it.isNotBlank() } ?: "0 %"
        try {
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
                val pipParams = com.simba.player.PipManager.buildPipParams(
                    context = activity,
                    chapterTitle = title,
                    progressPercentage = pct,
                )
                activity.enterPictureInPictureMode(pipParams)
            } else {
                // API 24–25 support PiP but not PictureInPictureParams.
                activity.enterPictureInPictureMode()
            }
        } catch (throwable: Throwable) {
            // P1: the previous `catch (_: IllegalStateException)` was
            // too narrow. `enterPictureInPictureMode` can also throw
            // `IllegalArgumentException` (bad params), `RuntimeException`
            // (OEM customisations), or `SecurityException` (PiP not
            // permitted). We log the actual cause and let the JS-side
            // 5 s recovery timer in `VideoPipAdapter` take over.
            Log.w(TAG, "[PlaybackTrace][Bridge][enterPip:threw]", throwable)
        }
    }

    /**
     * Exit PiP mode by bringing the activity to the front.
     * Called from JS when user taps "Expand" in PiP RemoteActions.
     */
    @ReactMethod
    @Override
    override fun exitPip() {
        val activity = getCurrentActivity()
        if (activity == null || android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.N) return
        if (!activity.isInPictureInPictureMode) return
        // P2: the previous `activity.finish()` destroyed the
        // singleTop activity every time the user expanded the PiP
        // window — losing the navigation stack, the React tree state,
        // and often the player session itself. The right primitive is
        // `moveTaskToFront`, which brings the activity back into the
        // foreground (which automatically closes the PiP window) without
        // destroying the activity.
        val bringToFront = android.content.Intent()
        bringToFront.action = android.content.Intent.ACTION_MAIN
        bringToFront.addCategory(android.content.Intent.CATEGORY_LAUNCHER)
        bringToFront.flags = android.content.Intent.FLAG_ACTIVITY_NEW_TASK or
            android.content.Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED
        try {
            activity.startActivity(bringToFront)
        } catch (throwable: Throwable) {
            Log.w(TAG, "[PlaybackTrace][Bridge][exitPip:bringToFront:threw]", throwable)
            // Last-resort fallback: if the bring-to-front intent fails
            // for any reason, fall back to the old behavior. The user
            // is left with an empty activity on next launch but the
            // bridge hasn't crashed.
            try { activity.finish() } catch (_: Throwable) {}
        }
    }

    /**
     * Exit PiP mode and finish the activity (close player session).
     * Called from JS when user taps "Close" in PiP RemoteActions.
     */
    @ReactMethod
    @Override
    override fun exitPipAndFinish() {
        val activity = getCurrentActivity()
        if (activity == null) return
        activity.finishAndRemoveTask()
    }

    // ── Media Notification Service ─────────────────────────────────────────

    /**
     * Start the foreground [MediaPlaybackService] with current track details.
     * The service posts a MediaStyle notification with play/pause/prev/next
     * controls and persists until [stopNotification] is called.
     *
     * Phase 27 note: V11 used `MediaNotificationService` (kept in the consumer
     * app for backward compat). V12 uses `MediaPlaybackService` (Phase 16).
     * The bridge method signature is unchanged so V11 callers in
     * `src/services/notificationService.ts` continue to work — we just route
     * the intent at V12's service. `EXTRA_FILE_URI` / `EXTRA_MEDIA_TYPE` from
     * V11 are dropped (V12 doesn't use them; the file URI lives in the
     * MediaSession metadata, the media type is inferred from the file extension).
     */
    @ReactMethod
    fun startNotification(
        title: String,
        artist: String,
        album: String,
        fileUri: String,
        artworkPath: String,
        mediaType: String,
        position: Double,
        duration: Double,
    ) {
        val intent = Intent(reactApplicationContext, com.simba.player.MediaPlaybackService::class.java).apply {
            action = com.simba.player.MediaPlaybackService.ACTION_START
            putExtra(com.simba.player.MediaPlaybackService.EXTRA_TITLE, title)
            putExtra(com.simba.player.MediaPlaybackService.EXTRA_ARTIST, artist)
            putExtra(com.simba.player.MediaPlaybackService.EXTRA_ALBUM, album)
            putExtra(com.simba.player.MediaPlaybackService.EXTRA_ARTWORK_PATH, artworkPath)
            putExtra(com.simba.player.MediaPlaybackService.EXTRA_POSITION_MS, position.toLong())
            putExtra(com.simba.player.MediaPlaybackService.EXTRA_DURATION_MS, duration.toLong())
            putExtra(com.simba.player.MediaPlaybackService.EXTRA_IS_PLAYING, true)
        }
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
            reactApplicationContext.startForegroundService(intent)
        } else {
            reactApplicationContext.startService(intent)
        }
        Log.i(TAG, "MediaPlaybackService started via bridge: $title")
    }

    /**
     * Update the existing media notification with fresh playback state.
     * Called periodically (every ~1s) while the service is running.
     */
    @ReactMethod
    fun updateNotification(
        title: String,
        artist: String,
        album: String,
        fileUri: String,
        artworkPath: String,
        mediaType: String,
        position: Double,
        duration: Double,
        isPlaying: Boolean,
    ) {
        val intent = Intent(reactApplicationContext, com.simba.player.MediaPlaybackService::class.java).apply {
            action = com.simba.player.MediaPlaybackService.ACTION_UPDATE
            putExtra(com.simba.player.MediaPlaybackService.EXTRA_TITLE, title)
            putExtra(com.simba.player.MediaPlaybackService.EXTRA_ARTIST, artist)
            putExtra(com.simba.player.MediaPlaybackService.EXTRA_ALBUM, album)
            putExtra(com.simba.player.MediaPlaybackService.EXTRA_ARTWORK_PATH, artworkPath)
            putExtra(com.simba.player.MediaPlaybackService.EXTRA_POSITION_MS, position.toLong())
            putExtra(com.simba.player.MediaPlaybackService.EXTRA_DURATION_MS, duration.toLong())
            putExtra(com.simba.player.MediaPlaybackService.EXTRA_IS_PLAYING, isPlaying)
        }
        reactApplicationContext.startService(intent)
    }

    /**
     * Stop the foreground [MediaPlaybackService] and remove the notification.
     * Called when playback is explicitly ended (stop/destroy/reset).
     */
    @ReactMethod
    fun stopNotification() {
        val intent = Intent(reactApplicationContext, com.simba.player.MediaPlaybackService::class.java).apply {
            action = com.simba.player.MediaPlaybackService.ACTION_STOP
        }
        reactApplicationContext.startService(intent)
        Log.i(TAG, "MediaPlaybackService stopped via bridge")
    }

    @ReactMethod(isBlockingSynchronousMethod = true)
    @Override
    override fun isNotificationActive(): Boolean {
        return com.simba.player.MediaPlaybackService.isRunning()
    }

    /**
     * Request the POST_NOTIFICATIONS permission on Android 13+.
     * Calling this on lower APIs is a no-op (permission auto-granted).
     *
     * JS should call this before [startNotification] on Android 13+.
     * The result is delivered via the standard
     * `PermissionsAndroid.check/request` flow.
     */
    @ReactMethod
    @Override
    override fun requestNotificationPermission() {
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU) {
            val activity = getCurrentActivity() ?: return
            androidx.core.app.ActivityCompat.requestPermissions(
                activity,
                arrayOf(android.Manifest.permission.POST_NOTIFICATIONS),
                9001 // arbitrary request code
            )
        }
    }

    // ── Native Pointer (for MpvRenderView) ─────────────────────────────────

    /**
     * The JS-facing pointer accessor.
     *
     * V20 Phase A removed its `IMpvNativePtrProvider` sibling. That
     * interface existed so `PlayerActivity` could fetch the handle across
     * a Gradle module boundary — a boundary Phase 6 had already removed
     * (see `MPVLib`'s own header). `PlayerActivity` now reads
     * `PlaybackHost` directly and registers with `whenAvailable`, so the
     * interface had no remaining consumer and was deleted rather than
     * left in place as fiction.
     *
     * This method stays because it is part of the published TurboModule
     * spec and removing it would be a breaking change for consumers.
     */
    @ReactMethod(isBlockingSynchronousMethod = true)
    @Override
    override fun getNativePtr(): Double {
        return PlaybackHost.handle().toDouble()
    }

    // ── Helpers ────────────────────────────────────────────────────────────

    private fun ensurePtr() {
        if (nativePtr == 0L) {
            Log.e(TAG, "[PlaybackTrace][Bridge][ensurePtr] native pointer is zero")
            throw IllegalStateException("MpvPlayerModule not initialized. Call initPlayer() first.")
        }
    }

    /**
     * Phase 38 (error handling & recovery): wrap a bridge-method body so that
     * the [IllegalStateException] from [ensurePtr] (and any other uncaught
     * exception) becomes a structured `onError` event to JS rather than
     * crashing the React Native bridge. The original exception is re-thrown
     * for non-Promise methods (the RN bridge already catches and surfaces
     * those as JS-side errors via the standard exception pipeline) — we
     * only EMIT the `onError` event so consumers can render a UI before
     * the bridge propagates the exception.
     *
     * For Promise-returning methods, the exception is converted to a
     * Promise.reject with the structured `E_NOT_INITIALIZED` (or whatever
     * the actual cause was) error code.
     *
     * T28.03: emit BOTH a human-readable `codeName` (the original string
     * like `"E_NOT_INITIALIZED"`) AND a numeric `code` (a stable
     * integer) in the payload. The TS `onError` interface declares
     * `code: number; codeName?: string` — programmatic handlers switch
     * on the integer; logging keeps the string for grep-friendliness.
     * Numeric codes are stable across versions (do not reuse a number
     * for a different meaning once shipped).
     */
    private fun emitErrorEvent(code: String, message: String, throwable: Throwable? = null) {
        Log.w(TAG, "[PlaybackTrace][Bridge][error] code=$code numeric=${codeToNumeric(code)} message=$message", throwable)
        try {
            val ctx = reactApplicationContext
            val payload = Arguments.createMap().apply {
                putInt("code", codeToNumeric(code))
                putString("codeName", code)
                putString("message", message)
                if (throwable != null) {
                    putString("exception", throwable.javaClass.simpleName)
                    putString("stack", throwable.stackTraceToString().take(2048))
                }
            }
            ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit("onError", payload)
        } catch (e: Exception) {
            Log.w(TAG, "[PlaybackTrace][Bridge][error] failed to emit onError", e)
        }
    }

    /**
     * Phase 38: convert a thrown exception into a Promise.reject with the
     * structured E_* error code. Used by Promise-returning @ReactMethod
     * methods that call [ensurePtr] (most of the playback API surface).
     */
    private fun rejectNotInitialized(promise: Promise) {
        emitErrorEvent("E_NOT_INITIALIZED", "MpvPlayerModule not initialized. Call initPlayer() first.")
        promise.reject("E_NOT_INITIALIZED", "MpvPlayerModule not initialized. Call initPlayer() first.")
    }

    /**
     * Extract the cache fill percentage from a `cache-buffering-state`
     * payload that the native property bridge has already serialised to JSON.
     *
     * While the stream is actively buffering, mpv emits a node map like
     * `{"percent": 37}`. When the cache is full (or buffering stops for any
     * other reason) the property is reported as the boolean `false`, which
     * our C++ property serializer emits as the literal string `"false"`.
     *
     * Anything we can't parse (malformed JSON, missing field) defaults to
     * `100.0` so the JS `percent > 0 && percent < 100` guard treats the
     * unknown state as "not buffering" and avoids a stuck spinner.
     */
    private fun parseBufferingPercent(jsonValue: String): Double {
        val trimmed = jsonValue.trim()
                if (trimmed == "false" || trimmed.isEmpty() || trimmed == "null") return 100.0
        trimmed.toDoubleOrNull()?.let { return it.coerceIn(0.0, 100.0) }
        return try {
            val obj = JSONObject(trimmed)

            when {
                obj.has("percent") -> obj.getDouble("percent").coerceIn(0.0, 100.0)
                obj.has("percentage") -> obj.getDouble("percentage").coerceIn(0.0, 100.0)
                else -> 100.0
            }
        } catch (e: Exception) {
            Log.w(TAG, "parseBufferingPercent: bad json '$jsonValue': ${e.message}")
            100.0
        }
    }

    /**
     * Parse a `demuxer-cache-state` payload into buffered ranges + fill.
     *
          * MPV serialises this property as a node map whose documented fields
     * include `seekable-ranges`, `bof-cached`, `eof-cached`, `fw-bytes`,
     * `file-cache-bytes`, `cache-end`, `reader-pts`, and `cache-duration`.
     * The seekable ranges are the authoritative buffered timeline ranges.
     *
     * We extract only those ranges here. Cache fill is intentionally not
     * fabricated from byte counts: mpv exposes the user-facing fill percentage
     * through the separate `cache-buffering-state` property, which is mapped
     * to `onBuffering` and consumed by TransportContext.

     */
    private data class CacheStatePayload(
        val ranges: List<Pair<Double, Double>>,
        val fill: Double,
    )

    private fun parseCacheState(jsonValue: String): CacheStatePayload {
        val trimmed = jsonValue.trim()
        if (trimmed.isEmpty() || trimmed == "null") {
            return CacheStatePayload(emptyList(), 0.0)
        }
        return try {
            val obj = JSONObject(trimmed)
            val rangesJson = obj.optJSONArray("seekable-ranges")
                ?: obj.optJSONArray("ranges") // compatibility with older native payloads

            val ranges = mutableListOf<Pair<Double, Double>>()
            if (rangesJson != null) {
                for (i in 0 until rangesJson.length()) {
                    val r = rangesJson.optJSONObject(i) ?: continue
                    val start = r.optDouble("start", Double.NaN)
                    val end = r.optDouble("end", Double.NaN)
                    if (!start.isNaN() && !end.isNaN() && end > start) {
                        ranges.add(start to end)
                    }
                }
            }
                        CacheStatePayload(ranges, 0.0)

        } catch (e: Exception) {
            Log.w(TAG, "parseCacheState: bad json '$jsonValue': ${e.message}")
            CacheStatePayload(emptyList(), 0.0)
        }
    }

    /**
     * T28.03: stable integer mapping for the structured error codes emitted
     * by [emitErrorEvent]. The TS `onError` interface declares `code: number`
     * - this helper provides the integer so programmatic handlers can switch
     * on a stable value across versions. Numeric codes are PERMANENT: do
     * not reuse a number once it ships (use a new range instead). Ranges:
     *
     *   1xxx - Initialization lifecycle (mount order, warm-up, ensurePtr)
     *   2xxx - Activity / Intent / launch failures (PlayerActivity missing,
     *          SecurityException, manifest mismatches)
     *   3xxx - Playback control errors (loadFile failures, command queue
     *          overflow, seek out-of-range) - reserved for future use
     *   4xxx - Configuration / IPC errors (setConfig parse failures,
     *          bridge serialisation mismatches)
     *
     * Returns `0` for unknown codes so unrecognised values degrade to
     * a single sentinel rather than throwing.
     */
    private fun codeToNumeric(code: String): Int = when (code) {
        // 1xxx - Initialization
        "E_NOT_INITIALIZED" -> 1001
        // 2xxx - Activity / Intent / launch
        "E_ACTIVITY_NOT_FOUND" -> 2001
        "E_SECURITY" -> 2002
        "E_OPEN_PLAYER_FAILED" -> 2003
        // 4xxx - Configuration
        "E_CONFIG_PARSE_FAILED" -> 4001
        else -> 0
    }
}

/**
 * Utility for JSON string <-> ReadableMap conversions.
 */
internal object JsonUtil {
    fun jsonStringToReactMap(json: String): ReadableMap {
        val map = Arguments.createMap()
        val obj = JSONObject(json)
        for (key in obj.keys()) {
            val value = obj.get(key)
            when (value) {
                is String -> map.putString(key, value)
                is Int -> map.putInt(key, value)
                is Long -> map.putDouble(key, value.toDouble())
                is Double -> map.putDouble(key, value)
                is Boolean -> map.putBoolean(key, value)
                is JSONObject -> map.putMap(key, jsonStringToReactMap(value.toString()))
                is JSONArray -> {
                    val arr = Arguments.createArray()
                    for (i in 0 until value.length()) {
                        val el = value.get(i)
                        when (el) {
                            is String -> arr.pushString(el)
                            is Number -> arr.pushDouble(el.toDouble())
                            is Boolean -> arr.pushBoolean(el)
                            is JSONObject -> arr.pushMap(jsonStringToReactMap(el.toString()))
                        }
                    }
                    map.putArray(key, arr)
                }
            }
        }
        return map
    }
}
