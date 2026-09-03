package com.simba.player

/**
 * Module-side contract that lets `PlayerActivity` (in the module) read
 * the latest `PlayerConfig` (set by `<PlayerProvider config={...}>` in
 * JS) without crossing the Gradle module boundary into the consumer
 * app's bridge code.
 *
 * Pattern mirrors [IMpvNativePtrProvider] (Phase 7) and
 * [IPipModeChangeEmitter] (Phase 10): the consumer app's
 * `MpvBridgeModule` implements this contract; module code looks it up
 * via `reactContext.getNativeModule("MpvPlayerModule") as?
 * IMpvConfigProvider` and casts. The cast is safe because we control
 * both sides of the boundary.
 *
 * Phase 21 deliverable: `PlayerActivity.onCreate` looks up the bridge
 * module and calls [getCurrentConfig] so the activity logs which keys
 * are active (matches the spec's "verify config is picked up" step).
 * Future phases (22-25) extend the lookup to read theme + pip + audio
 * settings and apply them.
 *
 * Why a separate interface (not extend [IMpvNativePtrProvider]):
 * each capability is independently mockable in tests and each fails
 * loudly at the cast site if the bridge module ever drops one while
 * keeping the other.
 */
interface IMpvConfigProvider {
    /**
     * @return the most recent PlayerConfig pushed via
     *         `MpvPlayerModule.setConfig(...)`, as a Kotlin Map mirroring
     *         the JSON structure. `null` when no config has been set
     *         yet (the consumer app never wrapped its root in
     *         `<PlayerProvider>`).
     */
    fun getCurrentConfig(): Map<String, Any?>?
}
