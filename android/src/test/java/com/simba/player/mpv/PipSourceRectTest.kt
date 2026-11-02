package com.simba.player.mpv

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * B-036 — "PiP entry grows out of a black rectangle" — and B-045, which
 * changed what this arithmetic is asked.
 *
 * ## The defect
 *
 * `MpvBridgeModule` built Android's PiP `sourceRectHint` from
 * `PlayerSurface.boundsInWindow()`, which reads `PlayerSurface.viewRef`. The
 * ONLY writer of `viewRef` is `PlayerSurface.mount()`, and the V21/V22
 * architecture never calls it: the picture is now a Fabric view created by
 * React Native. So `boundsInWindow()` answered `null` **forever**, and PiP
 * entry always grew out of a black rectangle instead of animating out of the
 * picture the user was watching.
 *
 * The replacement reads the LIVE picture view
 * (`MpvRenderViewRegistry.current()`) and asks where the VIDEO is inside it.
 *
 * ## What B-045 changed here
 *
 * The arithmetic used to be asked about the ZOOM the picture was rendered
 * with, because the mode was translated into mpv's `video-zoom` — which is a
 * log2 **scale factor**, not a fit / fill / stretch enum. So `cover` was a
 * 2x magnification and `stretch` a 4x one.
 *
 * The modes are now mpv's own properties (`video-zoom` + `keepaspect` +
 * `panscan`, owned by [ResizeMode]), and the fact this arithmetic needs is
 * the one the PiP hint actually depends on: does the picture FILL its view,
 * or FIT inside it?
 *
 *  - **Fills the view** (`cover`, `stretch`) — the picture covers every pixel
 *    of the view, so the visible region IS the view's rect.
 *  - **Fits inside the view** (`contain`) — the visible region is the
 *    largest rect of the video's own shape that fits inside the view.
 *
 * ## What this test can and cannot prove
 *
 * The DECISION is pure — given the view's rect, the video's aspect and
 * whether the picture fills the view, what rect of the window does the video
 * occupy? — so it is tested here as plain JUnit.
 *
 * Plain JUnit, on purpose: this module's Robolectric tests are `@Ignore`d
 * because they cannot run offline. A test that is skipped proves nothing,
 * so the arithmetic lives in `PipSourceRect`, which has no Android framework
 * type in it, and runs for real.
 *
 * The APPLICATION half — the view's cached window rect, the live registry,
 * the bridge's two call sites — needs an Android runtime, so it is pinned by
 * inspecting the SOURCE, the same way `PipAutoEnterPolicyTest` does. The
 * device proof is that PiP entry animates out of the video rather than out
 * of a black rectangle.
 */
class PipSourceRectTest {

    // ── Fit (the picture FITS inside the view) ───────────────────────────

    @Test
    fun `fit letterboxes a video that is wider than the view`() {
        // A 16:9 video in a portrait 1200x1600 view: the frame is the
        // view's FULL WIDTH and a proportionally shorter height, centred
        // vertically. 1200 / 16 * 9 = 675.
        val frame = PipSourceRect.frameInWindow(
            viewLeft = 0,
            viewTop = 0,
            viewWidth = 1200,
            viewHeight = 1600,
            videoAspect = 16f / 9f,
            fillsView = false,
        )

        assertNotNull("a wide video must have a frame", frame)
        val f = frame!!
        assertEquals(1200, f.width)
        assertEquals(675, f.height)
        // Centred vertically: (1600 - 675) / 2 = 462.
        assertEquals(0, f.left)
        assertEquals(462, f.top)
        assertEquals(1200, f.right)
        assertEquals(1137, f.bottom)
    }

    @Test
    fun `fit keeps the frame's shape equal to the video's shape`() {
        // The frame IS the video's shape by construction, which is what
        // lets the PiP window's aspect and the source-rect hint agree.
        val frame = PipSourceRect.frameInWindow(
            viewLeft = 0,
            viewTop = 0,
            viewWidth = 1200,
            viewHeight = 1600,
            videoAspect = 16f / 9f,
            fillsView = false,
        )

        assertNotNull("a wide video must have a frame", frame)
        assertEquals(16f / 9f, frame!!.aspect, 0f)
    }

    @Test
    fun `fit pillarboxes a video that is narrower than the view`() {
        // A 9:16 video in a landscape 1600x1200 view: the frame is the
        // view's FULL HEIGHT and a proportionally narrower width, centred
        // horizontally. 1200 * 9 / 16 = 675.
        val frame = PipSourceRect.frameInWindow(
            viewLeft = 0,
            viewTop = 0,
            viewWidth = 1600,
            viewHeight = 1200,
            videoAspect = 9f / 16f,
            fillsView = false,
        )

        assertNotNull("a narrow video must have a frame", frame)
        val f = frame!!
        assertEquals(675, f.width)
        assertEquals(1200, f.height)
        // Centred horizontally: (1600 - 675) / 2 = 462.
        assertEquals(462, f.left)
        assertEquals(0, f.top)
        assertEquals(9f / 16f, f.aspect, 0f)
    }

