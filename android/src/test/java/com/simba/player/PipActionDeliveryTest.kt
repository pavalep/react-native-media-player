package com.simba.player

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * B-0xx (2026-11-03) — "the PiP controls are the right size and do nothing".
 *
 * The platform's PiP action row rendered three buttons — Play/Pause,
 * Expand, Close — right beside the platform's OWN settings / expand /
 * close buttons. The platform's three worked (tapping the gear opened
 * the PiP settings screen). Ours were inert.
 *
 * Measured on emulator-5554 (API 37) with `dumpsys activity broadcasts`:
 *
 *   * Tapping our Play button produced **no broadcast record at all**.
 *     The platform's own buttons, tapped in the same state, worked.
 *   * Sending our action EXPLICITLY (`am broadcast -n
 *     com.simba.player/.PipActionReceiver`) was **never dispatched** —
 *     `dispatchTime=--` — in the foreground and in PiP alike.
 *   * Sending the very same action IMPLICITLY (`am broadcast -a
 *     com.simba.player.PIP_PLAY_PAUSE`) was **dispatched in 0 ms**.
 *
 * The last pair is the whole diagnosis. The receiver was registered and
 * matching the whole time — the ONLY thing wrong was the COMPONENT on
 * the intent. An explicit broadcast is resolved through the MANIFEST,
 * and `PipActionReceiver` was never declared there: it existed only as
 * a runtime registration, which an explicit broadcast cannot reach.
 *
 * ## What this test can and cannot prove
 *
 * The delivery itself needs a device. What is pinned here is the
 * SOURCE-level contract that made the delivery possible, because that
 * is where the defect lived: an intent shape, a registration, and a
 * registration that cannot happen twice.
 *
 * These are guard tests, not a device proof. The device proof is that
 * tapping Play in the platform's PiP action row pauses playback.
 *
 * ## Why the assertions read CODE and not prose
 *
 * The prose in `PipManager.kt` deliberately NAMES the APIs and the
 * strings it is talking about — that is how a reader learns why the
 * code looks the way it does. An assertion matched against the raw
 * text would therefore pass or fail on the COMMENT rather than on the
 * behaviour, which is exactly how a guard ends up pinning nothing.
 *
 * So every assertion here runs against the file with its comments
 * removed. The same shape the consumer app uses in
 * `__tests__/app/MainActivityBackPress.test.ts`.
 */
class PipActionDeliveryTest {

    // ── The intent shape ──────────────────────────────────────────────────

    @Test
    fun `the PiP action intent does NOT name a component`() {
        val code = code(pipManagerSource().readText())

        // An EXPLICIT intent is resolved through the MANIFEST. The
        // receiver is a runtime registration, so an explicit broadcast
        // found nothing to deliver to and was dropped before dispatch
        // (measured: `dispatchTime=--`).
        assertFalse(
            "the PiP action intent must stay IMPLICIT - an explicit " +
                "component is resolved through the manifest, and this " +
                "receiver is not declared there",
            code.contains("setClass("),
        )
    }

    @Test
    fun `the PiP action intent carries the action`() {
        val code = code(pipManagerSource().readText())

        // An implicit intent is matched by ACTION, which is what the
        // runtime registration filters on. Dropping the action would
        // leave a broadcast nobody can match.
        assertTrue(
            "the intent must carry the action - an implicit intent with " +
                "no action matches nothing",
            code.contains("val intent = Intent(action)"),
        )
    }

    // ── Who registers the receiver ────────────────────────────────────────

    @Test
    fun `the LIBRARY registers the PiP action receiver`() {
        val code = code(pipManagerSource().readText())

        // The platform's action row is the only way into these actions.
        // If nothing registers the receiver, the buttons are drawn and
        // inert — which is exactly what was measured.
        //
        // The registration belongs where the params are built, so it is
        // impossible to hand the platform a set of buttons that nothing
        // is listening for.
        assertTrue(
            "the params builder must have a body to register in",
            code.contains("fun buildPipParams("),
        )
        val paramsBuilder = code
            .substringAfter("fun buildPipParams(")
            .substringBefore("private fun buildRemoteAction")
        assertTrue(
            "the params builder must register the PiP action receiver - the " +
                "platform's action row has nowhere to deliver to otherwise",
            paramsBuilder.contains("registerActionReceiver(context)"),
        )
    }

