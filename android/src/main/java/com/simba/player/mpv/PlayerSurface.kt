package com.simba.player.mpv

import android.app.Activity
import android.os.Looper
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
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
 * View mutation is main-thread only. Every public method here refuses off the
 * main thread rather than posting, because a posted mutation has no caller left
 * to report success to, and a `Promise<boolean>` that resolves before the work
 * happens is a lie. JS therefore gets a synchronous, honest answer.
 *
 * ## No silent no-ops
 *
 * Each mutator returns `false` and logs when there is no surface to act on.
 * Callers are expected to surface that to JS so a control whose handler could
 * not run renders disabled rather than inert.
 *
 * ## The surface is always mounted hidden
 *
 * [mount] creates the view `GONE` and `0x0`. That is deliberate and is the
 * reason no host can accidentally end up with a full-bleed surface covering its
 * own UI: making the surface visible is always an explicit, separate act, via
 * [setVisible], and giving it size is always an explicit act, via [fillBounds]
 * or [setBounds]. "Playing video" is therefore always two deliberate calls
 * rather than an emergent property of having constructed the view.
 */
object PlayerSurface {

    private const val TAG = "PlayerSurface"

    private var viewRef: WeakReference<MpvRenderView> = WeakReference(null)

    /** The live surface, or `null` when nothing is mounted. Never cache the result. */
    fun current(): MpvRenderView? = viewRef.get()

    /**
     * Create, position and register the process's single [MpvRenderView] inside
     * [activity], beneath its React root.
     *
     * This is the only sanctioned way to put a render surface on screen. The
     * hosting Activity hands over an Activity; it never constructs, lays out or
     * registers the view itself. That keeps exactly one implementation of
     * "where does the surface go and what layer is it on" — previously that
     * knowledge was duplicated per-Activity, which is how a host and the
     * bridge ended up disagreeing about whether a surface existed at all.
     *
     * The view is added at index 0 of `android.R.id.content` so it sits below
     * the React tree, and is left `GONE` at `0x0`; see the class docblock.
     *
     * @return the mounted view, or `null` when mounting was refused. Refusal is
     *   always logged with the reason — never swallowed.
     */
    @JvmStatic
    fun mount(activity: Activity): MpvRenderView? {
        if (Looper.myLooper() != Looper.getMainLooper()) {
            Log.e(TAG, "mount refused: must be called from the main thread")
            return null
        }

        // Idempotent: a configuration change recreates the Activity, and the
        // outgoing instance's onDestroy can run after the incoming one has
        // already mounted. Reuse rather than orphan the first surface.
        val existing = viewRef.get()
        if (existing != null && existing.parent != null) {
            Log.i(TAG, "mount reused the already-mounted surface ${System.identityHashCode(existing)}")
            return existing
        }

        val root = activity.findViewById<ViewGroup>(android.R.id.content)
            ?: run {
                Log.e(TAG, "mount refused: ${activity.javaClass.simpleName} has no android.R.id.content")
                return null
            }
        if (root !is FrameLayout) {
            // Not fatal — a non-FrameLayout container cannot take FrameLayout
            // params, and setVideoBounds() then no-ops via frameParams(). Say so
            // loudly rather than layering wrongly and shipping a black screen.
            Log.e(
                TAG,
                "mount: content root is ${root.javaClass.simpleName}, not FrameLayout; " +
                    "explicit video bounds will not be applied",
            )
            return null
        }

        val view = MpvRenderView(activity).apply {
            layoutParams = FrameLayout.LayoutParams(0, 0)
            visibility = View.GONE
        }
        root.addView(view, 0)
        attach(view)
        Log.i(TAG, "surface mounted beneath the React root, hidden and 0x0")
        return view
    }

    /**
     * Remove [view] from its container and withdraw it from the registry.
     *
     * Identity-safe: passing a view that is not the registered one only removes
     * that view and leaves the live registration alone, so an outgoing
     * Activity's teardown cannot unregister its replacement's surface.
     */
    @JvmStatic
    fun unmount(view: MpvRenderView) {
        if (Looper.myLooper() != Looper.getMainLooper()) {
            Log.e(TAG, "unmount refused: must be called from the main thread")
            return
        }
        detach(view)
        (view.parent as? ViewGroup)?.removeView(view)
        Log.i(TAG, "surface unmounted and withdrawn from the registry")
    }

    /**
     * Publish the process's surface. Called by [mount].
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