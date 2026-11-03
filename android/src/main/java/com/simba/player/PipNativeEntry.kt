package com.simba.player

/**
 * The PURE facts of the native Picture-in-Picture entry.
 *
 * ## Why this file exists
 *
 * The HOME path enters PiP from NATIVE code — `MpvBridgeModule`'s
 * companion, `notifyUserLeaveHint(activity)` — because by the time the
 * user presses HOME, React Native has already paused the React
 * scheduler with the Activity: a React commit cannot land and there is
 * no frame clock. Measured on emulator-5554 (API 37) on 2026-11-03: the
 * JS handler ran immediately, the effect that would have driven the
 * entry ran 5.7 s late, and the `requestAnimationFrame` never fired.
 *
 * That native path has to produce the SAME two facts the JS path
 * produces — a title and a progress percentage — and it has to format
 * them the SAME way, because the PiP notification is one surface with
 * two writers. A title that differs by a quote character and a
 * percentage that differs by a space are two different facts about one
 * playing item.
 *
 * So the formatting lives HERE, in plain Kotlin with no Android classes
 * in it, and BOTH paths call it. That is what makes it testable on a
 * plain JVM: these are the functions the unit tests exercise, and they
 * need neither Robolectric nor a device nor a network download to run.
 *
 * ## What is deliberately NOT here
 *
 * Anything that touches Android (`View`, `Activity`,
 * `PictureInPictureParams`) or mpv (`MPVLib`) stays in
 * `MpvBridgeModule`. This file holds no state and has no side effects.
 */
internal object PipNativeEntry {

    /**
     * The consumer's chrome `nativeID`, read from the RESOLVED config.
     *
     * The literal belongs to the CONSUMER: the library stores it and
     * uses it, and never hardcodes one of its own. `null` means "this
     * consumer has no chrome of its own", which is a real answer and
     * not a missing value — the native path then has nothing to hide.
     */
    fun chromeNativeId(config: Map<String, Any?>?): String? {
        val pip = config?.get("pip") as? Map<*, *> ?: return null
        val raw = pip["chromeNativeId"] as? String ?: return null
        return raw.trim().takeIf { it.isNotEmpty() }
    }

    /**
     * mpv's `media-title` as a title, or `null` when there is none.
     *
     * mpv's properties come back JSON-encoded, so a string arrives
     * wrapped in quotes (`"Overrun!"`), and a property that is not set
     * arrives as the literal `null` — which is NOT a title.
     *
     * The title the consumer supplied is in here, and it is the SAME
     * fact and not a second one: the library writes it as mpv's
     * `force-media-title` BEFORE the load, and mpv reports it back as
     * `media-title`.
     */
    fun title(raw: String?): String? {
        val trimmed = raw?.trim()?.trim('"')?.trim() ?: return null
        if (trimmed.isEmpty()) return null
        if (trimmed.equals("null", ignoreCase = true)) return null
        return trimmed
    }

    /**
     * The progress percentage, formatted exactly as the consumer
     * formats it: an integer, a space, then `%` — `"45 %"`.
     *
     * `null` when there is no duration to divide by. A percentage of an
     * unknown length is not a fact.
     *
     * The rounding is JavaScript's `Math.round`, which is
     * `floor(x + 0.5)` — not the "ties to even" rule, so the native
     * path and the JS path cannot disagree by one percent on a .5
     * boundary.
     */
    fun progressPct(positionMs: Long, durationMs: Long): String? {
        if (durationMs <= 0L) return null
        val ratio = (positionMs.toDouble() / durationMs.toDouble()) * 100.0
        return "${kotlin.math.floor(ratio + 0.5).toInt()} %"
    }
}
