package com.simba.player.mpv

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * B-038 — "`pip.autoEnterOnLeave` is a public flag that nothing reads".
 *
 * `PipConfig.autoEnterOnLeave` was declared in the public TypeScript
 * config type (`src/types/config.ts`), defaulted to `true`, and
 * documented in the README as "auto-enter on home / recents /
 * app-switcher". Nothing read it. Not the JS layer, not the native
 * layer. The value was already reaching Kotlin — `setConfig` parses the
 * whole RESOLVED config into a map — and it sat there unread while the
 * README described a feature that could not happen.
 *
 * ## V22 W23 (2026-11-03) — who performs the auto-enter, and why it moved
 *
 * The flag was then made to work by arming the PLATFORM's own switch,
 * `PictureInPictureParams.Builder.setAutoEnterEnabled` (API 31+). That
 * made the SYSTEM transition the activity into PiP when the user left the
 * app, with the consumer unable to do anything first.
 *
 * That is the wrong order for a consumer that draws its own chrome over
 * the picture. An Activity in PiP is "paused, but rendering" - what stops
 * is REACT: RN pauses the React scheduler when the Activity is paused, so
 * a commit cannot land and no frame is produced. The switch transitions
 * the Activity before the consumer can unmount its chrome, so the chrome
 * is still on screen when the PiP window is created, and with no frame
 * coming it stays. Measured on device on 2026-11-03, the consumer's full
 * expanded chrome (header band, scrub row, ±10 buttons, the big pause
 * button) was painted into the PiP window, its buttons were DEAD (tapping
 * pause did not pause — their views were gone) and its clock was FROZEN at
 * 51:09 while the real position was 54:15 (the pixels were stale).
 *
 * So the auto-enter is now the CONSUMER's to perform, in the only order
 * that works: remove the chrome, let the frame that drew it go by, and
 * only then ask the OS for the window. The library's job is to say
 * **WHEN** — the `onUserLeaveHint` event — and to keep the params it
 * hands the platform free of the platform's own auto-enter switch.
 *
 * The public config keeps its meaning: `pip.autoEnterOnLeave: true` still
 * means "enter PiP when the user leaves the app". Only the performer
 * changed.
 *
 * ## What this test can and cannot prove
 *
 * The DECISION is pure and is fully tested here: given a config map,
 * what should the consumer be told?
 *
 * The APPLICATION needs an Android runtime (`Activity`, the UI thread,
 * `Build.VERSION`), and this module's Robolectric tests are `@Ignore`d
 * because they cannot run offline. So the part that actually tells the
 * consumer is pinned by inspecting the SOURCE — which is where the
 * defect lived in the first place: the bug was literally "the value is
 * never read", and that is a property of the source, not of a runtime
 * value.
 *
 * These are guard tests, not a device proof. The device proof is that
 * pressing home on Android 12+ enters PiP with the picture and nothing
 * else in the window.
 */
class PipAutoEnterPolicyTest {

    // ── The decision ──────────────────────────────────────────────────────

    @Test
    fun `auto-enter is on when the config asks for it`() {
        assertEquals(
            true,
            PipAutoEnterPolicy.desiredAutoEnter(pip(enabled = true, autoEnter = true)),
        )
    }

    @Test
    fun `auto-enter is off when the config asks for it`() {
        assertEquals(
            false,
            PipAutoEnterPolicy.desiredAutoEnter(pip(enabled = true, autoEnter = false)),
        )
    }

    @Test
    fun `the master switch wins over the auto-enter flag`() {
        // `pip.enabled` is the master switch for EVERY PiP entry request.
        // A disabled PiP means auto-enter is off, whatever the other flag
        // says. The two are not independent.
        assertEquals(
            false,
            PipAutoEnterPolicy.desiredAutoEnter(pip(enabled = false, autoEnter = true)),
        )
    }

