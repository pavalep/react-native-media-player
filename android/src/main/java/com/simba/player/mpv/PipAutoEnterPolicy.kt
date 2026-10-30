package com.simba.player.mpv

/**
 * The Picture-in-Picture auto-enter policy.
 *
 * ## Why this is its own object
 *
 * `PipConfig.autoEnterOnLeave` was declared in the public TypeScript
 * config type, documented in the README as "auto-enter on home /
 * recents / app-switcher", and defaulted to `true` — and NOTHING read
 * it. Not the JS layer, not the native layer. The flag was a public
 * promise with no implementation behind it: a consumer who set it got
 * exactly the same behaviour as one who did not, and the README
 * described a feature that could not happen.
 *
 * The config already reaches the native module — `setConfig` parses
 * the whole RESOLVED config into a map — so the value was sitting
 * there, unread, on the Kotlin side.
 *
 * The DECISION is what is worth testing, and it is pure: read a config
 * map, answer "should the Activity auto-enter PiP?". That is this
 * object. Applying it to an Activity needs an Android runtime, so that
 * half lives in `MpvBridgeModule` and is as thin as it can be.
 */
internal object PipAutoEnterPolicy {

    /**
     * The flag the Activity should carry, or `null` when the config
     * says nothing about auto-enter.
     *
     * `null` is a DIFFERENT answer from `false`, and the difference
     * matters:
     *
     *  - `null`  — the config does not mention auto-enter. Leave the
     *              Activity alone. Do NOT turn the feature off just
     *              because nobody asked for it.
     *  - `false` — the config asks for auto-enter to be off.
     *  - `true`  — the config asks for auto-enter to be on.
     *
     * `pip.enabled` is the master switch for every PiP entry request,
     * so a disabled PiP means auto-enter is off whatever
     * `autoEnterOnLeave` says. The two flags are not independent.
     *
     * A value of the wrong type is treated as "not mentioned" rather
     * than as `false`: a config that says something this code does
     * not understand must not silently disable a feature.
     */
    fun desiredAutoEnter(config: Map<String, Any?>?): Boolean? {
        val pip = config?.get("pip") as? Map<*, *> ?: return null
        val enabled = pip["enabled"] as? Boolean ?: return null
        val autoEnter = pip["autoEnterOnLeave"] as? Boolean ?: return null
        return enabled && autoEnter
    }
}
