package com.simba.player

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * V3.2.0 (2026-11-03) — "pressing HOME opens no PiP window at all".
 *
 * ## The defect
 *
 * The BUTTON path worked and was proven on emulator-5554 (API 37): the app
 * unmounted its chrome in React, waited one animation frame, then called
 * `commands.enterPip()`. The PiP window showed the video only, and the
 * platform action row's Play/Pause worked.
 *
 * The HOME path did NOT work. Pressing HOME opened no PiP window, and on
 * return the screen was black and chromeless with the store stuck at
 * `pipActive=true` / `pipEntryRequested=true`.
 *
 * The cause was measured, not guessed: `Activity.onUserLeaveHint()` fired
 * and the JS handler ran immediately, but the effect that would have driven
 * the entry ran **5.7 s late** and the `requestAnimationFrame` **never
 * fired**. React Native pauses the React scheduler with the Activity, so a
 * React commit cannot land and there is no frame clock once the Activity is
 * backgrounded. The entry therefore has to be NATIVE, inside
 * `onUserLeaveHint()`, before `onPause`.
 *
 * ## What this test can and cannot prove
 *
 * The DECISION and the FORMATTING are pure, and are tested here as pure
 * functions: the progress percentage, the title, and the chrome id.
 *
 * The APPLICATION needs an Android runtime — an `Activity`, a `View`, the
 * UI thread — and this module's Robolectric tests are `@Ignore`d because
 * they cannot run offline. So the part that touches Android is pinned by
 * inspecting the SOURCE, which is where the defect lived: the bug was
 * literally "the entry ran in the wrong place, in the wrong language".
 *
 * These are guard tests, not a device proof. The device proof is that
 * pressing HOME opens a PiP window with the picture and nothing else in it.
 *
 * ## Why the assertions read CODE and not prose
 *
 * The prose in `MpvBridgeModule.kt` deliberately NAMES the APIs and the
 * strings it is talking about — that is how a reader learns why the code
 * looks the way it does. An assertion matched against the raw text would
 * therefore pass or fail on the COMMENT rather than on the behaviour.
 *
 * So every source assertion here runs against the file with its comments
 * removed, the same shape `PipActionDeliveryTest` uses.
 */
class PipNativeEntryTest {

    // ── The pure facts ────────────────────────────────────────────────────

    @Test
    fun `the progress percentage is formatted exactly as the consumer formats it`() {
        // The consumer's format is `"${Math.round((positionMs / durationMs) * 100)} %"`:
        // an integer, a space, then `%`.
        assertEquals("25 %", PipNativeEntry.progressPct(30_000L, 120_000L))
        assertEquals("0 %", PipNativeEntry.progressPct(0L, 120_000L))
        assertEquals("100 %", PipNativeEntry.progressPct(120_000L, 120_000L))
    }

    @Test
    fun `the progress percentage rounds the way JavaScript rounds`() {
        // `Math.round` is `floor(x + 0.5)`, NOT "ties to even". A native
        // path that rounded to even would disagree with the JS path by one
        // percent on a .5 boundary - and the two are the SAME fact about
        // the SAME playing item.
        assertEquals("13 %", PipNativeEntry.progressPct(1L, 8L))
        assertEquals("38 %", PipNativeEntry.progressPct(3L, 8L))
        assertEquals("63 %", PipNativeEntry.progressPct(5L, 8L))
    }

    @Test
    fun `there is NO percentage when the duration is unknown`() {
        // A percentage of an unknown length is not a fact.
        assertNull(PipNativeEntry.progressPct(30_000L, 0L))
        assertNull(PipNativeEntry.progressPct(30_000L, -1L))
    }

    @Test
    fun `the title is mpv's media-title without its JSON quotes`() {
        // mpv's properties come back JSON-encoded, so a string arrives
        // wrapped in quotes.
        assertEquals("Overrun!", PipNativeEntry.title("\"Overrun!\""))
        assertEquals("Overrun!", PipNativeEntry.title("  \"Overrun!\"  "))
    }

    @Test
    fun `mpv's null sentinel is NOT a title`() {
        // A property that is not set comes back as the literal `null`.
        assertNull(PipNativeEntry.title("null"))
        assertNull(PipNativeEntry.title("\"null\""))
        assertNull(PipNativeEntry.title("NULL"))
        assertNull(PipNativeEntry.title(null))
        assertNull(PipNativeEntry.title("   "))
    }

