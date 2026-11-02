package com.simba.player.mpv

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * B-045 — "`resizeMode` was a zoom factor, not a fit / fill / stretch".
 *
 * ## The defect
 *
 * `<SimbaVideo resizeMode="cover" />` was translated into mpv's `video-zoom`
 * **in JavaScript**: `cover` became `"1"`, `stretch` became `"2"`. mpv's
 * `video-zoom` is a log2 **scale factor** — its own manual says
 * "`--video-zoom=0` is unscaled, `--video-zoom=1` is twice the size,
 * `--video-zoom=-2` is one fourth of the size" — so `cover` rendered as a
 * 2x magnified, cropped picture and `stretch` as a 4x magnified one.
 * Neither was what its name said, and the aspect was never ignored.
 *
 * The app asks for `cover` on its mini-player dock, so the dock was a hugely
 * zoomed picture.
 *
 * ## The fix
 *
 * The three modes are three DIFFERENT combinations of mpv's own properties,
 * and the combination is owned in one place — [ResizeMode]:
 *
 * | mode     | `video-zoom` | `keepaspect` | `panscan` |
 * |----------|--------------|---------------|-----------|
 * | contain  | `"0"`        | `"yes"`       | `"0"`     |
 * | cover    | `"0"`        | `"yes"`       | `"1.0"`   |
 * | stretch  | `"0"`        | `"no"`        | `"0"`     |
 *
 * ## What this test can and cannot prove
 *
 * The MAPPING is pure — no Android type, no React Native type — so it is
 * tested here as plain JUnit.
 *
 * Plain JUnit, on purpose: this module's Robolectric suites are `@Ignore`d
 * because they cannot run offline. A test that is skipped proves nothing,
 * so the decision lives in `ResizeMode`, which has no Android framework type
 * in it, and runs for real.
 *
 * The APPLICATION half — that the native side really writes those three
 * properties, and that the PiP hint really asks the published fact —
 * needs an Android runtime, so it is pinned by inspecting the SOURCE, the
 * same way `PipAutoEnterPolicyTest` does. The device proof is the picture
 * itself: a `cover` dock is cropped to fill it, and a `stretch` dock ignores
 * the video's aspect.
 */
class ResizeModeTest {

    // ── The mapping ───────────────────────────────────────────────────────

    @Test
    fun `contain keeps the aspect, crops nothing, and is not scaled`() {
        val s = ResizeMode.settingsFor(ResizeMode.CONTAIN)

        assertEquals("0", s.videoZoom)
        assertEquals("yes", s.keepAspect)
        assertEquals("0", s.panScan)
        assertFalse("contain fits inside the view", s.fillsView)
    }

    @Test
    fun `cover crops the overflow and keeps the aspect`() {
        val s = ResizeMode.settingsFor(ResizeMode.COVER)

        assertEquals("0", s.videoZoom)
        assertEquals("yes", s.keepAspect)
        assertEquals("1.0", s.panScan)
        assertTrue("cover fills the view", s.fillsView)
    }

    @Test
    fun `stretch ignores the aspect`() {
        val s = ResizeMode.settingsFor(ResizeMode.STRETCH)

        assertEquals("0", s.videoZoom)
        assertEquals("no", s.keepAspect)
        assertEquals("0", s.panScan)
        assertTrue("stretch fills the view", s.fillsView)
    }

    @Test
    fun `no mode is ever a magnification`() {
        // mpv's `video-zoom` is a log2 scale factor: 0 unscaled, 1 twice the
        // size, 2 four times the size. A mode that reached it as "1" or "2"
        // would be a zoom, not a cover or a stretch.
        for (mode in listOf(ResizeMode.CONTAIN, ResizeMode.COVER, ResizeMode.STRETCH)) {
            assertEquals(
                "mode $mode must not magnify the picture",
                "0",
                ResizeMode.settingsFor(mode).videoZoom,
            )
        }
    }

    @Test
    fun `cover is contain plus a crop, and stretch is contain plus an ignored aspect`() {
        // The two non-contain modes are contain with exactly ONE property
        // changed. That is what makes the reset safe: switching back to
        // contain puts that one property back, because the mapping always
        // writes all three.
        val contain = ResizeMode.CONTAIN_SETTINGS
        val cover = ResizeMode.COVER_SETTINGS
        val stretch = ResizeMode.STRETCH_SETTINGS

        assertEquals(contain.videoZoom, cover.videoZoom)
        assertEquals(contain.keepAspect, cover.keepAspect)
        assertNotEquals(contain.panScan, cover.panScan)

        assertEquals(contain.videoZoom, stretch.videoZoom)
        assertEquals(contain.panScan, stretch.panScan)
        assertNotEquals(contain.keepAspect, stretch.keepAspect)
    }

