package com.simba.player.mpv

import android.content.Intent
import android.util.Log
import java.io.File
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.module.annotations.ReactModule
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.simba.player.IMpvConfigProvider
import com.simba.player.IMpvNativePtrProvider
import com.simba.player.IPipModeChangeEmitter
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
    ReactContextBaseJavaModule(reactContext),
    IMpvConfigProvider,
    IMpvNativePtrProvider,
    IPipModeChangeEmitter {

    companion object {
        const val NAME = "MpvPlayerModule"
        private const val TAG = "MpvBridgeModule"

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

    /** Native mpv_handle* stored as Long (0 = uninitialized). */
    private var nativePtr: Long = 0

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
            Log.i(TAG, "[PlaybackTrace][Bridge][listener:property] name=$name value=$jsonValue")
            try {
                val payload = Arguments.createMap().apply {
                    putString("property", name)
                    putString("value", jsonValue)
                }
                eventEmitter.emit("onPropertyChanged", payload)
            } catch (e: Exception) {
                Log.w(TAG, "Property change emit failed: ${e.message}")
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
    fun setScreenBrightness(brightness: Double) {
        val activity = getCurrentActivity() ?: return
        val layout = activity.window.attributes
        layout.screenBrightness = brightness.toFloat().coerceIn(0.0f, 1.0f)
        activity.window.attributes = layout
    }

    @ReactMethod(isBlockingSynchronousMethod = true)
    fun getScreenBrightness(): Double {
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
    fun setKeepScreenOn(enabled: Boolean) {
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
    fun setOrientation(mode: String) {
        val activity = getCurrentActivity() ?: return
        activity.runOnUiThread {
            val requested = when (mode.lowercase()) {
                "portrait"  -> android.content.pm.ActivityInfo.SCREEN_ORIENTATION_USER_PORTRAIT
                "landscape" -> android.content.pm.ActivityInfo.SCREEN_ORIENTATION_USER_LANDSCAPE
                "sensor"    -> android.content.pm.ActivityInfo.SCREEN_ORIENTATION_FULL_SENSOR
                else        -> android.content.pm.ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
            }
            activity.requestedOrientation = requested
        }
    }

    @ReactMethod
    fun setImmersive(enabled: Boolean) {
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
    fun play() {
        ensurePtr()
        Log.i(TAG, "[PlaybackTrace][Bridge][play] ptr=$nativePtr")
        MPVLib.nativePlay(nativePtr)
        Log.i(TAG, "[PlaybackTrace][Bridge][play] nativePlay returned")
    }

    @ReactMethod
    fun pause() {
        ensurePtr()
        Log.i(TAG, "[PlaybackTrace][Bridge][pause] ptr=$nativePtr")
        MPVLib.nativePause(nativePtr)
        Log.i(TAG, "[PlaybackTrace][Bridge][pause] nativePause returned")
    }

    @ReactMethod
    fun stop() {
        ensurePtr()
        Log.i(TAG, "[PlaybackTrace][Bridge][stop] ptr=$nativePtr")
        MPVLib.nativeStop(nativePtr)
    }

    @ReactMethod
    fun togglePlayPause() {
        ensurePtr()
        MPVLib.nativeTogglePlayPause(nativePtr)
    }

    @ReactMethod
    fun seekForward(seconds: Double) {
        ensurePtr()
        MPVLib.nativeSeekRelative(nativePtr, seconds)
    }

    @ReactMethod
    fun seekBackward(seconds: Double) {
        ensurePtr()
        MPVLib.nativeSeekRelative(nativePtr, -seconds)
    }

    @ReactMethod
    fun seekAbsolute(position: Double) {
        ensurePtr()
        Log.i(TAG, "[PlaybackTrace][Bridge][seekAbsolute] position=$position ptr=$nativePtr")
        MPVLib.nativeSeek(nativePtr, position)
    }

    @ReactMethod
    fun stepFrame(direction: Double) {
        ensurePtr()
        MPVLib.nativeStepFrame(nativePtr, direction.toInt())
    }

    @ReactMethod(isBlockingSynchronousMethod = true)
    fun screenshot(): String {
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
     */
    @ReactMethod(isBlockingSynchronousMethod = true)
    fun captureThumbnail(uri: String): String {
        ensurePtr()
        val cacheDir = reactApplicationContext.cacheDir
        val hash = uri.hashCode().toLong() and 0x7FFFFFFF
        val thumbFile = File(cacheDir, "thumb_${hash}.png")
        return MPVLib.nativeScreenshot(nativePtr, thumbFile.absolutePath)
    }

    // ── File Loading ───────────────────────────────────────────────────────

    @ReactMethod
    fun loadFile(path: String) {
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
    fun loadFileWithRequestId(path: String, requestId: String) {
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
    fun grantPersistablePermission(uri: String) {
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
    fun verifyContentUri(uri: String): Boolean {
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
    fun loadPlaylist(paths: ReadableArray, startIndex: Double) {
        ensurePtr()
        val arr = Array(paths.size()) { i ->
            normalizeMpvInput(resolveContentUri(paths.getString(i) ?: ""))
        }
        MPVLib.nativeLoadPlaylist(nativePtr, arr, startIndex.toInt())
    }

    @ReactMethod(isBlockingSynchronousMethod = true)
    fun getFileInfo(): String {
        ensurePtr()
        return JSONObject().apply {
            put("path", try { MPVLib.nativeGetProperty(nativePtr, "path") } catch (_: Exception) { "" })
            put("title", try { MPVLib.nativeGetProperty(nativePtr, "media-title") } catch (_: Exception) { "" })
            put("duration", getDuration())
        }.toString()
    }

    @ReactMethod(isBlockingSynchronousMethod = true)
    fun getVideoParams(): String {
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
    fun getTracks(): String {
        ensurePtr()
        return try {
            MPVLib.nativeGetProperty(nativePtr, "track-list")
        } catch (_: Exception) { "[]" }
    }

    @ReactMethod
    fun selectTrack(trackId: Double) {
        ensurePtr()
        MPVLib.nativeSelectTrack(nativePtr, trackId.toInt())
    }

    @ReactMethod
    fun setTrack(type: String, trackId: Double) {
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
    fun cycleTrack(type: String) {
        ensurePtr()
        when (type) {
            "video" -> MPVLib.nativeSetProperty(nativePtr, "cycle", "\"video\"")
            "audio" -> MPVLib.nativeSetProperty(nativePtr, "cycle", "\"audio\"")
            "sub"   -> MPVLib.nativeSetProperty(nativePtr, "cycle", "\"sub\"")
        }
    }

    @ReactMethod
    fun setTrackVisibility(trackType: String, visible: Boolean) {
        // No-op: mpv handles track visibility automatically
    }

    // ── Chapters ───────────────────────────────────────────────────────────

    @ReactMethod(isBlockingSynchronousMethod = true)
    fun getChapters(): String {
        ensurePtr()
        return try {
            MPVLib.nativeGetProperty(nativePtr, "chapter-list")
        } catch (_: Exception) { "[]" }
    }

    @ReactMethod
    fun seekChapter(direction: Double) {
        ensurePtr()
        if (direction > 0) {
            MPVLib.nativeSetProperty(nativePtr, "chapter", "1")
        } else {
            MPVLib.nativeSetProperty(nativePtr, "chapter", "-1")
        }
    }

    @ReactMethod(isBlockingSynchronousMethod = true)
    fun getCurrentChapter(): String {
        ensurePtr()
        return try {
            MPVLib.nativeGetProperty(nativePtr, "chapter-metadata")
        } catch (_: Exception) { "{}" }
    }

    // ── Volume / Audio ─────────────────────────────────────────────────────

    @ReactMethod
    fun setVolume(volume: Double) {
        ensurePtr()
        Log.i(TAG, "[PlaybackTrace][Bridge][setVolume] volume=$volume ptr=$nativePtr")
        MPVLib.nativeSetVolume(nativePtr, volume)
    }

    @ReactMethod(isBlockingSynchronousMethod = true)
    fun getVolume(): Double {
        ensurePtr()
        return MPVLib.nativeGetVolume(nativePtr)
    }

    @ReactMethod
    fun setMuted(muted: Boolean) {
        ensurePtr()
        MPVLib.nativeSetMuted(nativePtr, muted)
    }

    @ReactMethod(isBlockingSynchronousMethod = true)
    fun getMuted(): Boolean {
        ensurePtr()
        return MPVLib.nativeGetMuted(nativePtr)
    }

    @ReactMethod(isBlockingSynchronousMethod = true)
    fun getAudioDevices(): String {
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
    fun setAudioDevice(deviceName: String) {
        ensurePtr()
        Log.i(TAG, "[PlaybackTrace][Bridge][setAudioDevice] device=$deviceName ptr=$nativePtr")
        MPVLib.nativeSetProperty(nativePtr, "audio-device", "\"$deviceName\"")
    }

    // ── Playback Speed ─────────────────────────────────────────────────────

    @ReactMethod
    fun setSpeed(speed: Double) {
        ensurePtr()
        MPVLib.nativeSetSpeed(nativePtr, speed)
    }

    @ReactMethod(isBlockingSynchronousMethod = true)
    fun getSpeed(): Double {
        ensurePtr()
        return MPVLib.nativeGetSpeed(nativePtr)
    }

    // ── Loop / Repeat ──────────────────────────────────────────────────────

    @ReactMethod
    fun setLoopMode(mode: String) {
        ensurePtr()
        val m = when (mode) {
            "file"     -> 1
            "playlist" -> 2
            else       -> 0
        }
        MPVLib.nativeSetLoopMode(nativePtr, m)
    }

    @ReactMethod(isBlockingSynchronousMethod = true)
    fun getLoopMode(): String {
        ensurePtr()
        return when (MPVLib.nativeGetLoopMode(nativePtr)) {
            1 -> "file"
            2 -> "playlist"
            else -> "none"
        }
    }

    @ReactMethod
    fun setPlaylistLoop(loop: Boolean) {
        ensurePtr()
        MPVLib.nativeSetLoopMode(nativePtr, if (loop) 2 else 0)
    }

    // ── Properties ─────────────────────────────────────────────────────────

    @ReactMethod(isBlockingSynchronousMethod = true)
    fun getProperty(name: String): String {
        ensurePtr()
        return MPVLib.nativeGetProperty(nativePtr, name)
    }

    @ReactMethod
    fun setProperty(name: String, value: String) {
        ensurePtr()
        MPVLib.nativeSetProperty(nativePtr, name, value)
    }

    @ReactMethod
    fun observeProperty(name: String) {
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
    fun unobserveProperty(name: String) {
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
    fun setVideoFilter(filter: String, enabled: Boolean) {
        ensurePtr()
        MPVLib.nativeSetVideoFilter(nativePtr, filter, enabled)
    }

    @ReactMethod
    fun setAudioFilter(filter: String, enabled: Boolean) {
        ensurePtr()
        MPVLib.nativeSetAudioFilter(nativePtr, filter, enabled)
    }

    // ── Playlist ───────────────────────────────────────────────────────────

    @ReactMethod(isBlockingSynchronousMethod = true)
    fun getPlaylist(): String {
        ensurePtr()
        return try {
            MPVLib.nativeGetProperty(nativePtr, "playlist")
        } catch (_: Exception) { "[]" }
    }

    @ReactMethod
    fun playlistNext() {
        ensurePtr()
        MPVLib.nativePlaylistNext(nativePtr)
    }

    @ReactMethod
    fun playlistPrev() {
        ensurePtr()
        MPVLib.nativePlaylistPrev(nativePtr)
    }

    @ReactMethod
    fun playlistRemove(index: Double) {
        ensurePtr()
        MPVLib.nativePlaylistRemove(nativePtr, index.toInt())
    }

    @ReactMethod
    fun playlistShuffle() {
        ensurePtr()
        MPVLib.nativePlaylistShuffle(nativePtr)
    }

    @ReactMethod
    fun playlistClear() {
        ensurePtr()
        MPVLib.nativePlaylistClear(nativePtr)
    }

    // ── State Queries ──────────────────────────────────────────────────────

    @ReactMethod(isBlockingSynchronousMethod = true)
    fun getPosition(): Double {
        val position = if (nativePtr != 0L) MPVLib.nativeGetPosition(nativePtr) else 0.0
        Log.d(TAG, "[PlaybackTrace][Bridge][getPosition] ptr=$nativePtr position=$position")
        return position
    }

    @ReactMethod(isBlockingSynchronousMethod = true)
    fun getDuration(): Double {
        val duration = if (nativePtr != 0L) MPVLib.nativeGetDuration(nativePtr) else 0.0
        Log.d(TAG, "[PlaybackTrace][Bridge][getDuration] ptr=$nativePtr duration=$duration")
        return duration
    }

    @ReactMethod(isBlockingSynchronousMethod = true)
    fun getPlaybackState(): String {
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
    fun isMuted(): Boolean {
        return if (nativePtr != 0L) MPVLib.nativeGetMuted(nativePtr) else false
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
    fun initPlayer(): Boolean {
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
    fun destroy() {
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
    fun setDebugLogging(enabled: Boolean) {
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
    fun dumpObservedProperties(): Int {
        val count = pendingObservedProperties.size
        Log.i(TAG, "[PlaybackTrace][Bridge][dumpObservedProperties] $count properties observed:")
        pendingObservedProperties.sorted().forEach { name ->
            val value: String? = try {
                if (nativePtr != 0L) MPVLib.getPropertyString(nativePtr, name) else null
            } catch (e: Exception) {
                "<getPropertyString failed: ${e.message}>"
            }
            Log.i(TAG, "[PlaybackTrace][Bridge][dumpProperties] property=$name value=\"$value\" requested=true")
        }
        return count
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
                "isHeadlessJsTask=${isHeadlessJsTask} " +
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
    //   • E_INVALID_TYPE           — `type` is not "video" or "audio"
    //   • E_NO_ACTIVITY            — no current activity (RN bridge down)
    //   • E_ACTIVITY_NOT_FOUND     — PlayerActivity not declared in manifest
    //   • E_SECURITY               — manifest restriction refused the launch
    //   • E_OPEN_PLAYER_FAILED     — anything else (e.g. flag mismatch)
    @ReactMethod
    fun openPlayer(
        uri: String,
        title: String?,
        type: String,
        startPositionMs: Double,
        promise: Promise,
    ) {
        // 3.3: validate `type` — defensive against the JS layer ever
        // passing a typo (the TS Spec already types it as the union
        // `'video' | 'audio'`, but a stale bundle could skip the check).
        if (type != com.simba.player.PlayerActivity.TYPE_VIDEO &&
            type != com.simba.player.PlayerActivity.TYPE_AUDIO
        ) {
            Log.w(TAG, "[PlaybackTrace][Bridge][openPlayer] invalid type='$type', rejecting with E_INVALID_TYPE")
            promise.reject("E_INVALID_TYPE", "type must be 'video' or 'audio', got '$type'")
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
        val resolvedTitle = title?.takeIf { it.isNotBlank() } ?: uri
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
    @ReactMethod(isBlockingSynchronousMethod = true)
    fun getLaunchParams(): com.facebook.react.bridge.WritableMap? {
        val params = lastLaunchParams ?: return null
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
        return map
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
    fun setConfig(configJson: String, promise: Promise) {
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
    fun enterPip(chapterTitle: String? = null, progressPct: String? = null) {
        val activity = getCurrentActivity()
        if (activity == null || android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.N) return
        try {
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
                val pipParams = com.simba.player.PipManager.buildPipParams(
                    context = activity,
                    chapterTitle = chapterTitle,
                    progressPercentage = progressPct,
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
    fun exitPip() {
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
    fun exitPipAndFinish() {
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
    fun isNotificationActive(): Boolean {
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
    fun requestNotificationPermission() {
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
     * Phase 7: module-side accessor (Long) used by `PlayerActivity` (which
     * lives in the `@simba/react-native-media-player` module and therefore
     * cannot reference `MpvBridgeModule` directly) to obtain the active
     * libmpv handle without crossing the Gradle module boundary.
     *
     * The JS-facing @ReactMethod below stays as-is to keep the public
     * TurboModule API stable. The two methods share the same private
     * `nativePtr` field, so they can never disagree.
     */
    override fun fetchNativePtr(): Long = nativePtr

    @ReactMethod(isBlockingSynchronousMethod = true)
    fun getNativePtr(): Double {
        return nativePtr.toDouble()
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
     */
    private fun emitErrorEvent(code: String, message: String, throwable: Throwable? = null) {
        Log.w(TAG, "[PlaybackTrace][Bridge][error] code=$code message=$message", throwable)
        try {
            val ctx = reactApplicationContext
            val payload = Arguments.createMap().apply {
                putString("code", code)
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