    @Test
    fun `the chrome nativeID comes from the pip section of the config`() {
        assertEquals(
            "chrome-root",
            PipNativeEntry.chromeNativeId(
                mapOf("pip" to mapOf("chromeNativeId" to "chrome-root")),
            ),
        )
        assertEquals(
            "chrome-root",
            PipNativeEntry.chromeNativeId(
                mapOf("pip" to mapOf("enabled" to true, "chromeNativeId" to "chrome-root")),
            ),
        )
    }

    @Test
    fun `no chrome nativeID means the consumer has no chrome of its own`() {
        // `null` is a real answer here, not a missing value: the native
        // path then enters PiP without hiding anything.
        assertNull(PipNativeEntry.chromeNativeId(null))
        assertNull(PipNativeEntry.chromeNativeId(emptyMap()))
        assertNull(PipNativeEntry.chromeNativeId(mapOf("pip" to emptyMap<String, Any?>())))
        assertNull(PipNativeEntry.chromeNativeId(mapOf("pip" to "not-a-map")))
        assertNull(
            PipNativeEntry.chromeNativeId(mapOf("pip" to mapOf("chromeNativeId" to "   "))),
        )
    }

    // ── The refusals, and the order they come in ─────────────────────────

    @Test
    fun `the native entry refuses when auto-enter is off`() {
        val body = leaveHintBody()

        assertTrue(
            "the native entry must check the consumer's own policy - " +
                "`pip.autoEnterOnLeave: false` has to be honoured",
            body.contains("if (!pipAutoEnterForCompanion)"),
        )
        assertTrue(
            "the native entry must RETURN false when auto-enter is off",
            body.substringAfter("if (!pipAutoEnterForCompanion)").contains("return false"),
        )
    }

    @Test
    fun `the native entry refuses when the Activity is already in PiP`() {
        val body = leaveHintBody()

        assertTrue(
            "the native entry must check `isInPictureInPictureMode` - HOME " +
                "pressed inside PiP must not enter again",
            body.contains("if (activity.isInPictureInPictureMode)"),
        )
        assertTrue(
            "the native entry must RETURN false when it is already in PiP",
            body.substringAfter("if (activity.isInPictureInPictureMode)")
                .contains("return false"),
        )
    }

    @Test
    fun `the native entry refuses when no media is loaded`() {
        val code = code(bridgeSource().readText())

        // The facts come from mpv, never from a JS flag: by the time the
        // user presses HOME, a JS flag can be stale.
        assertTrue(
            "the media check must read mpv's own playback-state",
            code.contains("nativeGetProperty(ptr, \"playback-state\")"),
        )
        assertTrue(
            "mpv's `idle` and `stopped` are its no-media states",
            code.contains("state != \"idle\"") && code.contains("state != \"stopped\""),
        )
        assertTrue(
            "the native entry must consult the media check",
            leaveHintBody().contains("if (!isMediaLoaded())"),
        )
    }

    @Test
    fun `the refusals come in the documented order`() {
        val body = leaveHintBody()

        val policy = body.indexOf("if (!pipAutoEnterForCompanion)")
        val alreadyInPip = body.indexOf("if (activity.isInPictureInPictureMode)")
        val noMedia = body.indexOf("if (!isMediaLoaded())")
        val chrome = body.indexOf("if (chromeNativeId != null)")

        assertTrue("the policy guard must be there", policy >= 0)
        assertTrue("the already-in-PiP guard must be there", alreadyInPip >= 0)
        assertTrue("the no-media guard must be there", noMedia >= 0)
        assertTrue("the chrome block must be there", chrome >= 0)

        assertTrue(
            "the policy is checked FIRST - it is the consumer's own switch",
            policy < alreadyInPip,
        )
        assertTrue(
            "already-in-PiP is checked BEFORE the media check",
            alreadyInPip < noMedia,
        )
        assertTrue(
            "the media check comes BEFORE the chrome is touched - a stopped " +
                "session must not have its chrome hidden at all",
            noMedia < chrome,
        )
    }

    // ── The chrome ────────────────────────────────────────────────────────

    @Test
    fun `the chrome is found with React Native's own lookup`() {
        val body = leaveHintBody()

        assertTrue(
            "the chrome must be found with React Native's own lookup - " +
                "`ReactFindViewUtil.findView` is the supported way to find a " +
                "view by the `nativeID` prop",
            body.contains("ReactFindViewUtil.findView("),
        )
        assertTrue(
            "the search root must be the Activity's window decor view - the " +
                "React root lives under it",
            body.contains("activity.window?.decorView"),
        )
    }

