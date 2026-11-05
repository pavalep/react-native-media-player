package com.simba.player

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import com.simba.player.mpv.PipSourceRect
import org.junit.Test
import java.io.File

/**
 * V3.3.0 (2026-11-04) — "the PiP window showed the app's full expanded chrome,
 * scaled down".
 *
 * ## The defect
 *
 * The PiP window opened and the video played under it, but the header band, the
 * scrub row with its frozen clock, the ±10 buttons, the big pause button and
 * the volume row were painted into the window too, at a fraction of their
 * size, and their buttons were dead.
 *
 * ## What was actually wrong
 *
 * Two things, and neither of them was "the library forgot to hide the chrome":
 *
 * 1. **THE CROP WAS NEVER A MECHANISM.** This file used to say that the
 *    platform "CROPS the app's window to the rect in
 *    `PictureInPictureParams.setSourceRectHint(...)`". That was WRONG, and
 *    the device disproved it: on emulator-5554 (API 37) on 2026-11-04, with
 *    the hint committed, the PiP window showed the app's FULL chrome,
 *    scaled down. `setSourceRectHint` is a TRANSITION hint — it tells the
 *    platform which region of the window the PiP window should animate
 *    FROM. It does not crop anything.
 *
 * 2. **The app's hooks were never called.** With the platform's
 *    auto-enter switch armed, the platform transitions the window itself,
 *    through the Shell transition, and the app is not consulted.
 *    `Activity.onUserLeaveHint()` did not fire at all on a HOME press
 *    (measured: zero log lines) and the PiP window showed the app's full
 *    chrome, scaled down.
 *
 * So the chrome is now hidden BEFORE the window is asked for, from
 *    `Activity.onPictureInPictureRequested()` — AOSP's own PiP entry hook,
 *    which is called while the Activity is still RESUMED — and the
 *    platform's auto-enter switch is not armed.
 *
 * ## What this test can and cannot prove
 *
 * The crop's ARITHMETIC is pure and is tested here as a pure function. The
 * APPLICATION needs an Android runtime, and this module's Robolectric tests
 * are `@Ignore`d because they cannot run offline. So the part that touches
 * Android is pinned by inspecting the SOURCE, which is where the defect lived:
 * the bug was literally "the params were handed over at the wrong moment, and
 * the hide ran at the wrong moment".
 *
 * These are guard tests, not a device proof. The device proof is that the PiP
 * window holds the picture and nothing else.
 */
class PipPiPWindowTest {

    // ── The crop: the source rect is the VIDEO's rect ─────────────────────

    @Test
    fun `the source rect is the VIDEO's rect, not the picture box's rect`() {
        // The consumer's picture box fills the screen (`absoluteFill` of the
        // lane), so the box is PORTRAIT. A 16:9 film inside it is
        // letterboxed: the video's own frame is a band across the middle of
        // the box, and the box's top and bottom are empty.
        //
        // The hint has to be that band. Hinting the whole box would crop the
        // whole screen into the PiP window - the app's header band and all.
        val boxWidth = 1080
        val boxHeight = 2400
        val videoAspect = 16f / 9f

        val frame = PipSourceRect.frameInWindow(
            viewLeft = 0,
            viewTop = 0,
            viewWidth = boxWidth,
            viewHeight = boxHeight,
            videoAspect = videoAspect,
            fillsView = false,
        )

        assertTrue("a portrait box with a 16:9 video must have a frame", frame != null)
        val rect = frame!!
        assertTrue(
            "the video's frame must be SHORTER than the portrait box - the box " +
                "is $boxHeight px tall and the video's own frame is ${rect.height} px",
            rect.height < boxHeight,
        )
        assertEquals(
            "the frame's width is the box's width - the video is wider than the box's aspect",
            boxWidth,
            rect.width,
        )
        assertEquals(
            "the frame keeps the video's own shape, so the crop matches the " +
                "PiP window's aspect ratio exactly",
            videoAspect,
            rect.aspect,
            0.01f,
        )
    }

    @Test
    fun `the bridge asks for the video's rect, from the LIVE picture view`() {
        val code = code(bridgeSource().readText())

        assertTrue(
            "the source rect must come from the live picture view's cached " +
                "window bounds",
            code.contains("view.cachedWindowBounds"),
        )
        assertTrue(
            "the source rect must be the pure owner in PipSourceRect",
            code.contains("PipSourceRect.frameInWindow("),
        )
    }

