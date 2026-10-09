package com.simba.player.mpv

import android.content.Context
import android.util.Log
import android.view.Gravity
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.View
import android.widget.FrameLayout

/**
 * SurfaceView-backed video renderer that hands an Android Surface to libmpv
 * for video output.
 *
 * Implementation is a deliberate clone of heritage mpv-android's BaseMPVView
 * (https://github.com/mpv-android/mpv-android/blob/master/app/src/main/java/is/xyz/mpv/BaseMPVView.kt)
 * which is the proven reference: mpvKt — a maintained Android media player
 * based on mpv-android that advertises "Smoother PiP" as a headline feature —
 * extends BaseMPVView unchanged and PiP works without any extra hooks.
 *
 * Why SurfaceView and not TextureView (tested both):
 *  - TextureView depends on the activity's view-tree draw pass. When the
 *    Activity pauses for PiP, HWUI suspends draw passes for paused activities
 *    and the TextureView's display layer becomes stale even though the
 *    SurfaceTexture keeps receiving producer buffers. PiP shows black.
 *  - SurfaceView with default z-order (BELOW the activity window) is on a
 *    separate SurfaceFlinger layer that SurfaceFlinger composites directly,
 *    independent of the activity's view-tree draw state. PiP captures it
 *    correctly even while the activity is paused.
 *
 * Why default z-order (NOT setZOrderOnTop / setZOrderMediaOverlay):
 *  - setZOrderOnTop puts the SurfaceView ABOVE the activity window on its
 *    own layer. PiP's VRI compositor samples the activity window content
 *    and does not include this overlay layer.
 *  - setZOrderMediaOverlay places the SurfaceView in the media overlay
 *    layer, also outside the VRI.
 *  - With default z-order, the SurfaceView is composited INTO the activity
 *    window's drawing output, which the VRI samples. This is what mpvKt
 *    uses and is the only configuration that works.
 *
 * Lifecycle:
 *  - surfaceCreated → attachSurface() (force-window=yes)
 *  - surfaceChanged → notify mpv of new size
 *  - surfaceDestroyed → detachSurface() (force-window=no)
 *
 * force-window is sticky-on / sticky-off matched to surface availability —
 * exactly as in BaseMPVView. The view does NOT manually toggle force-window
 * on PiP entry/exit; that is correct because PiP does NOT destroy/recreate
 * the SurfaceHolder for a SurfaceView that remains visible.
 *
 * Phase 6: Constructor widened from `ThemedReactContext` to `Context` so
 * PlayerActivity (which only has an Activity, not a ThemedReactContext) can
 * instantiate it directly. The existing MpvRenderViewManager passes a
 * ThemedReactContext which is a Context, so the change is backward-compatible.
 *
 * Phase 6: Relocated to the `@simba/react-native-media-player` module so
 * PlayerActivity (which lives in the module) can directly instantiate it
 * without crossing the module boundary. MpvRenderViewManager (which stays
 * in the consumer app) references the same FQN and uses the module's copy.
 */
