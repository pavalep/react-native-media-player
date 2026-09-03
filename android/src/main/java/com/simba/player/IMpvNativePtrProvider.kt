package com.simba.player

/**
 * Module-side contract that lets non-RN consumers (e.g. `PlayerActivity`)
 * fetch the active libmpv native pointer without crossing the Gradle
 * module boundary into the consumer app's bridge code.
 *
 * Why this exists:
 *  - `MpvBridgeModule` lives in the consumer app at
 *    `com.simba.player.mpv.MpvBridgeModule`. The module cannot import
 *    it directly (Gradle does not let a library depend on its consumer).
 *  - But `PlayerActivity` (which lives in the module) needs to call
 *    `mpvRenderView.setNativePtr(ptr)` so the SurfaceView can attach
 *    to mpv's `wid`. That ptr is owned by `MpvBridgeModule`.
 *  - Solution: `MpvBridgeModule` implements this interface; module
 *    code looks it up via `reactContext.getNativeModule("MpvPlayerModule")`
 *    and casts to `IMpvNativePtrProvider`. The cast is safe because
 *    we control both sides of the boundary.
 *
 * Phase 7 deliverable. The bridge-side ReactMethod `getNativePtr(): Double`
 * remains unchanged (keeps the JS-facing API stable) — this interface is
 * the native-only accessor used by the module's own activity code.
 */
interface IMpvNativePtrProvider {
    /**
     * @return the active libmpv handle as a `Long`, or `0L` if mpv has
     *         not been initialized yet (or has been destroyed).
     */
    fun fetchNativePtr(): Long
}