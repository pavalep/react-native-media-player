package com.simba.player.mpv

import android.view.Surface
import java.util.concurrent.CopyOnWriteArrayList

/**
 * JNI bridge to native libmpv via C++ glue in main.cpp / property.cpp / event.cpp.
 *
 * All native methods are designed as static so the C side can hold a single
 * mpv_handle* without needing a Java object reference.
 *
 * Lives in the `@simba/react-native-media-player` module (extracted from the
 * consumer app in Phase 6 so PlayerActivity can directly reference the same
 * MPVLib instance as MpvBridgeModule / MpvRenderView without a Gradle module
 * boundary crossing). The native library `simbaplayer_mpv` is still built by
 * the consumer app's CMakeLists and bundled in the APK — System.loadLibrary
 * resolves it via the standard Android library loader at module init time.
 */
object MPVLib {

    // ── Lifecycle ──────────────────────────────────────────────────────────

    /** Create mpv instance. Returns native pointer as Long. */
    external fun nativeCreate(caFilePath: String): Long

    /** Destroy mpv instance. */
    external fun nativeDestroy()

    /** Attach/detach an Android Surface for video output (wid API). */
    external fun nativeAttachSurface(nativePtr: Long, surface: Surface?)

    /** Notify mpv of surface size change (for orientation changes). */
    external fun nativeSurfaceChanged(nativePtr: Long, width: Int, height: Int)

    // ── Playback Control ───────────────────────────────────────────────────

    external fun nativeLoadFile(nativePtr: Long, path: String)
    external fun nativeLoadFileWithRequestId(nativePtr: Long, path: String, requestId: String)
    external fun nativePlay(nativePtr: Long)
    external fun nativePause(nativePtr: Long)
    external fun nativeStop(nativePtr: Long)
    external fun nativeTogglePlayPause(nativePtr: Long)
    external fun nativeSeek(nativePtr: Long, position: Double)
    external fun nativeSeekRelative(nativePtr: Long, seconds: Double)
    external fun nativeStepFrame(nativePtr: Long, direction: Int)
    external fun nativeScreenshot(nativePtr: Long, outputPath: String): String

    // ── Volume ─────────────────────────────────────────────────────────────

    external fun nativeSetVolume(nativePtr: Long, volume: Double)
    external fun nativeGetVolume(nativePtr: Long): Double
    external fun nativeSetMuted(nativePtr: Long, muted: Boolean)
    external fun nativeGetMuted(nativePtr: Long): Boolean

    // ── Speed ──────────────────────────────────────────────────────────────

    external fun nativeSetSpeed(nativePtr: Long, speed: Double)
    external fun nativeGetSpeed(nativePtr: Long): Double

    // ── Loop ───────────────────────────────────────────────────────────────

    external fun nativeSetLoopMode(nativePtr: Long, mode: Int)
    external fun nativeGetLoopMode(nativePtr: Long): Int

    // ── Playlist ───────────────────────────────────────────────────────────

    external fun nativeLoadPlaylist(nativePtr: Long, paths: Array<String>, startIndex: Int)
    external fun nativePlaylistNext(nativePtr: Long)
    external fun nativePlaylistPrev(nativePtr: Long)
    external fun nativePlaylistRemove(nativePtr: Long, index: Int)
    external fun nativePlaylistShuffle(nativePtr: Long)
    external fun nativePlaylistClear(nativePtr: Long)

    // ── Tracks ─────────────────────────────────────────────────────────────

    external fun nativeSelectTrack(nativePtr: Long, trackId: Int)

    // ── Properties ─────────────────────────────────────────────────────────

    external fun nativeGetProperty(nativePtr: Long, name: String): String
    external fun nativeSetProperty(nativePtr: Long, name: String, valueJson: String?)
    external fun nativeSetPropertyString(nativePtr: Long, property: String, value: String?)
    external fun nativeObserveProperty(nativePtr: Long, name: String)
    external fun nativeUnobserveProperty(nativePtr: Long, name: String)

    // ── Convenience ────────────────────────────────────────────────────────

    /** Set a string property on the mpv instance by native pointer. */
    fun setPropertyString(nativePtr: Long, property: String, value: String?) {
        nativeSetPropertyString(nativePtr, property, value)
    }

    // ── Filters ────────────────────────────────────────────────────────────

    external fun nativeSetVideoFilter(nativePtr: Long, filter: String, enable: Boolean)
    external fun nativeSetAudioFilter(nativePtr: Long, filter: String, enable: Boolean)

    // ── State Queries ──────────────────────────────────────────────────────

    external fun nativeGetPosition(nativePtr: Long): Double
    external fun nativeGetDuration(nativePtr: Long): Double

    // ── Callbacks invoked from C++ event thread ────────────────────────────

    /** Called from native event loop thread via JNI. */
    @JvmStatic
    fun onNativeEvent(event: String, jsonPayload: String) {
        listeners.forEach { listener ->
            runCatching { listener.onMpvEvent(event, jsonPayload) }
        }
    }

    /** Called from native event loop when an observed property changes. */
    @JvmStatic
    fun onNativePropertyChanged(name: String, jsonValue: String) {
        listeners.forEach { listener ->
            runCatching { listener.onMpvPropertyChanged(name, jsonValue) }
        }
    }

    /** Called from native on error. */
    @JvmStatic
    fun onNativeError(code: Int, recoverable: Boolean, message: String, requestId: String?) {
        listeners.forEach { listener ->
            runCatching { listener.onMpvError(code, recoverable, message, requestId) }
        }
    }

    // ── Listener pattern ───────────────────────────────────────────────────

    interface MpvEventListener {
        fun onMpvEvent(event: String, jsonPayload: String) = Unit
        fun onMpvPropertyChanged(name: String, jsonValue: String) = Unit
        /**
         * M5: `recoverable` is computed at the native layer based on the
         * source of the error (end-file error / fatal log = not retryable).
         * The JS layer must surface this to the snapshot so the UI can
         * decide between "Retry" and "Pick another".
         */
        fun onMpvError(code: Int, recoverable: Boolean, message: String, requestId: String?) = Unit
    }

    private val listeners = CopyOnWriteArrayList<MpvEventListener>()

    fun addListener(listener: MpvEventListener) {
        if (!listeners.contains(listener)) listeners.add(listener)
    }

    fun removeListener(listener: MpvEventListener) {
        listeners.remove(listener)
    }

    // ── Load native library ────────────────────────────────────────────────

    init {
        System.loadLibrary("simbaplayer_mpv")
    }
}