    @Test
    fun `the receiver is registered ONCE per process`() {
        val code = code(pipManagerSource().readText())

        // The React context can be recreated (debug reload, process
        // restart) and the module with it. A second registration would
        // deliver every action twice, and a play/pause that toggles
        // twice leaves playback exactly where it was.
        assertTrue(
            "the registration must be guarded against running twice",
            code.contains("if (registered) return"),
        )
        assertTrue(
            "the guard must be synchronised - two threads could race " +
                "past a plain flag",
            code.contains("synchronized(registrationLock)"),
        )
    }

    @Test
    fun `the consumer CANNOT register a second receiver`() {
        val code = code(pipManagerSource().readText())

        // `intentFilter()` is what a consumer would need to register a
        // second receiver. It is `internal` so the compiler refuses the
        // attempt instead of letting it reach a runtime double-delivery
        // bug.
        assertTrue(
            "the intent filter must be internal - a public one invites a " +
                "consumer to register a second receiver, and every action " +
                "would then be delivered twice",
            code.contains("internal fun intentFilter()"),
        )
    }

    // ── Failures must be visible ──────────────────────────────────────────

    @Test
    fun `a failure to reach the engine is LOGGED`() {
        val source = pipManagerSource().readText()

        // A silent catch is how a row of dead buttons produced not one
        // line in the log. The engine can legitimately be gone (no handle,
        // or the file was closed), but that has to be visible.
        //
        // Scoped to the receiver's toggle, which is the whole delivery path
        // now: the action reaches the engine directly, with no JS in
        // between.
        val toggleBody = code(
            source
                .substringAfter("private fun togglePlayback()")
                .substringBefore("}\n}"),
        )
        assertFalse(
            "the receiver must not swallow a failure silently - that is " +
                "how the PiP buttons could be inert with an empty log",
            toggleBody.contains("catch (_: Exception)"),
        )
        assertTrue(
            "the failure must be logged",
            toggleBody.contains("cannot toggle playback"),
        )
        assertTrue(
            "a missing engine handle must be logged too",
            toggleBody.contains("no engine handle"),
        )
    }

    // ── Exactly one registration ──────────────────────────────────────────

    @Test
    fun `the library's manifest does NOT declare the receiver`() {
        val manifest = code(manifestSource().readText())

        // The receiver is a runtime registration. A manifest declaration
        // would give the same action TWO receivers - one manifest, one
        // runtime - and every action would be delivered twice.
        assertFalse(
            "the manifest must not declare PipActionReceiver - the " +
                "runtime registration is the only one, and a manifest " +
                "declaration would deliver every action twice",
            manifest.contains("com.simba.player.PipActionReceiver"),
        )
    }

    @Test
    fun `the library's manifest does NOT duplicate the action strings`() {
        val manifest = code(manifestSource().readText())

        // The action string is owned by `PipManager` as a Kotlin constant.
        // The manifest cannot reference a Kotlin constant, so a literal
        // there would give one fact two owners - and the two could drift.
        assertFalse(
            "the action strings must live in PipManager only",
            manifest.contains("PIP_PLAY_PAUSE"),
        )
    }

    // ── helpers ───────────────────────────────────────────────────────────

    /**
     * The file's CODE, with its comments removed.
     *
     * Block comments first, then line comments. A `//` inside a string
     * literal would be cut too - none of the files this test reads
     * contains one, and the alternative (prose-aware parsing) is not
     * worth a parser in a guard test.
     */
    private fun code(source: String): String =
        source
            .replace(Regex("/\\*.*?\\*/", RegexOption.DOT_MATCHES_ALL), "")
            .replace(Regex("//[^\\n]*"), "")

    private fun pipManagerSource(): File = findUp("src/main/java/com/simba/player/PipManager.kt")

    private fun manifestSource(): File = findUp("src/main/AndroidManifest.xml")

    /** Walk upwards from the test's working directory until the file is found. */
    private fun findUp(relative: String): File {
        val start = System.getProperty("user.dir") ?: "."
        var dir: File? = File(start).absoluteFile
        var depth = 0
        while (dir != null && depth < 8) {
            val candidate = File(dir, relative)
            if (candidate.isFile) return candidate
            dir = dir.parentFile
            depth++
        }
        throw AssertionError("$relative not found from ${System.getProperty("user.dir")}")
    }
}
