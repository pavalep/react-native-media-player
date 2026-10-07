package com.simba.player

/**
 * Module-side contract that lets `PlayerActivity` (in the module) read
 * the latest `PlayerConfig` (set by `<PlayerProvider config={...}>` in
 * JS) without crossing the Gradle module boundary into the consumer
 * app's bridge code.
 *
 * Pattern mirrors [IPipModeChangeEmitter] (Phase 10): the consumer app's
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
 * Why this survives V20 Phase A while its sibling did not: this contract
 * carries data pushed *by React*, so it genuinely needs the React
 * context to reach. The native-pointer contract it used to mirror did
 * not — it carried a process-global, so V20 replaced it with
 * `PlaybackHost`, and it was deleted rather than left as fiction.
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