    @Test
    fun `fit leaves the frame at the view rect when the shapes already match`() {
        val frame = PipSourceRect.frameInWindow(
            viewLeft = 10,
            viewTop = 20,
            viewWidth = 1920,
            viewHeight = 1080,
            videoAspect = 16f / 9f,
            fillsView = false,
        )

        assertNotNull("a matching video must have a frame", frame)
        val f = frame!!
        assertEquals(10, f.left)
        assertEquals(20, f.top)
        assertEquals(1930, f.right)
        assertEquals(1100, f.bottom)
        assertEquals(16f / 9f, f.aspect, 0f)
    }

    @Test
    fun `fit keeps the frame inside the view`() {
        // The hint has to describe a region that is ON SCREEN. A frame that
        // spilled out of the picture would animate the PiP window out of
        // somewhere the video is not.
        val frame = PipSourceRect.frameInWindow(
            viewLeft = 100,
            viewTop = 200,
            viewWidth = 1200,
            viewHeight = 1600,
            videoAspect = 16f / 9f,
            fillsView = false,
        )

        assertNotNull("a wide video must have a frame", frame)
        val f = frame!!
        assertTrue("left must not leave the view", f.left >= 100)
        assertTrue("top must not leave the view", f.top >= 200)
        assertTrue("right must not leave the view", f.right <= 1300)
        assertTrue("bottom must not leave the view", f.bottom <= 1800)
    }

    @Test
    fun `fit respects the view's position in the window`() {
        // The frame is in WINDOW coordinates, so a view that is not at the
        // window's origin has to move the frame with it. Getting this wrong
        // puts the hint in the wrong corner of the screen.
        val frame = PipSourceRect.frameInWindow(
            viewLeft = 37,
            viewTop = 91,
            viewWidth = 1200,
            viewHeight = 1600,
            videoAspect = 16f / 9f,
            fillsView = false,
        )

        assertNotNull("a wide video must have a frame", frame)
        val f = frame!!
        assertEquals(37, f.left)
        assertEquals(91 + 462, f.top)
    }

    // ── Fill (the picture FILLS the view) ─────────────────────────────────

    @Test
    fun `fill crops the video, so the visible region is the whole view`() {
        val frame = PipSourceRect.frameInWindow(
            viewLeft = 0,
            viewTop = 0,
            viewWidth = 1200,
            viewHeight = 1600,
            videoAspect = 16f / 9f,
            fillsView = true,
        )

        assertNotNull("a filled video must have a frame", frame)
        val f = frame!!
        assertEquals(0, f.left)
        assertEquals(0, f.top)
        assertEquals(1200, f.right)
        assertEquals(1600, f.bottom)
    }

    @Test
    fun `stretch fills the view, so the visible region is the whole view`() {
        val frame = PipSourceRect.frameInWindow(
            viewLeft = 5,
            viewTop = 7,
            viewWidth = 1200,
            viewHeight = 1600,
            videoAspect = 16f / 9f,
            fillsView = true,
        )

        assertNotNull("a stretched video must have a frame", frame)
        val f = frame!!
        assertEquals(5, f.left)
        assertEquals(7, f.top)
        assertEquals(1205, f.right)
        assertEquals(1607, f.bottom)
    }

    // ── The mode decides the fact ────────────────────────────────────────

    @Test
    fun `contain fits inside the view and cover fills it`() {
        // The mode is the only thing that decides the fact, and the fact is
        // the only thing this arithmetic needs. So the mode has to reach
        // this far — a zoom cannot decide it.
        val fit = PipSourceRect.frameInWindow(0, 0, 1200, 1600, 16f / 9f, ResizeMode.fillsView(ResizeMode.CONTAIN))
        val fill = PipSourceRect.frameInWindow(0, 0, 1200, 1600, 16f / 9f, ResizeMode.fillsView(ResizeMode.COVER))

        assertNotNull("contain must have a frame", fit)
        assertNotNull("cover must have a frame", fill)
        assertEquals(675, fit!!.height)
        assertEquals(1600, fill!!.height)
        assertEquals(1200, fill.width)
    }

    @Test
    fun `stretch fills the view`() {
        val fill = PipSourceRect.frameInWindow(0, 0, 1200, 1600, 16f / 9f, ResizeMode.fillsView(ResizeMode.STRETCH))

        assertNotNull("stretch must have a frame", fill)
        assertEquals(1200, fill!!.width)
        assertEquals(1600, fill.height)
    }

    @Test
    fun `an unrecognised mode fits inside the view`() {
        // The app's default `resizeMode` is `contain`, so fit is the mode
        // the picture is actually rendering with. A mode this code does not
        // understand must not silently become "the whole view".
        val contain = PipSourceRect.frameInWindow(0, 0, 1200, 1600, 16f / 9f, ResizeMode.fillsView(ResizeMode.CONTAIN))
        val unknown = PipSourceRect.frameInWindow(0, 0, 1200, 1600, 16f / 9f, ResizeMode.fillsView("bogus"))

        assertNotNull("an unknown mode must still answer a frame", unknown)
        assertEquals(contain, unknown)
    }

    // ── The guards ───────────────────────────────────────────────────────

