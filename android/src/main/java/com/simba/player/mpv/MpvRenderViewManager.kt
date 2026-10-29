package com.simba.player.mpv

import android.util.Log
import com.facebook.react.module.annotations.ReactModule
import com.facebook.react.uimanager.SimpleViewManager
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.annotations.ReactProp

/**
 * Fabric-facing ViewManager for the mpv rendering SurfaceView.
 *
 * This is what makes the video picture an ordinary child of the React tree
 * instead of a sibling of the React root. React Native then owns:
 *
 *  - **layout.** The view gets a real Yoga measure/layout pass. The previous
 *    path mutated `LayoutParams` directly from Kotlin, which
 *    `react-native-video` documents as a hazard - see its `ExoPlayerView`
 *    `requestLayout()` override: "React Native (Yoga) can sometimes defer
 *    layout passes that are required by ... surface view".
 *  - **z-order.** The surface no longer sits behind an opaque React root, so
 *    no screen has to blank itself around the player.
 *  - **lifecycle.** Mount and unmount are the same events for the surface as
 *    for any other view.
 *
 * The engine is deliberately *not* owned here. Playback control - `pause`,
 * `volume`, `seek`, PiP - belongs to `MpvBridgeModule`, which gives it exactly
 * one writer reachable from anywhere through `usePlayer().commands`. The
 * props below exist so the declarative form `<SimbaVideo paused={...} />` is
 * real rather than decorative; they write the same engine state those commands
 * do, so an app may drive the engine from props, from commands, or from both.
 */
@ReactModule(name = MpvRenderViewManager.REACT_CLASS)
class MpvRenderViewManager : SimpleViewManager<MpvRenderView>() {

  companion object {
    /** Must match `codegenNativeComponent<NativeProps>('SimbaVideoView')`. */
    const val REACT_CLASS = "SimbaVideoView"

    private const val TAG = "MpvRenderViewManager"
  }

  override fun getName(): String = REACT_CLASS

  override fun createViewInstance(reactContext: ThemedReactContext): MpvRenderView {
    val view = MpvRenderView(reactContext)
    // The picture is now a child of the React tree, so this manager is the
    // only thing that knows when one exists. It publishes the view to
    // [MpvRenderViewRegistry], which is what `isSurfaceMounted()` asks —
    // the answer is true by construction instead of by a call nobody makes.
    MpvRenderViewRegistry.register(view)
    return view
  }

  /**
   * Bind this surface to an mpv handle.
   *
   * Typed `Double` rather than `Int32`: mpv handles are 64-bit pointers, and
   * an `Int32` prop would truncate them to 32 bits and hand mpv a pointer to
   * nothing. Codegen maps the spec's `Double` to a Kotlin `double`.
   */
  @ReactProp(name = "nativePtr")
  fun setNativePtr(view: MpvRenderView, nativePtr: Double) {
    view.setNativePtr(nativePtr.toLong())
  }

  /**
   * Declarative pause.
   *
   * Inert while no handle is bound rather than guessing: `setNativePtr` is what
   * binds, and calling mpv with a zero handle throws. A view rendered before
   * the engine exists therefore stays inert until the handle arrives, at which
   * point [MpvRenderView.setNativePtr] rebinds and re-applies the pending
   * props.
   */
  @ReactProp(name = "paused", defaultBoolean = false)
  fun setPaused(view: MpvRenderView, paused: Boolean) {
    view.pendingPaused = paused
    val ptr = view.nativePtrHandle()
    if (ptr == 0L) return
    if (paused) MPVLib.nativePause(ptr) else MPVLib.nativePlay(ptr)
  }

  @ReactProp(name = "muted", defaultBoolean = false)
  fun setMuted(view: MpvRenderView, muted: Boolean) {
    view.pendingMuted = muted
    val ptr = view.nativePtrHandle()
    if (ptr == 0L) return
    MPVLib.nativeSetMuted(ptr, muted)
  }

  /**
   * Volume in mpv's native 0..100 range - the same range
   * `PlayerCommands.setVolume` uses, so a value read from the engine is a value
   * that can be handed straight back to it with no rescaling.
   */
  @ReactProp(name = "volume", defaultFloat = 100f)
  fun setVolume(view: MpvRenderView, volume: Float) {
    view.pendingVolume = volume
    val ptr = view.nativePtrHandle()
    if (ptr == 0L) return
    MPVLib.nativeSetVolume(ptr, volume.toDouble().coerceIn(0.0, 100.0))
  }

  /**
   * mpv's `video-zoom`, carried as a string because mpv properties are strings
   * and the spec declares this prop as `WithDefault<string, 'contain'>`.
   *
   *   `0` fit / letterbox · `1` fill / crop · `2` fill, aspect ignored
   *
   * Applied through [MpvRenderView] so a value that arrives before the handle
   * is held and re-applied on bind, instead of being silently lost against an
   * uninitialised mpv instance.
   */
  @ReactProp(name = "resizeMode")
  fun setResizeMode(view: MpvRenderView, resizeMode: String?) {
    view.applyVideoZoom(resizeMode)
  }

  /**
   * Release this view's surface binding.
   *
   * Deliberately does **not** destroy the engine: the view never owned it. A
   * React tree can unmount and remount this view freely - a re-parent, a theme
   * change, memory pressure - and playback has to survive that, because the
   * handle belongs to `MpvBridgeModule` and not to this view. Only the
   * surface↔mpv binding is released here.
   */
  override fun onDropViewInstance(view: MpvRenderView) {
    super.onDropViewInstance(view)
    Log.i(TAG, "onDropViewInstance: releasing surface binding, engine untouched")
    view.detachSurfaceForViewDrop()
    // The view is going away, so there is nowhere left to put a video.
    // `isSurfaceMounted()` must go back to answering false — otherwise a
    // control would keep offering "play video" for a picture that is gone.
    MpvRenderViewRegistry.unregister(view)
  }
}