    // ── The params are committed EARLY ─────────────────────────────────────

    @Test
    fun `the params are committed to the Activity OUTSIDE the entry moment`() {
        val code = code(bridgeSource().readText())

        assertTrue(
            "the library must commit the params with " +
                "`Activity.setPictureInPictureParams(...)` - the platform builds " +
                "the PiP window from the LAST COMMITTED params",
            code.contains("activity.setPictureInPictureParams("),
        )
        assertTrue(
            "the commit must happen from the picture's geometry change - the " +
                "source rect hint is the region of the window the video " +
                "occupies, and a moved picture makes it stale",
            code.contains("fun onPictureBoundsChanged("),
        )
        assertTrue(
            "the commit must happen when the playback state changes - the " +
                "action's icon is state-driven",
            code.contains("fun onPlaybackStateChanged("),
        )
    }

    @Test
    fun `the picture view tells the bridge when its window rect changed`() {
        val code = code(renderViewSource().readText())

        assertTrue(
            "the picture view publishes its window rect, so it is the natural " +
                "place to notice that the rect moved",
            code.contains("fun refreshWindowBounds()"),
        )
        assertTrue(
            "a moved rect must reach the bridge - the committed PiP params " +
                "carry it as the source rect hint",
            code.contains("MpvBridgeModule.onPictureBoundsChanged()"),
        )
    }

    // ── Auto-enter (Android 12+) ───────────────────────────────────────────

    @Test
    fun `the platform's auto-enter switch is NOT armed`() {
        val code = code(bridgeSource().readText())
        val manager = code(pipManagerSource().readText())

        assertTrue(
            "the params builder must accept the auto-enter flag",
            manager.contains("autoEnter: Boolean"),
        )
        assertFalse(
            "the platform's auto-enter switch must NOT be armed - it " +
                "transitions the window itself, through the Shell " +
                "transition, and the app's own hooks are never called: " +
                "`onUserLeaveHint()` did not fire at all on a HOME press " +
                "(measured on emulator-5554, API 37, 2026-11-04)",
            manager.contains("setAutoEnterEnabled(true)"),
        )
        assertTrue(
            "the flag must be the media-loaded fact - a PiP window of a " +
                "stopped session is a bug, not a feature",
            code.contains("autoEnter = isMediaLoaded()"),
        )
    }

    @Test
    fun `the HOME path asks for the window on EVERY API level`() {
        val body = leaveHintBody()

        val request = body.indexOf("enterPictureInPicture(activity)")
        assertTrue("the explicit request must exist", request >= 0)

        // There must be NO API-31+ branch that SKIPS the explicit request:
        // the explicit entry is the only entry, because the platform's
        // auto-enter never calls the app's hooks.
        //
        // The API 31+ branch that exists does NOT skip it — it asks for the
        // window through the DRAW-GATED entry, one frame later, so the
        // chrome-less frame is on the screen before the platform takes the
        // window. Measured on emulator-5554 (API 37) on 2026-11-05: the
        // chrome view was GONE and stayed GONE, and the PiP window STILL
        // carried the app's full expanded chrome, because the hide had
        // never been drawn.
        val gated = body.indexOf("enterPictureInPictureAfterDraw(activity)")
        assertTrue(
            "the API 31+ path must ask for the window through the " +
                "draw-gated entry - the hide has to be DRAWN before the " +
                "platform takes the window",
            gated >= 0,
        )
        assertTrue(
            "the draw-gated entry must come first - API 31+ takes that " +
                "path, and API 24-30 the immediate one",
            gated < request,
        )

        val branch = body
            .substringAfter("VERSION_CODES.S")
            .substringBefore("val entered = enterPictureInPicture(activity)")
        assertFalse(
            "the API 31+ branch must not return before asking for the " +
                "window - the explicit entry is the only entry",
            branch
                .substringBefore("enterPictureInPictureAfterDraw(activity)")
                .contains("return"),
        )
    }

    // ── The action row ─────────────────────────────────────────────────────