    @Test
    fun `every mode sets all three properties, so a switch resets the previous mode`() {
        // mpv's properties PERSIST. A mode that left `panscan` or
        // `keepaspect` alone would inherit the previous mode's value, so
        // cover -> contain has to put `panscan` back to 0 and stretch ->
        // contain has to put `keepaspect` back to yes.
        for (mode in listOf(ResizeMode.CONTAIN, ResizeMode.COVER, ResizeMode.STRETCH)) {
            val s = ResizeMode.settingsFor(mode)
            assertTrue("mode $mode must set video-zoom", s.videoZoom.isNotBlank())
            assertTrue("mode $mode must set keepaspect", s.keepAspect.isNotBlank())
            assertTrue("mode $mode must set panscan", s.panScan.isNotBlank())
        }

        assertEquals("0", ResizeMode.settingsFor(ResizeMode.CONTAIN).panScan)
        assertEquals("yes", ResizeMode.settingsFor(ResizeMode.CONTAIN).keepAspect)
    }

    @Test
    fun `a mode name is trimmed and lower-cased`() {
        assertEquals(ResizeMode.COVER_SETTINGS, ResizeMode.settingsFor("COVER"))
        assertEquals(ResizeMode.COVER_SETTINGS, ResizeMode.settingsFor("  cover  "))
        assertEquals(ResizeMode.STRETCH_SETTINGS, ResizeMode.settingsFor("Stretch"))
        assertEquals(ResizeMode.CONTAIN_SETTINGS, ResizeMode.settingsFor("Contain"))
    }

    @Test
    fun `an unrecognised mode behaves like contain`() {
        // The app's default `resizeMode` is `contain`, so contain is the
        // mode the picture is actually rendering with in the common case.
        // A mode this build does not know must not silently become a crop.
        for (mode in listOf(null, "", "   ", "bogus", "fill", "zoom")) {
            assertEquals(
                "mode '$mode' must fall back to contain",
                ResizeMode.CONTAIN_SETTINGS,
                ResizeMode.settingsFor(mode),
            )
        }
    }

    @Test
    fun `fillsView agrees with the settings`() {
        assertFalse(ResizeMode.fillsView(ResizeMode.CONTAIN))
        assertTrue(ResizeMode.fillsView(ResizeMode.COVER))
        assertTrue(ResizeMode.fillsView(ResizeMode.STRETCH))
        assertFalse(ResizeMode.fillsView("bogus"))
        assertFalse(ResizeMode.fillsView(null))
    }

    // ── The source: the native half must use this owner ─────────────────

    @Test
    fun `the render view writes all three mpv properties`() {
        // One property at a time is the bug: mpv's properties persist, so a
        // mode that only wrote what it "uses" would inherit the previous
        // mode's value.
        val source = libSource("src/main/java/com/simba/player/mpv/MpvRenderView.kt").readText()

        assertTrue(
            "the view must write video-zoom",
            source.contains("ResizeMode.PROP_VIDEO_ZOOM"),
        )
        assertTrue(
            "the view must write keepaspect",
            source.contains("ResizeMode.PROP_KEEP_ASPECT"),
        )
        assertTrue(
            "the view must write panscan",
            source.contains("ResizeMode.PROP_PANSCAN"),
        )
    }

    @Test
    fun `the view manager passes the mode NAME through, not a zoom`() {
        val source = libSource("src/main/java/com/simba/player/mpv/MpvRenderViewManager.kt").readText()

        assertTrue(
            "the prop must reach the view as its mode name",
            source.contains("view.applyResizeMode(resizeMode)"),
        )
        assertTrue(
            "the zoom path must be gone - video-zoom is a log2 scale factor",
            !source.contains("applyVideoZoom"),
        )
    }

    @Test
    fun `the view publishes the mode it is ACTUALLY rendering with`() {
        val source = libSource("src/main/java/com/simba/player/mpv/MpvRenderView.kt").readText()

        assertTrue(
            "the view must publish the mode it renders with",
            source.contains("var currentResizeMode"),
        )
        assertTrue(
            "the view must publish whether the picture fills its view",
            source.contains("var currentFillsView"),
        )
        assertTrue(
            "the zoom must no longer be published",
            !source.contains("currentVideoZoom"),
        )
    }

    // ── helpers ───────────────────────────────────────────────────────────

    private fun libSource(relative: String): File = findUp(relative)

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
