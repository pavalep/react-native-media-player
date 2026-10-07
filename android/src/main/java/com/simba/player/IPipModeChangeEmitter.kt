package com.simba.player

/**
 * Module-side contract that lets `PlayerActivity` (in the module)
 * emit PiP mode-change events to JS without holding a direct reference
 * to `MpvBridgeModule`.
 *
 * The consumer app's bridge module implements this contract; module code
 * looks it up via `reactContext.getNativeModule("MpvPlayerModule") as?
 * IPipModeChangeEmitter` and casts. The cast is safe because we control
 * both sides.
 *
 * Phase 10 deliverable: `PlayerActivity.onPictureInPictureModeChanged`
 * looks up the bridge module and calls [emitPictureInPictureModeChanged]
 * so JS receives the same `onPipModeChanged` event it received in V11
 * (where `MainActivity.onPictureInPictureModeChanged` called
 * `MpvBridgeModule.onPictureInPictureModeChanged(isInPip)` directly).
 *
 * Unlike the native-pointer contract this once mirrored, this one
 * genuinely needs the React context - it exists to deliver an event
 * *to JS*. That is why it survives V20 Phase A while that one was
 * deleted and replaced by `PlaybackHost`.
 */
interface IPipModeChangeEmitter {
    /**
     * Tell the JS layer that the activity entered / exited PiP mode.
     * Emits an `onPipModeChanged` event with `{ isInPip: Boolean }` to
     * the JS `DeviceEventEmitter`.
     */
    fun emitPictureInPictureModeChanged(isInPictureInPictureMode: Boolean)
}