    @Test
    fun `a chrome id that NO view carries REFUSES the entry`() {
        val body = leaveHintBody()

        assertTrue(
            "the native entry must handle a chrome id that no view carries",
            body.contains("if (chromeView == null)"),
        )
        assertTrue(
            "a chrome that cannot be hidden must REFUSE the entry - entering " +
                "PiP with it still mounted paints the app's dead chrome into " +
                "the PiP window",
            body.substringAfter("if (chromeView == null)").substringBefore("}")
                .contains("return false"),
        )
    }

    @Test
    fun `the chrome is hidden with GONE BEFORE the PiP request`() {
        val body = leaveHintBody()

        val hide = body.indexOf("chromeView.visibility = View.GONE")
        val request = body.indexOf("enterPictureInPicture(")

        assertTrue("the chrome must be hidden at all", hide >= 0)
        assertTrue("the PiP window must be requested at all", request >= 0)
        assertTrue(
            "the chrome must be GONE BEFORE the PiP request - the PiP window " +
                "keeps what the Activity's window held at the transition, and " +
                "a View-system mutation is the only hide that lands without a " +
                "React commit",
            hide in 0 until request,
        )
    }

    @Test
    fun `the params are built AFTER the hide, by the one shared builder`() {
        val body = leaveHintBody()

        // The hide happens in `notifyUserLeaveHint`; the params are built
        // inside the shared builder, which the native path calls only
        // AFTER the hide. So the ORDER of the two is the order of the
        // hide and the builder call.
        val hide = body.indexOf("chromeView.visibility = View.GONE")
        val builder = body.indexOf("enterPictureInPicture(")

        assertTrue(
            "the params must be built after the hide - they describe the " +
                "window as it is at the transition",
            hide in 0 until builder,
        )
    }

    @Test
    fun `a REFUSED OS entry restores the chrome to VISIBLE`() {
        val body = leaveHintBody()

        val after = body.substringAfter("val entered = enterPictureInPicture(")
        assertTrue(
            "the native entry must look at the OS's answer",
            after.contains("if (!entered)"),
        )
        assertTrue(
            "a refused entry must restore the chrome - a consumer left with " +
                "an invisible chrome cannot come back from it",
            after.contains("restoreConsumerChrome()"),
        )
        assertTrue(
            "the restore must make the chrome visible again",
            code(bridgeSource().readText()).contains("view.visibility = View.VISIBLE"),
        )
    }

    @Test
    fun `onPictureInPictureModeChanged(false) restores the chrome`() {
        val code = code(bridgeSource().readText())
        val pipChanged = code
            .substringAfter("fun onPictureInPictureModeChanged(isInPictureInPictureMode: Boolean) {")
            .substringBefore("fun notifyUserLeaveHint(")

        assertTrue(
            "PiP ending must restore the chrome",
            pipChanged.contains("if (!isInPictureInPictureMode)") &&
                pipChanged.contains("restoreConsumerChrome()"),
        )
        assertTrue(
            "the restore must NOT wait for the React instance - the view is a " +
                "native one and the app is showing it either way",
            pipChanged.indexOf("restoreConsumerChrome()") < pipChanged.indexOf("instance ?: run"),
        )
    }

    // ── The facts the native path reports ────────────────────────────────

    @Test
    fun `the native path reads the title from mpv's media-title`() {
        val code = code(bridgeSource().readText())

        assertTrue(
            "the native path must read mpv's `media-title` - that IS the " +
                "title the consumer supplied, because the library writes it " +
                "as `force-media-title` BEFORE the load",
            code.contains("nativeGetProperty(ptr, \"media-title\")"),
        )
        assertTrue(
            "the native path must format it through the one pure helper",
            code.contains("PipNativeEntry.title("),
        )
    }

    @Test
    fun `the native path reads the percentage from time-pos over duration`() {
        val code = code(bridgeSource().readText())

        assertTrue(
            "the native path must read mpv's `time-pos`",
            code.contains("nativeGetProperty(ptr, \"time-pos\")"),
        )
        assertTrue(
            "the native path must read mpv's `duration`",
            code.contains("nativeGetProperty(ptr, \"duration\")"),
        )
        assertTrue(
            "the native path must format it through the one pure helper",
            code.contains("PipNativeEntry.progressPct("),
        )
    }

    // ── One owner per fact ────────────────────────────────────────────────