    @Test
    fun `a config that says nothing about auto-enter leaves the consumer alone`() {
        // `null` is NOT `false`. "Nobody asked" must not switch the
        // feature off.
        assertNull(PipAutoEnterPolicy.desiredAutoEnter(null))
        assertNull(PipAutoEnterPolicy.desiredAutoEnter(emptyMap()))
        assertNull(PipAutoEnterPolicy.desiredAutoEnter(mapOf("theme" to mapOf("accent" to "#fff"))))
        assertNull(PipAutoEnterPolicy.desiredAutoEnter(mapOf("pip" to emptyMap<String, Any?>())))
    }

    @Test
    fun `a value of the wrong type is treated as not mentioned`() {
        // A config that says something this code does not understand must
        // not silently disable a feature.
        assertNull(PipAutoEnterPolicy.desiredAutoEnter(mapOf("pip" to "not-a-map")))
        assertNull(
            PipAutoEnterPolicy.desiredAutoEnter(
                mapOf("pip" to mapOf("enabled" to true, "autoEnterOnLeave" to "yes")),
            ),
        )
        assertNull(
            PipAutoEnterPolicy.desiredAutoEnter(
                mapOf("pip" to mapOf("enabled" to "true", "autoEnterOnLeave" to true)),
            ),
        )
    }

    // ── The source: the flag must actually be READ ────────────────────────

    @Test
    fun `the policy reads the autoEnterOnLeave key by its real name`() {
        val source = policySource().readText()
        assertTrue(
            "the policy must read the `autoEnterOnLeave` key - that is the " +
                "name the TypeScript config type uses, and a typo here " +
                "would make the whole flag inert again",
            source.contains("\"autoEnterOnLeave\""),
        )
    }

    @Test
    fun `the bridge APPLIES the policy instead of only storing the config`() {
        val source = bridgeSource().readText()

        assertTrue(
            "MpvBridgeModule must ask the policy what the consumer should be told",
            source.contains("PipAutoEnterPolicy.desiredAutoEnter("),
        )
        assertTrue(
            "MpvBridgeModule must remember the decision - the flag is what the " +
                "consumer is told about when the user leaves",
            source.contains("pipAutoEnter = desired"),
        )
    }

    @Test
    fun `the config path CALLS the applier - storing the config is not enough`() {
        val source = bridgeSource().readText()

        assertTrue(
            "the applier must be called from the config path, or the " +
                "resolved config is stored and never acted on",
            source.contains("applyPipAutoEnterOnLeave(parsed)"),
        )
    }

    // ── The consumer is TOLD, not the platform ────────────────────────────

    @Test
    fun `the bridge tells the CONSUMER that the user is leaving`() {
        val source = bridgeSource().readText()

        // The consumer's Activity calls this from `onUserLeaveHint()`.
        // The consumer then removes its own chrome and enters PiP itself,
        // in the only order that works.
        assertTrue(
            "the bridge must expose a way for the consumer's Activity to " +
                "report that the user is leaving",
            source.contains("fun notifyUserLeaveHint()"),
        )
        assertTrue(
            "the consumer must be told through the `onUserLeaveHint` event - " +
                "that is the name the TypeScript event union declares",
            source.contains("\"onUserLeaveHint\""),
        )
    }

    @Test
    fun `the policy is MIRRORED where the companion can read it`() {
        val source = bridgeSource().readText()

        // `notifyUserLeaveHint()` is a COMPANION function: it is called
        // from the consumer's Activity, which has no reference to the
        // module instance, so it cannot read the instance field. The
        // instance has to write a copy the companion can see — the same
        // pattern `debugLoggingEnabled` uses.
        assertTrue(
            "the companion must be able to read the auto-enter policy",
            source.contains("pipAutoEnterForCompanion"),
        )
        assertTrue(
            "the instance must WRITE the companion's copy when it applies the policy",
            source.contains("pipAutoEnterForCompanion = desired"),
        )
    }

    @Test
    fun `the consumer is only told when the policy says yes`() {
        val source = bridgeSource().readText()

        // A consumer that does not want auto-enter must not be told to
        // enter PiP when the user leaves.
        assertTrue(
            "the companion must check the policy before telling the consumer",
            source.contains("if (!pipAutoEnterForCompanion)"),
        )
    }

    // ── The platform's OWN switch must NOT be armed ───────────────────────

