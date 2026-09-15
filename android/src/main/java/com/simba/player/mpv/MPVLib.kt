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

    // ── Load native libraries ─────────────────────────────────────────────
    //
    // V16.0.7 / 1.5.7 (D-033): libc++_shared.so MUST be loaded BEFORE
    // simbaplayer_mpv.so. Android's dynamic linker resolves `libmpv.so`'s
    // `NEEDED libc++_shared.so` to the **system** libc++ unless the
    // bundled one is already mapped into the process. On API 35+ / Android
    // 14 / API 37 emulators, the system libc++ is older and is missing
    // `__from_chars_floating_point` (a clang 14 / NDK r25+ symbol) — so
    // `dlopen("libmpv.so")` fails with `cannot locate symbol
    // "__from_chars_floating_pointIfE..."` and the bridge is dead at
    // boot.
    //
    // The bundled `libc++_shared.so` (NDK r27, shipped in this lib's
    // `src/main/jniLibs/{ABI}/`) DOES contain the symbol. The fix per
    // https://developer.android.com/ndk/guides/common-problems
    // (\"UnsatisfiedLinkError with dlopen\") and StackOverflow #62466090
    // is to load the dependency first — `System.loadLibrary` is the
    // standard Android mechanism for mapping a `.so` into the process
    // address space; once `c++_shared` is mapped, the linker resolves
    // subsequent `dlopen` calls against the mapped library, not the
    // system one.
    //
    // Order matters: `c++_shared` is listed in libmpv.so's `DT_NEEDED`,
    // so libmpv.so itself would normally cause c++_shared to be loaded
    // transitively. But on API 35+ the linker pre-maps the system
    // libc++ first (the namespace lookup order changed) and a missing
    // symbol in the system library aborts the load. Explicitly
    // loading c++_shared first pre-maps our bundled copy and wins.
    //
    // Idempotent: `System.loadLibrary` no-ops if the library is already
    // mapped, so this is safe to call from multiple entry points
    // (MPVLib.init + MpvBridgeModule's class init).
    init {
        System.loadLibrary("c++_shared")
        System.loadLibrary("simbaplayer_mpv")
    }
}