    @Test
    fun `exactly ONE action is set, and it is play-pause`() {
        val body = buildParamsBody()

        assertEquals(
            "the PiP row must carry exactly ONE action - the platform renders " +
                "its own expand / close / settings affordances, and the " +
                "library's row was a second copy of them",
            1,
            Regex("buildRemoteAction\\(").findAll(body).count(),
        )
        assertTrue(
            "the one action must be play/pause",
            body.contains("ACTION_PLAY_PAUSE"),
        )
        assertFalse(
            "the library's own expand action must be gone - the platform " +
                "renders its own",
            pipManagerSource().readText().contains("ACTION_EXPAND"),
        )
        assertFalse(
            "the library's own close action must be gone - the platform " +
                "renders its own",
            pipManagerSource().readText().contains("ACTION_CLOSE"),
        )
    }

    @Test
    fun `the action's icon follows the playback state`() {
        val body = buildParamsBody()

        // The ICON line specifically: the title and the content description
        // also branch on `playing`, and an assertion on the bare name would
        // be satisfied by those.
        assertTrue(
            "the icon must be state-driven - the pause icon while the video is " +
                "playing, the play icon while it is paused",
            body.contains("iconResId = if (playing) {") &&
                body.contains("android.R.drawable.ic_media_pause") &&
                body.contains("android.R.drawable.ic_media_play"),
        )
    }

    @Test
    fun `the play-pause action reaches the engine directly`() {
        val receiver = receiverBody()

        assertTrue(
            "the action must pause the engine itself",
            receiver.contains("MPVLib.nativePause(ptr)"),
        )
        assertTrue(
            "the action must play the engine itself",
            receiver.contains("MPVLib.nativePlay(ptr)"),
        )
        assertFalse(
            "the action must NOT go through a JS event - the broadcast can " +
                "arrive after the JS bundle has unloaded",
            receiver.contains("RCTDeviceEventEmitter"),
        )
        assertFalse(
            "the action must NOT emit a JS event - the engine call IS the " +
                "mechanism",
            receiver.contains("emitEvent("),
        )
    }

    @Test
    fun `the receiver's registration stays a RUNTIME one, on the app context`() {
        val manager = pipManagerSource().readText()
        val code = code(manager)

        assertTrue(
            "the receiver must be registered on the APPLICATION context - it " +
                "has to outlive the Activity",
            manager.contains("context.applicationContext"),
        )
        assertFalse(
            "the broadcast must stay IMPLICIT - an explicit broadcast resolves " +
                "through the manifest, and a runtime-only receiver can never " +
                "receive one",
            code.contains("setClass("),
        )
    }

    // ── The surface is NOT touched ─────────────────────────────────────────

    @Test
    fun `this release does NOT change the surface's bounds`() {
        val code = code(renderViewSource().readText())
        // The geometry-publishing path is where a bounds change would be
        // made: it is the one place that knows where the picture is.
        val publish = code
            .substringAfter("private fun refreshWindowBounds() {")
            .substringBefore("private fun ")

        assertFalse(
            "the release must not resize the surface - the platform lays the " +
                "existing surface out in the PiP window, and changing its " +
                "bounds on top of that double-scales the picture",
            publish.contains("layout("),
        )
        assertFalse(
            "the surface must never be detached - cycling detaches → " +
                "re-attaches → a mpv VO reinit → MediaCodec dies",
            code.contains("removeView(") || code.contains("addView("),
        )
    }

    // ── The chrome: hidden BEFORE the window is asked for ──────────────────

    @Test
    fun `the chrome is hidden BEFORE the window is asked for`() {
        val request = leaveHintBody()
        val modeChanged = modeChangedBody()

        val hide = request.indexOf("hideConsumerChrome()")
        val ask = request.indexOf("enterPictureInPicture(activity)")

        assertTrue("the request path must hide the chrome", hide >= 0)
        assertTrue("the request path must ask for the window", ask >= 0)
        assertTrue(
            "the chrome must be hidden BEFORE the window is asked for - the " +
                "PiP window IS the Activity's own window, so whatever the " +
                "chrome draws is what the PiP window shows",
            hide < ask,
        )
        assertTrue(
            "the mode-changed callback keeps hiding the chrome too - it is " +
                "the second line of defence for the consumer's own button " +
                "path",
            modeChanged.contains("hideConsumerChrome()"),
        )
        assertTrue(
            "the hide must be a native View-system mutation",
            code(bridgeSource().readText()).contains("chromeView.visibility = View.GONE"),
        )
    }

