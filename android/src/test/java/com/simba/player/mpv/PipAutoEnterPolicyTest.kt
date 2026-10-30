package com.simba.player.mpv

import org.junit.Assert.assertEquals
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
 * ## What this test can and cannot prove
 *
 * The DECISION is pure and is fully tested here: given a config map,
 * what should the Activity be told?
 *
 * The APPLICATION needs an Android runtime (`Activity`, the UI thread,
 * `Build.VERSION`), and this module's Robolectric tests are `@Ignore`d
 * because they cannot run offline. So the part that actually calls
 * `activity.setAutoEnterEnabled(...)` is pinned by inspecting the
 * SOURCE, which is where the defect lived in the first place: the bug
 * was literally "the value is never read", and that is a property of
 * the source, not of a runtime value.
 *
 * These are guard tests, not a device proof. The device proof is that
 * pressing home on Android 12+ enters PiP.
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
    fun `a config that says nothing about auto-enter leaves the Activity alone`() {
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
            "MpvBridgeModule must ask the policy what the Activity should be told",
            source.contains("PipAutoEnterPolicy.desiredAutoEnter("),
        )
        assertTrue(
            "MpvBridgeModule must remember the decision - the flag is what the " +
                "params and the manual entry are built from",
            source.contains("pipAutoEnter = desired"),
        )
    }

    @Test
    fun `the platform's OWN switch is used - PictureInPictureParams, not a made-up Activity method`() {
        val manager = pipManagerSource().readText()

        // `Activity.setAutoEnterEnabled` DOES NOT EXIST - it was a
        // plausible-sounding API that the SDK's own android.jar does not
        // contain. The real switch is
        // `PictureInPictureParams.Builder.setAutoEnterEnabled`, which the
        // SDK's api-versions.xml records as `since="31"`.
        assertTrue(
            "PipManager must set the flag on the params builder - " +
                "PictureInPictureParams.Builder.setAutoEnterEnabled is the " +
                "platform's switch (API 31+)",
            manager.contains("builder.setAutoEnterEnabled(autoEnter)"),
        )
        assertTrue(
            "the params must only carry the flag on Android 12+",
            manager.contains("Build.VERSION_CODES.S"),
        )
    }

    @Test
    fun `the activity's params carry the flag so the SYSTEM can auto-enter`() {
        val source = bridgeSource().readText()

        // `enterPictureInPictureMode(params)` describes a MANUAL entry.
        // The swipe-home auto-enter reads the activity's OWN params, set
        // via `setPictureInPictureParams` - so without this the flag
        // would never reach the path it was written for.
        assertTrue(
            "the bridge must push the params onto the activity - that is " +
                "what the system reads when it auto-enters PiP on swipe-home",
            source.contains("activity.setPictureInPictureParams(params)"),
        )
        assertTrue(
            "the activity's params must be built WITH the auto-enter flag",
            source.contains("autoEnter = true"),
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

    @Test
    fun `the aspect ratio is refreshed when the video changes`() {
        val source = bridgeSource().readText()

        // The params the system reads for an auto-enter carry the aspect
        // ratio. If they were set once, at config time, the auto-entered
        // window would have the shape of the PREVIOUS video.
        assertTrue(
            "the params must be refreshed when mpv reports new video " +
                "dimensions (the `videoReconfig` event)",
            source.contains("\"videoReconfig\"") && source.contains("applyActivityPipParams()"),
        )
    }

    @Test
    fun `the manual entry carries the flag too`() {
        val source = bridgeSource().readText()
        assertTrue(
            "the params `enterPip` builds must carry the auto-enter flag, " +
                "so the two paths agree",
            source.contains("autoEnter = pipAutoEnter"),
        )
    }

    @Test
    fun `the API level is checked before the platform call`() {
        val source = bridgeSource().readText()

        // `setAutoEnterEnabled` is API 31+. Calling it below that is a
        // NoSuchMethodError at runtime, so the guard has to be IN the
        // source, not implied.
        assertTrue(
            "the bridge must check the API level before setting the " +
                "auto-enter flag (API 31+ / Android 12)",
            source.contains("VERSION_CODES.S"),
        )
        val sdkCheck = source.indexOf("VERSION_CODES.S")
        val call = source.indexOf("activity.setPictureInPictureParams(params)")
        assertTrue(
            "the API-level check must come BEFORE the platform call",
            sdkCheck > 0 && call > 0 && sdkCheck < call,
        )
    }

    @Test
    fun `the bridge says out loud that below Android 12 it stays manual`() {
        val source = bridgeSource().readText()

        // The library ships no Activity, so below API 31 there is no
        // platform switch to throw. The honest thing is to say so, not
        // to pretend the feature works.
        assertTrue(
            "the bridge must tell the log that PiP entry stays manual " +
                "below Android 12",
            source.contains("PiP entry stays manual"),
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
