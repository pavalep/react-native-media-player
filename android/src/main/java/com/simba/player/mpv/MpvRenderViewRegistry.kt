package com.simba.player.mpv

import java.lang.ref.WeakReference

/**
 * The live Fabric picture views.
 *
 * ## Why this file exists
 *
 * `PlayerSurface` was the process-wide registry of "the one surface mpv draws
 * into". It was written by `PlayerSurface.mount()`, which the V21/V22
 * architecture no longer calls: the picture is now a child of the React tree
 * (`<SimbaVideo />` → `SimbaVideoView` → `MpvRenderView`), created by
 * [MpvRenderViewManager] and destroyed by React Native.
 *
 * So `PlayerSurface.current()` answered `null` **forever**, and everything
 * that asked it got a wrong answer:
 *
 *  - `MpvBridgeModule.isSurfaceMounted()` always answered `false`, so
 *    `commands.openPlayer(...)` refused **every** video — including the ones
 *    the consumer had a picture mounted for.
 *
 * This registry is the replacement. It is written by the ViewManager that
 * creates the views, so it is true by construction rather than by a call
 * nobody makes.
 *
 * ## Why it is separate from `PlayerSurface`, and not a rewrite of it
 *
 * `PlayerSurface` also owns the mutators that place a surface
 * (`setBounds` / `fillBounds` / `setVisible`). Those mutate `LayoutParams`
 * from Kotlin, which `react-native-video` documents as a hazard: React
 * Native's layout pass can be deferred for a surface view, so a surface
 * placed outside Yoga can be measured against a stale rect. The picture is
 * laid out by Yoga now, and it must stay that way.
 *
 * So this registry answers **one** question — "is there a live picture
 * view?" — and nothing else. It cannot place a surface, and the mutators
 * stay exactly where they were.
 *
 * ## Weak references, for the same reason `PlayerSurface` uses them
 *
 * A `View` retains its `Context`, and for a mounted surface that Context is
 * the Activity. A strong static field would outlive `onDestroy` and pin the
 * Activity, its window and its whole view tree for as long as the process
 * lives — the classic static-View leak, invisible in testing and fatal in
 * production. The registry observes the views; React Native owns them.
 *
 * ## Threading
 *
 * The ViewManager creates and drops views on the UI thread, and
 * `isSurfaceMounted()` is read from the bridge's thread. The list is
 * therefore guarded by its own monitor, and every read prunes the entries
 * whose view has been collected.
 */
object MpvRenderViewRegistry {

    private const val TAG = "MpvRenderViewRegistry"

    /** The live picture views. Weak, so the registry never owns a View. */
    private val refs = mutableListOf<WeakReference<MpvRenderView>>()

    /**
     * Publish [view] as a live picture.
     *
     * Called by [MpvRenderViewManager] when it creates the view, and by
     * nobody else — a host app does not register surfaces by hand.
     */
    @JvmStatic
    fun register(view: MpvRenderView) {
        synchronized(refs) {
            prune()
            if (refs.none { it.get() === view }) {
                refs.add(WeakReference(view))
            }
        }
        android.util.Log.i(TAG, "picture registered: ${System.identityHashCode(view)}")
    }

    /**
     * Withdraw [view], but only if it is still registered.
     *
     * Identity-safe: withdrawing a view that is not the registered one
     * leaves the live registration alone, so a stale teardown cannot
     * unregister its replacement.
     */
    @JvmStatic
    fun unregister(view: MpvRenderView) {
        val removed = synchronized(refs) {
            val before = refs.size
            refs.removeAll { it.get() === view || it.get() == null }
            before - refs.size
        }
        if (removed > 0) {
            android.util.Log.i(TAG, "picture unregistered: ${System.identityHashCode(view)}")
        }
    }

    /**
     * The live picture view, or `null` when none is mounted.
     *
     * Never cache the result — a view can be dropped at any time.
     */
    @JvmStatic
    fun current(): MpvRenderView? {
        synchronized(refs) {
            prune()
            for (ref in refs) {
                val view = ref.get()
                if (view != null) return view
            }
            return null
        }
    }

    /**
     * Whether a picture view is mounted.
     *
     * This is the honest answer to "is there somewhere to put a video?" — a
     * picture view exists in the React tree, so a video loaded now has
     * somewhere to land. It does **not** claim the view is laid out or that
     * its surface has been created: the view is created by React Native
     * before it is attached, and mpv renders into it as soon as the
     * `SurfaceHolder` delivers a surface.
     */
    @JvmStatic
    fun hasLiveView(): Boolean = current() != null

    /** Drop the entries whose view has been collected. */
    private fun prune() {
        refs.removeAll { it.get() == null }
    }
}