    @Test
    fun `a chrome that cannot be found does NOT refuse the entry`() {
        val code = code(bridgeSource().readText())
        val hide = code
            .substringAfter("private fun hideConsumerChrome() {")
            .substringBefore("private fun ")

        assertTrue(
            "the hide must handle a chrome that is not there",
            hide.contains("if (chromeView == null)"),
        )
        assertFalse(
            "a missing chrome must NOT refuse anything - it means the chrome " +
                "is ALREADY hidden (the consumer's own button path unmounts it " +
                "in React before it asks for the window)",
            hide.substringAfter("if (chromeView == null)").substringBefore("}")
                .contains("return false"),
        )
        assertFalse(
            "the request path must not refuse the entry over the chrome - " +
                "a chrome that is not there means it is ALREADY hidden, and " +
                "the entry goes on",
            leaveHintBody()
                .substringAfter("hideConsumerChrome()")
                .substringBefore("rememberPipActivity(activity)")
                .contains("return false"),
        )
    }

    @Test
    fun `the chrome is restored when PiP ends, even without the React instance`() {
        val modeChanged = modeChangedBody()

        assertTrue(
            "PiP ending must restore the chrome",
            modeChanged.contains("restoreConsumerChrome()"),
        )
        assertTrue(
            "the restore must NOT wait for the React instance - the view is a " +
                "native one and the app is showing it either way",
            modeChanged.indexOf("restoreConsumerChrome()") <
                modeChanged.indexOf("instance ?: run"),
        )
    }

    // ── The parameters ─────────────────────────────────────────────────────

    @Test
    fun `the source rect hint is applied from API 26`() {
        val manager = code(pipManagerSource().readText())

        assertTrue(
            "`setSourceRectHint(Rect)` has been available since API 26 - the " +
                "API 31 call is the two-rect overload",
            manager.contains("Build.VERSION_CODES.O && sourceRectHint != null"),
        )
        assertFalse(
            "the hint must not be gated on API 31 - that threw away the " +
                "entry animation on every device below Android 12",
            manager.contains("Build.VERSION_CODES.S && sourceRectHint"),
        )
    }

    @Test
    fun `the aspect ratio is still clamped to the platform's range`() {
        val manager = code(pipManagerSource().readText())

        assertTrue(
            "the aspect must stay clamped to the platform's PiP range",
            manager.contains("aspect.coerceIn(0.42f, 2.38f)"),
        )
        assertTrue(
            "the seamless resize flag must stay on API 31+",
            manager.contains("builder.setSeamlessResizeEnabled(true)"),
        )
    }

    // ── The documentation ──────────────────────────────────────────────────

    @Test
    fun `the previous release's claim that the chrome was fixed is retracted`() {
        val changelog = changelogSource().readText()
        val section320 = changelog
            .substringAfter("## [3.2.0]")
            .substringBefore("## [3.1.0]")

        assertTrue(
            "the 3.3.0 entry must exist",
            changelog.contains("## [3.3.0]"),
        )
        assertFalse(
            "the 3.2.0 entry must not claim the chrome was hidden before the " +
                "entry - that hide could not reach the pixels",
            section320.contains("which lands without a React commit and without a frame clock"),
        )
        assertTrue(
            "the 3.2.0 entry must point at the retraction",
            section320.contains("Superseded by 3.3.0"),
        )
        assertTrue(
            "the 3.3.0 entry must say plainly that the hide could not reach " +
                "the pixels",
            changelog.contains("could not reach"),
        )
    }

