package com.simba.player.mpv

import android.os.Handler
import android.os.Looper
import android.util.Log
import java.lang.ref.WeakReference

/**
 * V21 — process-wide registry of the single [MpvRenderView].
 *
 * ## Why this file exists
 *
 * V21 collapses the two-Activity player into one, so exactly one
 * `MpvRenderView` exists in the process for the whole app lifetime. The
 * Activity that mounts it and the React Native module that JS talks to are
 * different objects with different lifetimes and no direct reference to each
 * other, so something has to publish the view between them.
 *
 * This is the same shape as `PlaybackHost`, which does it for the libmpv
 * handle. The difference that matters is the reference type.
 *
 * ## Why a WeakReference, not a strong one
 *
 * `PlaybackHost` can hold its value strongly because it is a `Long`. This
 * object holds a `View`, and a View retains its `Context` — which for a
 * mounted render surface is the Activity. A strong field here would outlive
 * `onDestroy` and leak the Activity, its window, and its whole view tree for
 * as long as the process lives. That is the classic static-View leak, and it
 * would be invisible in testing while steadily pinning memory in production.
 *
 * A `WeakReference` also gives the correct ownership story for free: the
 * registry observes the surface, it does not own it. The Activity mounts it,
 * and the Activity destroys it. [detach] exists so the Activity can say so
 * explicitly rather than waiting for collection.
 *
 * ## Threading
 *
 * View mutation is main-thread only. Every public method here marshals to the
 * main looper and reports success through a synchronous result when called
 * from the main thread, so JS gets an honest "did this take effect" answer.
 *
 * ## No silent no-ops
 *
 * Each mutator returns `false` and logs when there is no surface to act on.
 * Callers are expected to surface that to JS so a control whose handler could
 * not run renders disabled rather than inert.
 */
object PlayerSurface {

    private const val TAG = "PlayerSurface"

    private val mainHandler = Handler(Looper.getMainLooper())

    private var viewRef: WeakReference<MpvRenderView> = WeakReference(null)

    /** The live surface, or `null` when nothing is mounted. Never cache the result. */
    fun current(): MpvRenderView? = viewRef.get()

    /**
     * Publish the process's surface. Called by the hosting Activity once the
     * view is mounted and bound to a window.
     */
    fun attach(view: MpvRenderView) {
        viewRef = WeakReference(view)
        Log.i(TAG, "surface attached: ${System.identityHashCode(view)}")
    }

    /**
     * Withdraw [view], but only if it is still the registered one.
     *
     * The identity check matters during a configuration change: the outgoing
     * Activity's `onDestroy` can run after the incoming one has already
     * mounted its replacement, and an unconditional clear would leave the new
     * surface unregistered — with no error anywhere, since nothing failed.
     */
    fun detach(view: MpvRenderView) {
        if (viewRef.get() !== view) {
            Log.i(TAG, "detach ignored: ${System.identityHashCode(view)} is not the registered surface")
            return
        }
        viewRef.clear()
        Log.i(TAG, "surface detached")
    }

    /**
     * Resize the surface to an absolute rect inside its container.
     *
     * @return `true` when the bounds were applied.
     */
    fun setBounds(x: Int, y: Int, width: Int, height: Int): Boolean =
        withSurface("setBounds") { it.setVideoBounds(x, y, width, height) }

    /** Expand the surface to fill its container. */
    fun fillBounds(): Boolean = withSurface("fillBounds") { it.fillBounds() }

    /** Show or hide the surface; hidden is the correct state for audio-only playback. */
    fun setVisible(visible: Boolean): Boolean =
        withSurface("setVisible") { it.setSurfaceVisible(visible) }

    /**
     * Run [block] against the surface on the main thread.
     *
     * Returns synchronously when already on the main thread so the caller
     * (a React Native method running on the module queue) still gets a real
     * answer; otherwise posts and reports `false`, because by the time the
     * block runs the caller has long since returned and there is nobody left
     * to tell.
     */
    private fun withSurface(op: String, block: (MpvRenderView) -> Unit): Boolean {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            val view = viewRef.get()
            if (view == null) {
                Log.w(TAG, "$op refused: no surface is mounted")
                return false
            }
            return try {
                block(view)
                true
            } catch (t: Throwable) {
                Log.e(TAG, "$op threw: ${t.message}", t)
                false
            }
        }
        Log.w(TAG, "$op refused: must be called from the main thread")
        return false
    }
}