    @Test
    fun `both entry paths build their params through the SAME function`() {
        val code = code(bridgeSource().readText())

        assertEquals(
            "the PiP params must be built in exactly ONE place - a second " +
                "builder is how the JS path and the native path would drift " +
                "apart",
            1,
            Regex("PipManager\\.buildPipParams\\(").findAll(code).count(),
        )
        assertTrue(
            "the JS path must go through the shared builder",
            code.contains("return enterPictureInPicture(activity, title, pct)"),
        )
        assertTrue(
            "the native path must go through the shared builder",
            leaveHintBody().contains("enterPictureInPicture("),
        )
    }

    @Test
    fun `the library does NOT hardcode a chrome id of its own`() {
        val code = code(bridgeSource().readText())

        // The literal belongs to the CONSUMER. A hardcoded id in the
        // library would be a second owner of a fact that is the app's.
        assertFalse(
            "the library must not carry a chrome id literal - the consumer " +
                "owns it",
            Regex("chromeNativeId\\s*=\\s*\"").containsMatchIn(code),
        )
        assertTrue(
            "the chrome id must come from the config",
            code.contains("PipNativeEntry.chromeNativeId(config)"),
        )
    }

    // ── The retired event ─────────────────────────────────────────────────

    @Test
    fun `the onUserLeaveHint EVENT is gone from the bridge`() {
        // The library now performs the HOME-path entry itself, so the
        // event's only consumer - a consumer that drove the entry from JS -
        // is the path the library took over. Leaving the event would be a
        // double-entry footgun.
        val kotlin = code(bridgeSource().readText())
        assertFalse(
            "the bridge must not emit an `onUserLeaveHint` event any more",
            kotlin.contains("\"onUserLeaveHint\""),
        )

        val ts = bridgeModuleSource().readText()
        assertFalse(
            "the TypeScript event union must not declare `onUserLeaveHint`",
            ts.contains("'onUserLeaveHint'"),
        )
        assertFalse(
            "the TypeScript payload map must not declare `onUserLeaveHint`",
            Regex("onUserLeaveHint\\s*:").containsMatchIn(ts),
        )
    }

    @Test
    fun `the event list has exactly 26 members`() {
        assertEquals(
            "the bridge's event list must have exactly 26 members - one was " +
                "removed (the `onUserLeaveHint` event), and a silent drift in " +
                "either direction is how the count went wrong before",
            26,
            eventList().size,
        )
        assertFalse(
            "the retired event must not be in the list",
            eventList().contains("onUserLeaveHint"),
        )
    }

    @Test
    fun `the public config declares the chrome nativeID`() {
        val config = configSource().readText()
        assertTrue(
            "the public config type must declare `chromeNativeId` - that is " +
                "the whole public surface of the native HOME path",
            config.contains("chromeNativeId?: string"),
        )
    }

    // ── helpers ───────────────────────────────────────────────────────────

    /**
     * The file's CODE, with its comments removed.
     *
     * Block comments first, then line comments — the same shape
     * `PipActionDeliveryTest` uses.
     *
     * A `//` inside a string literal is cut too, and `MpvBridgeModule.kt`
     * has a few (`"content://"`, `"http://"`). Those lines are cut in the
     * stripped copy; none of this test's assertions read them, and the
     * alternative (prose-aware parsing) is not worth a parser in a guard
     * test.
     */
    private fun code(source: String): String =
        source
            .replace(Regex("/\\*.*?\\*/", RegexOption.DOT_MATCHES_ALL), "")
            .replace(Regex("//[^\\n]*"), "")

    /**
     * The body of the companion's `notifyUserLeaveHint`.
     *
     * Scoped to the function, so an assertion about the ORDER of its
     * guards cannot be satisfied by a similar-looking line somewhere else
     * in the file.
     */
    private fun leaveHintBody(): String =
        code(bridgeSource().readText())
            .substringAfter("fun notifyUserLeaveHint(activity: Activity): Boolean {")
            .substringBefore("private fun enterPictureInPicture(")

    /** The event names in `ALL_PLAYER_EVENTS`, in order. */
    private fun eventList(): List<String> {
        val body = bridgeModuleSource().readText()
            .substringAfter("export const ALL_PLAYER_EVENTS")
            .substringBefore("];")
        return Regex("'([^']+)'").findAll(body).map { it.groupValues[1] }.toList()
    }

    private fun bridgeSource(): File = findUp("src/main/java/com/simba/player/mpv/MpvBridgeModule.kt")

    private fun bridgeModuleSource(): File = findUp("src/bridge/MpvPlayerModule.ts")

    private fun configSource(): File = findUp("src/types/config.ts")

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