    @Test
    fun `no file carries the mechanically-wrong freeze claim`() {
        // The claim is mechanically wrong. React Native freezes in TWO ways
        // while the Activity is paused: the DISPATCH_UI frame callback is
        // removed (so mount items are never applied to native views) and the
        // timer registry is frozen (so requestAnimationFrame never fires).
        //
        // The literals are assembled from parts, so this test file does not
        // contain them either — and the test's own NAME has to avoid them
        // too, because this file is part of the scan.
        val banned = listOf(
            "pauses the React " + "scheduler",
            "pauses its " + "scheduler",
            "scheduler with the " + "Activity",
            "scheduler when the " + "Activity",
            "does not " + "redraw",
        )

        val offenders = mutableListOf<String>()
        for (file in librarySources()) {
            val text = file.readText()
            for (phrase in banned) {
                if (text.contains(phrase, ignoreCase = true)) {
                    offenders += "${file.name}: $phrase"
                }
            }
        }

        assertEquals(
            "the library must not carry the mechanically-wrong freeze claim - " +
                "the real mechanisms are the DISPATCH_UI frame callback and " +
                "the frozen timer registry: $offenders",
            emptyList<String>(),
            offenders,
        )
    }

    // ── helpers ───────────────────────────────────────────────────────────

    /** The file's CODE, with its comments removed. */
    private fun code(source: String): String =
        source
            .replace(Regex("/\\*.*?\\*/", RegexOption.DOT_MATCHES_ALL), "")
            .replace(Regex("//[^\\n]*"), "")

    /**
     * The body of the companion's `notifyUserLeaveHint`.
     *
     * Scoped to the function, so an assertion about its ORDER cannot be
     * satisfied by a similar-looking line somewhere else in the file.
     */
    private fun leaveHintBody(): String =
        code(bridgeSource().readText())
            .substringAfter("fun notifyUserLeaveHint(activity: Activity): Boolean {")
            .substringBefore("private fun commitPipParams(")

    /**
     * The body of the companion's single-argument
     * `onPictureInPictureModeChanged` — the one the consumer's Activity
     * calls.
     */
    private fun modeChangedBody(): String =
        code(bridgeSource().readText())
            .substringAfter("fun onPictureInPictureModeChanged(isInPictureInPictureMode: Boolean) {")
            .substringBefore("fun onPictureInPictureModeChanged(\n")

    /** The body of `PipManager.buildPipParams`. */
    private fun buildParamsBody(): String =
        code(pipManagerSource().readText())
            .substringAfter("fun buildPipParams(")
            .substringBefore("private fun buildRemoteAction(")

    /** The body of `PipActionReceiver`. */
    private fun receiverBody(): String =
        code(pipManagerSource().readText())
            .substringAfter("class PipActionReceiver : BroadcastReceiver() {")

    /**
     * The library's own sources: the Kotlin main and test sources, the
     * TypeScript, and the two documents that describe the behaviour.
     */
    private fun librarySources(): List<File> {
        val root = repoRoot()
        val files = mutableListOf<File>()
        files += File(root, "CHANGELOG.md")
        files += File(root, "README.md")
        files += sourceFiles(File(root, "android/src/main/java"), "kt")
        files += sourceFiles(File(root, "android/src/test/java"), "kt")
        files += sourceFiles(File(root, "src"), "ts")
        return files
    }

    /**
     * The files under [dir] with the given extension.
     *
     * `File.extension` has NO dot ("kt", not ".kt"), so the extension is
     * compared without one. A guard that matched nothing would pass for
     * ever — which is exactly what a broken filter looks like from the
     * outside: green tests, no coverage.
     */
    private fun sourceFiles(dir: File, extension: String): List<File> {
        if (!dir.isDirectory) return emptyList()
        return dir.walkTopDown()
            .filter { it.isFile && it.extension == extension }
            .toList()
    }

    /** The repository root: the directory that holds `package.json`. */
    private fun repoRoot(): File {
        val start = System.getProperty("user.dir") ?: "."
        var dir: File? = File(start).absoluteFile
        var depth = 0
        while (dir != null && depth < 8) {
            if (File(dir, "package.json").isFile && File(dir, "android").isDirectory) {
                return dir
            }
            dir = dir.parentFile
            depth++
        }
        throw AssertionError("the repository root not found from ${System.getProperty("user.dir")}")
    }

    private fun bridgeSource(): File = findUp("src/main/java/com/simba/player/mpv/MpvBridgeModule.kt")

    private fun renderViewSource(): File = findUp("src/main/java/com/simba/player/mpv/MpvRenderView.kt")

    private fun pipManagerSource(): File = findUp("src/main/java/com/simba/player/PipManager.kt")

    private fun changelogSource(): File = findUp("CHANGELOG.md")

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
