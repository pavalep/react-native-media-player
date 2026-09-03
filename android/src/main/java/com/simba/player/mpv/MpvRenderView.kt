package com.simba.player.mpv

import android.content.Context
import android.util.Log
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.ViewGroup

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
        layoutParams = ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        )
        // Default z-order (BELOW the activity window) is intentional and
        // required for PiP. Do NOT call setZOrderOnTop or setZOrderMediaOverlay.
        isFocusable = false
        isClickable = false
    }

    // ── SurfaceHolder.Callback ─────────────────────────────────────────────

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

    // ── Surface attachment ─────────────────────────────────────────────────

    /**
     * Call when the native mpv handle is available.
     */
    fun setNativePtr(ptr: Long) {
        nativePtr = ptr
        // New handle — any previously attached surface must be rebound
        // (mpv's wid still points at the previous handle's surface).
        attachedSurface = null
        if (holder.surface != null && holder.surface.isValid) {
            attachSurfaceLocked(holder.surface)
        }
    }

    private fun attachSurfaceLocked(surface: android.view.Surface?) {
        // Phase 33 defensive guards (added to satisfy Phase 33.5 unit
        // test). The original code already guarded `nativePtr == 0L`
        // and `!surface.isValid`, but a null `surface` would NPE on
        // the `isValid` deref. In practice the public call sites
        // (`setNativePtr` + `surfaceCreated`) already check for null,
        // but a future refactor could forget — guard here too.
        if (nativePtr == 0L) return
        if (surface == null) return
        if (!surface.isValid) return
        // Phase 12.2.1: defensive guard for audio mode (View.GONE). When
        // the view is set to GONE in PlayerActivity (Phase 12.1.1), it
        // can still receive surfaceCreated (the holder is registered
        // and the Surface IS created), but the view has not been
        // attached to a window. Trying to drive an mpv render target
        // that has no window is a no-op at best and a crash on some
        // OEMs. Returning here is safe — when the view later becomes
        // visible / window-attached (e.g. user expands from PiP into a
        // full audio UI in a future phase), the holder will fire
        // surfaceChanged and we'll re-evaluate via setNativePtr's
        // re-attach path.
        if (!isAttachedToWindow) {
            Log.d(TAG, "attachSurfaceLocked: view not attached to window, skipping (likely audio mode / GONE)")
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