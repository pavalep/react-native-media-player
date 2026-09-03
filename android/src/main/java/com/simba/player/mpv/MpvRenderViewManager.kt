package com.simba.player.mpv

import android.view.View
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.common.MapBuilder
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.SimpleViewManager
import com.facebook.react.uimanager.annotations.ReactProp

/**
 * View Manager for the mpv rendering SurfaceView.
 *
 * This allows the mpv video output surface to be used as a React Native
 * component from JS, e.g.:
 *
 *   <MpvRenderView nativePtr={nativePtr} style={{flex: 1}} />
 */
class MpvRenderViewManager : SimpleViewManager<MpvRenderView>() {

    companion object {
        const val REACT_CLASS = "MpvRenderView"
    }

    override fun getName(): String = REACT_CLASS

    override fun createViewInstance(reactContext: ThemedReactContext): MpvRenderView {
        return MpvRenderView(reactContext)
    }

    /**
     * Pass the native mpv pointer to the view so it can attach the Surface.
     */
    @ReactProp(name = "nativePtr")
    fun setNativePtr(view: MpvRenderView, nativePtr: Double) {
        view.setNativePtr(nativePtr.toLong())
    }

    override fun onDropViewInstance(view: MpvRenderView) {
        super.onDropViewInstance(view)
        view.cleanup()
    }
}