    @Test
    fun `a view with no area has no frame`() {
        assertNull(PipSourceRect.frameInWindow(0, 0, 0, 1600, 16f / 9f, false))
        assertNull(PipSourceRect.frameInWindow(0, 0, 1200, 0, 16f / 9f, false))
        assertNull(PipSourceRect.frameInWindow(0, 0, -1200, 1600, 16f / 9f, false))
        assertNull(PipSourceRect.frameInWindow(0, 0, 1200, -1600, 16f / 9f, false))
        // The guard is about the VIEW, not about the mode: a picture that
        // fills a view with no area still has no rect to point at.
        assertNull(PipSourceRect.frameInWindow(0, 0, 0, 1600, 16f / 9f, true))
        assertNull(PipSourceRect.frameInWindow(0, 0, 1200, 0, 16f / 9f, true))
    }

    @Test
    fun `an aspect that is not a shape has no frame`() {
        assertNull(PipSourceRect.frameInWindow(0, 0, 1200, 1600, 0f, false))
        assertNull(PipSourceRect.frameInWindow(0, 0, 1200, 1600, -16f / 9f, false))
        assertNull(PipSourceRect.frameInWindow(0, 0, 1200, 1600, Float.NaN, false))
        assertNull(PipSourceRect.frameInWindow(0, 0, 1200, 1600, Float.POSITIVE_INFINITY, false))
        assertNull(PipSourceRect.frameInWindow(0, 0, 1200, 1600, 0f, true))
        assertNull(PipSourceRect.frameInWindow(0, 0, 1200, 1600, -16f / 9f, true))
        assertNull(PipSourceRect.frameInWindow(0, 0, 1200, 1600, Float.NaN, true))
        assertNull(PipSourceRect.frameInWindow(0, 0, 1200, 1600, Float.POSITIVE_INFINITY, true))
    }

    @Test
    fun `the frame never has a zero width or height`() {
        // A zero-sized frame asks the system to animate out of nothing, and
        // a frame whose width or height rounds away to zero is exactly that.
        val viewSizes = listOf(1 to 1, 1 to 100, 100 to 1, 3 to 7, 320 to 240, 1080 to 2400)
        val aspects = listOf(0.01f, 0.5f, 1f, 1.7777778f, 2.35f, 9f / 16f, 100f)

        for ((w, h) in viewSizes) {
            for (aspect in aspects) {
                for (fillsView in listOf(false, true)) {
                    val frame = PipSourceRect.frameInWindow(0, 0, w, h, aspect, fillsView)
                        ?: continue
                    assertTrue(
                        "width must be > 0 for ${w}x$h @ $aspect fillsView=$fillsView",
                        frame.width > 0,
                    )
                    assertTrue(
                        "height must be > 0 for ${w}x$h @ $aspect fillsView=$fillsView",
                        frame.height > 0,
                    )
                }
            }
        }
    }

    // ── The source: the dead reader must stay dead ──────────────────────

    @Test
    fun `the bridge no longer asks the dead registry for the source rect`() {
        // `PlayerSurface.boundsInWindow()` answered `null` forever, because
        // the registry it reads has no writer in this architecture. It is
        // gone, so the call that read it must be gone too.
        val source = bridgeSource().readText()
        assertTrue(
            "MpvBridgeModule must not read the PiP source rect from " +
                "PlayerSurface - that reader always answered null",
            !source.contains("PlayerSurface.boundsInWindow()"),
        )
    }

    @Test
    fun `the bridge reads the source rect from the LIVE picture view`() {
        val source = bridgeSource().readText()

        assertTrue(
            "the source rect must come from the registry React Native writes",
            source.contains("MpvRenderViewRegistry.current()"),
        )
        assertTrue(
            "the source rect must be the video's frame inside the picture, " +
                "computed by the pure helper",
            source.contains("PipSourceRect.frameInWindow("),
        )
    }

    @Test
    fun `the bridge asks the published FILL fact, not the zoom`() {
        // The zoom cannot answer this: mpv's `video-zoom` is a log2 scale
        // factor, and a magnified picture still covers every pixel of the
        // view it is drawn in. The fact the hint depends on is whether the
        // picture fills the view.
        val source = bridgeSource().readText()

        assertTrue(
            "the bridge must ask the picture view whether it fills the view",
            source.contains("view.currentFillsView"),
        )
        assertTrue(
            "the zoom is not a fit / fill / stretch enum and must not be " +
                "used as one",
            !source.contains("currentVideoZoom"),
        )
    }

    @Test
    fun `the PiP window's aspect comes from the SAME frame as the hint`() {
        // If the two could disagree, the system would scale the hinted
        // region to the window non-proportionally and the video would
        // visibly arrive stretched.
        val source = bridgeSource().readText()

        assertTrue(
            "the aspect must be taken from the frame that produced the hint",
            source.contains("frame?.aspect"),
        )
        assertTrue(
            "both PiP entry paths must use the frame's aspect",
            source.split("frame?.aspect").size - 1 >= 2,
        )
    }

    // ── helpers ───────────────────────────────────────────────────────────

    private fun bridgeSource(): File = findUp("src/main/java/com/simba/player/mpv/MpvBridgeModule.kt")

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
