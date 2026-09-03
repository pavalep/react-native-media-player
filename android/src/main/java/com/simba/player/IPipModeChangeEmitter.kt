package com.simba.player

/**
 * Module-side contract that lets `PlayerActivity` (in the module)
 emit PiP mode-change events to JS without holding a direct reference
 to `MpvBridgeModule` (which lives in the consumer app's
 `com.simba.player.mpv` package — Gradle forbids the module from
 importing the app).
 *
 * Pattern mirrors [IMpvNativePtrProvider] (Phase 7): the consumer
 * app's bridge module implements this contract; module code looks it up
 * via `reactContext.getNativeModule("MpvPlayerModule") as?
 * IPipModeChangeEmitter` and casts. The cast is safe because we
 * control both sides of the boundary.
 *
 * Phase 10 deliverable: `PlayerActivity.onPictureInPictureModeChanged`
 * looks up the bridge module and calls [emitPictureInPictureModeChanged]
 * so JS receives the same `onPipModeChanged` event it received in V11
 * (where `MainActivity.onPictureInPictureModeChanged` called
 * `MpvBridgeModule.onPictureInPictureModeChanged(isInPip)` directly).
 *
 * Why a separate interface (not extend [IMpvNativePtrProvider]):
 * `IMpvNativePtrProvider` is a single-method contract focused on the
 * mpv native handle. PiP mode changes are a distinct capability with
 * its own event payload (`isInPip: Boolean`). Keeping the contracts
 * separate means each is independently mockable in tests and each
 * fails loudly at the cast site if the bridge module ever drops one
 * capability while keeping the other.
 */
interface IPipModeChangeEmitter {
    /**
     * Tell the JS layer that the activity entered / exited PiP mode.
     * Emits an `onPipModeChanged` event with `{ isInPip: Boolean }` to
     * the JS `DeviceEventEmitter`.
     */
    fun emitPictureInPictureModeChanged(isInPictureInPictureMode: Boolean)
}