    @Test
    fun `the platform's OWN auto-enter switch is NOT used`() {
        val manager = pipManagerSource().readText()

        // `PictureInPictureParams.Builder.setAutoEnterEnabled` is the
        // platform's switch (API 31+), and it makes the SYSTEM transition
        // the activity without the consumer being able to remove its
        // chrome first. The Activity in PiP is "paused, but rendering" -
        // what stops is REACT: its scheduler is paused with the Activity,
        // so no commit lands and no frame is produced. So the chrome was
        // still mounted when the PiP window was created, and with no frame
        // coming it stayed there: dead and scaled down - measured on
        // device on 2026-11-03.
        //
        // So the params this library hands the platform must NOT carry it.
        //
        // The CALL form is what is checked, not the bare name: the prose in
        // `PipManager` deliberately NAMES the platform API it refuses to
        // use, and a guard that tripped on a comment would have to delete
        // the explanation instead of the code. A call always has the
        // parenthesis.
        assertFalse(
            "PipManager must NOT call the platform's auto-enter switch - the " +
                "consumer enters PiP itself, after removing its chrome",
            manager.contains(".setAutoEnterEnabled("),
        )
    }

    @Test
    fun `the platform's auto-enter switch is not armed anywhere in the bridge`() {
        val source = bridgeSource().readText()

        assertFalse(
            "the bridge must not call the platform's auto-enter switch",
            source.contains(".setAutoEnterEnabled("),
        )
        assertFalse(
            "the bridge must not stash auto-enter params on the activity - " +
                "the platform's own auto-enter path is gone",
            source.contains(".setPictureInPictureParams("),
        )
        assertFalse(
            "the function that pushed those params must be gone too - " +
                "dead code that arms a broken path is a trap",
            source.contains("applyActivityPipParams"),
        )
    }

    @Test
    fun `the manual entry carries no auto-enter flag`() {
        val source = bridgeSource().readText()

        // The manual entry (`enterPip`) is the path the CONSUMER drives.
        // Its params must describe the window and nothing else: a flag
        // that makes the platform transition on its own would put the
        // consumer's chrome back into the frozen PiP window on the NEXT
        // leave.
        assertFalse(
            "the manual entry's params must not carry an auto-enter flag",
            source.contains("autoEnter = pipAutoEnter"),
        )
        assertFalse(
            "the params builder must not even accept an auto-enter flag",
            pipManagerSource().readText().contains("autoEnter: Boolean"),
        )
    }

    @Test
    fun `the aspect ratio is refreshed when the video changes`() {
        val source = bridgeSource().readText()

        // The params the CONSUMER's entry carries are built at the moment
        // the consumer asks for the window, so the video's current shape
        // is read then — there is nothing to refresh ahead of time.
        //
        // What must NOT happen is the platform's own auto-enter reading
        // params stashed at config time, which would give the
        // auto-entered window the shape of the PREVIOUS video.
        assertFalse(
            "the bridge must not stash params on the activity for a " +
                "platform-initiated auto-enter - that path is gone",
            source.contains("applyActivityPipParams"),
        )
    }

    @Test
    fun `the bridge says out loud that the CONSUMER performs the entry`() {
        val source = bridgeSource().readText()

        // The library ships no Activity, so the consumer's Activity has to
        // report the leave. The honest thing is to say so, not to leave a
        // consumer wondering why pressing home does nothing.
        assertTrue(
            "the bridge must tell the log that the consumer performs the entry",
            source.contains("companion.notifyUserLeaveHint"),
        )
    }

    // ── helpers ───────────────────────────────────────────────────────────

    /** A resolved-config shaped `pip` section. */
    private fun pip(enabled: Boolean, autoEnter: Boolean): Map<String, Any?> =
        mapOf(
            "pip" to mapOf(
                "enabled" to enabled,
                "autoEnterOnLeave" to autoEnter,
            ),
        )

    private fun bridgeSource(): File = findUp("src/main/java/com/simba/player/mpv/MpvBridgeModule.kt")

    private fun policySource(): File = findUp("src/main/java/com/simba/player/mpv/PipAutoEnterPolicy.kt")

    private fun pipManagerSource(): File = findUp("src/main/java/com/simba/player/PipManager.kt")

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
