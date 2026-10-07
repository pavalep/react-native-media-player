package com.simba.player

import java.util.concurrent.CopyOnWriteArraySet

/**
 * V20 Phase A — the single owner of the libmpv handle for the whole process.
 *
 * ## Why this file exists
 *
 * Before V20 there were **two** owners of the same native pointer:
 *
 *  - `MpvBridgeModule.nativePtr` — the real one, written by `initPlayer`
 *    and zeroed by `destroy()`.
 *  - `PlayerActivity.lastNativePtr` — a *copy*, obtained by asking the
 *    bridge over the React Native module registry and then cached forever.
 *
 * The copy could not be invalidated. `MpvBridgeModule.destroy()` zeroed
 * only its own field, so after a destroy/re-create cycle the Activity
 * held a pointer that no longer matched the process global `g_mpv`, and
 * every call it made was refused by the C++ lease guard. The symptom was
 * not a crash — the native layer is correctly defended — it was a
 * control surface that was present, wired, and permanently inert:
 * media-session buttons, audio focus, ducking, metadata and progress
 * polling all silently doing nothing.
 *
 * The fix is not "invalidate the cache more carefully". It is to have
 * exactly one owner and let everyone *read* it.
 *
 * ## Why the handle can simply be shared
 *
 * `g_mpv` is a process-global in C++ (`native_state.h:13`), and
 * `MPVLib.nativeCreate` returns the existing instance when one is
 * already present (`main.cpp:182-185`). `MPVLib` is a Kotlin `object`
 * that maps `simbaplayer_mpv` into the process address space in its
 * `init` block. So every caller in this process — TurboModule, Activity
 * or Service — already reaches the *same* single instance. There is
 * nothing to relocate; the only thing that needed fixing was Kotlin
 * choosing to keep a second copy.
 *
 * ## Why this is not an Activity field, and not a TurboModule field
 *
 * Both were wrong owners:
 *
 *  - An Activity dies with its own lifecycle, so it cannot hold state
 *    that must outlive the UI.
 *  - A TurboModule dies with its React context, so it cannot hold state
 *    that must outlive the React context either.
 *
 * A process-scoped `object` outlives both, which mirrors the reality
 * that the thing it owns (`g_mpv`) is process-global in C++. The V20
 * doc's "the Service owns playback" is implemented as *the Service drives
 * the session through this owner*, because the service and the UI are
 * in one process and therefore need no IPC to share state.
 *
 * ## Threading
 *
 * [handle] is `@Volatile` and may be read from any thread. Listener
 * dispatch is synchronous on whichever thread called [setHandle] —
 * today that is the React Native module queue. Listeners that touch
 * views must hop to the main thread themselves.
 */
object PlaybackHost {

    private val TAG = "PlaybackHost"

    /**
     * The active libmpv handle, or `0L` when mpv is not initialised.
     *
     * Mirrors the C++ global `g_mpv`. Never cached by callers: read it
     * through [handle] at the moment of use.
     */
    @Volatile
    private var nativePtr: Long = 0L

    /**
     * Notified once when the handle transitions from unavailable to
     * available. A `CopyOnWriteArraySet` because listeners register and
     * deregister from the Activity lifecycle while dispatch may be
     * happening on the module queue.
     */
    private val availabilityListeners = CopyOnWriteArraySet<(Long) -> Unit>()

    /**
     * The active libmpv handle, or `0L` if mpv has not been initialised
     * (or has been destroyed).
     *
     * Call this at the point of use. Do not store the result.
     */
    fun handle(): Long = nativePtr

    /**
     * Publish a newly created handle and notify anything waiting on it.
     *
     * Idempotent with respect to availability: a second call with a
     * non-zero handle re-notifies, which is what a consumer that mounted
     * late needs. Callers should therefore treat the listener as
     * "the handle is available, here it is" rather than "this exact
     * transition happened".
     */
    fun publishHandle(ptr: Long) {
        nativePtr = ptr
        if (ptr == 0L) return
        var delivered = 0
        for (listener in availabilityListeners) {
            try {
                listener(ptr)
                delivered++
            } catch (t: Throwable) {
                // One bad listener must not prevent the others from
                // learning that playback is available.
                android.util.Log.w(TAG, "availability listener threw: ${t.message}", t)
            }
        }
        android.util.Log.i(
            TAG,
            "handle published ptr=$ptr to $delivered/${availabilityListeners.size} listener(s)",
        )
    }

    /**
     * Drop the handle. Any consumer that reads [handle] afterwards gets
     * `0L` and every call into mpv is refused by the native lease guard,
     * which is the correct behaviour for a destroyed engine.
     */
    fun clearHandle() {
        nativePtr = 0L
        android.util.Log.i(TAG, "handle cleared")
    }

    /**
     * Register [listener] for handle availability. If the handle is
     * *already* available the listener is invoked immediately and
     * synchronously, so a late-mounting consumer converges without any
     * polling on its side.
     */
    fun whenAvailable(listener: (Long) -> Unit) {
        availabilityListeners.add(listener)
        val current = nativePtr
        if (current != 0L) {
            try {
                listener(current)
            } catch (t: Throwable) {
                android.util.Log.w(TAG, "immediate availability call threw: ${t.message}", t)
            }
        }
    }

    /** Deregister a listener registered with [whenAvailable]. */
    fun cancelWhenAvailable(listener: (Long) -> Unit) {
        availabilityListeners.remove(listener)
    }
}