class MpvRenderView(context: Context) : SurfaceView(context),
    SurfaceHolder.Callback {

    private var nativePtr: Long = 0L
    // Surface identity guard — only re-attach if the Surface is new.
    // SurfaceView reuses the same Surface across config changes and PiP
    // transitions, so this is normally a no-op after first attach.
    private var attachedSurface: android.view.Surface? = null

    companion object {
        private const val TAG = "MpvRenderView"
    }

    init {
        holder.addCallback(this)
        layoutParams = FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.MATCH_PARENT
        )
        // Default z-order (BELOW the activity window) is intentional and
        // required for PiP. Do NOT call setZOrderOnTop or setZOrderMediaOverlay.
        isFocusable = false
        isClickable = false
    }

    // ── Bounds (V21) ──────────────────────────────────────────────────────
    //
    // V21 moves the player into the consumer app's single Activity, where
    // the same MpvRenderView must render both fullscreen and as the
    // in-app mini player's live picture.
    //
    // These mutate `LayoutParams` and nothing else. That distinction is
    // the whole point: `removeView`/`addView` would destroy and recreate
    // the Surface, forcing mpv to re-attach and flashing black, whereas a
    // LayoutParams change re-lays-out the existing SurfaceView in place.
    // Because the surface composites BELOW the window, shrinking it to a
    // small rect leaves the React tree drawing normally everywhere else.
    //
    // This is the same mechanism the audio mini bar already relies on.

    /**
     * Place the surface at an absolute rect, in pixels, inside the host
     * container. Used by the in-app mini player.
     *
     * Refuses non-positive extents rather than clamping: a zero-sized
     * SurfaceView is an invalid target for libmpv, and silently substituting
     * a default here would hide a real layout bug behind a plausible-looking
     * black frame.
     */
    fun setVideoBounds(x: Int, y: Int, width: Int, height: Int) {
        if (width <= 0 || height <= 0) {
            Log.w(TAG, "setVideoBounds refused ${width}x$height at ($x,$y): extents must be > 0")
            return
        }
        val lp = frameParams()
        lp.width = width
        lp.height = height
        lp.gravity = Gravity.TOP or Gravity.START
        lp.leftMargin = x
        lp.topMargin = y
        layoutParams = lp
        Log.i(TAG, "setVideoBounds -> ${width}x$height at ($x,$y)")
    }

    /** Expand the surface to fill the host container. */
    fun fillBounds() {
        val lp = frameParams()
        lp.width = FrameLayout.LayoutParams.MATCH_PARENT
        lp.height = FrameLayout.LayoutParams.MATCH_PARENT
        lp.gravity = Gravity.TOP or Gravity.START
        lp.leftMargin = 0
        lp.topMargin = 0
        layoutParams = lp
        Log.i(TAG, "fillBounds -> MATCH_PARENT")
    }

    private fun frameParams(): FrameLayout.LayoutParams =
        (layoutParams as? FrameLayout.LayoutParams)
            ?: FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT,
            )

    // ── Surface attachment ─────────────────────────────────────────────────

    override fun surfaceCreated(holder: SurfaceHolder) {
        Log.d(TAG, "surfaceCreated")
        attachSurfaceLocked(holder.surface)
    }

    override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {
        Log.d(TAG, "surfaceChanged: ${width}x$height")
        if (nativePtr != 0L) {
            MPVLib.setPropertyString(nativePtr, "android-surface-size", "${width}x$height")
        }
    }

    override fun surfaceDestroyed(holder: SurfaceHolder) {
        Log.d(TAG, "surfaceDestroyed")
        detachSurfaceLocked()
    }

    // ── Public API ─────────────────────────────────────────────────────────

    /**
     * Call when the native mpv handle is available.
     */
    fun setNativePtr(ptr: Long) {
        nativePtr = ptr
        // New handle — any previously attached surface must be rebound
        // (mpv's wid still points at the previous handle's surface).
        attachedSurface = null
        ensureSurfaceAttached("setNativePtr")
    }

    /**
     * Show or hide the surface.
     *
     * [View.GONE] for audio-only playback: mpv keeps running audio with no
     * render target, which is the correct configuration.
     *
     * Flipping back to [View.VISIBLE] re-evaluates the surface binding, so a
     * GONE → VISIBLE transition (audio mini player → video mini player) does
     * not need the caller to know anything about Surface lifetimes.
     */
    fun setSurfaceVisible(visible: Boolean) {
        val target = if (visible) View.VISIBLE else View.GONE
        if (visibility == target) return
        Log.i(TAG, "setSurfaceVisible(visible=$visible)")
        visibility = target
        if (visible) ensureSurfaceAttached("setSurfaceVisible")
    }

    /**
     * Re-attempt the mpv ↔ Surface binding if it is not currently established.
     *
     * The binding has three independent preconditions — a live mpv handle, a
     * valid Surface, and this view being attached to a window — and any of
     * them can become true after any other. Hooking the two lifecycle
     * callbacks that can flip them means callers never have to re-assert
     * the binding by hand.
     */
    fun ensureSurfaceAttached(reason: String) {
        if (attachedSurface != null) return
        if (nativePtr == 0L) return
        if (!isAttachedToWindow) return
        val surface = holder.surface ?: return
        if (!surface.isValid) return
        Log.i(TAG, "ensureSurfaceAttached($reason): binding surface to mpv")
        attachSurfaceLocked(surface)
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        ensureSurfaceAttached("onAttachedToWindow")
    }

    override fun onVisibilityChanged(changedView: View, visibility: Int) {
        super.onVisibilityChanged(changedView, visibility)
        if (visibility == View.VISIBLE) ensureSurfaceAttached("onVisibilityChanged")
    }

    private fun attachSurfaceLocked(surface: android.view.Surface?) {
        // Defensive guards. Each precondition can be false independently and
        // legitimately — there is no error to report, only a binding that is
        // not yet possible. `ensureSurfaceAttached` re-runs once the missing
        // precondition becomes true.
        if (nativePtr == 0L) return
        if (surface == null) return
        if (!surface.isValid) return
        // A SurfaceView that is not attached to a window has no Surface
        // Flinger layer to composite, so handing it to mpv produces a render
        // target that can never be seen.
        //
        // Note this is NOT the same condition as `visibility == GONE`: a
        // GONE view is still attached to its window. An earlier revision of
        // this comment claimed they were equivalent and blamed audio mode,
        // which is why audio→video had no reliable path back to a bound
        // surface.
        if (!isAttachedToWindow) {
            Log.d(TAG, "attachSurfaceLocked: not attached to a window, deferring")
            return
        }
        if (attachedSurface === surface) return // same Surface → no-op
        Log.d(TAG, "Attaching Surface to mpv")
        MPVLib.nativeAttachSurface(nativePtr, surface)
        // Sticky: keep force-window=yes whenever the surface is available.
        // Do NOT toggle on PiP entry — PiP does not destroy the surface for
        // a visible SurfaceView, and toggling force-window can interfere
        // with mpv's render decision mid-frame.
        MPVLib.setPropertyString(nativePtr, "force-window", "yes")
        MPVLib.setPropertyString(nativePtr, "vo", "gpu")
        attachedSurface = surface
    }

    private fun detachSurfaceLocked() {
        if (nativePtr == 0L) return
        if (attachedSurface == null) return
        Log.d(TAG, "Detaching Surface from mpv")
        // Disable the gpu VO first so any in-flight render command does
        // not access the ANativeWindow after we release the global ref.
        // Match BaseMPVView: turn off force-window here so that an mpv
        // instance with no surface does not try to render.
        MPVLib.setPropertyString(nativePtr, "vo", "null")
        MPVLib.setPropertyString(nativePtr, "force-window", "no")
        MPVLib.nativeAttachSurface(nativePtr, null)
        attachedSurface = null
    }

    /**
     * Must be called when the mpv instance is destroyed.
     */
    fun cleanup() {
        detachSurfaceLocked()
        nativePtr = 0L
    }
}