package com.simba.player

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The notification artwork, and the crash it was taken down by.
 *
 * ## What this test can and cannot prove
 *
 * The DECISION parts are pure and are fully tested here: how an artwork
 * path is keyed, whether it is remote, and how a decoded image is sized.
 *
 * The part that actually kills the app is an interaction between this
 * library and the ANDROID FRAMEWORK: the framework shares (ashmem-izes)
 * the icon bitmap it is handed, so handing it the same instance twice is
 * what aborted the process. That interaction needs a real framework, and
 * this module's Robolectric tests are `@Ignore`d because they cannot run
 * offline - so the INVARIANT is pinned by inspecting the SOURCE, which is
 * where the defect lived in the first place.
 *
 * These are guard tests, not a device proof. The device proof is that the
 * app plays a radio station for minutes on API 37 without the framework
 * aborting the process.
 */
class NotificationArtworkTest {

    // ── The sizing arithmetic ────────────────────────────────────────────

    @Test
    fun `a source that already fits is not resized`() {
        assertEquals(
            256 to 256,
            ArtworkSizing.shrunkSize(256, 256),
        )
        assertEquals(
            100 to 50,
            ArtworkSizing.shrunkSize(100, 50),
        )
    }

    @Test
    fun `a square is shrunk to the max edge`() {
        assertEquals(
            256 to 256,
            ArtworkSizing.shrunkSize(1000, 1000),
        )
    }

    @Test
    fun `a wide source keeps its shape`() {
        val (width, height) = ArtworkSizing.shrunkSize(1000, 500)
        assertEquals(256, width)
        assertEquals(128, height)
    }

    @Test
    fun `a tall source keeps its shape`() {
        val (width, height) = ArtworkSizing.shrunkSize(500, 1000)
        assertEquals(128, width)
        assertEquals(256, height)
    }

    @Test
    fun `a one pixel source is left alone`() {
        assertEquals(
            1 to 1,
            ArtworkSizing.shrunkSize(1,  1),
        )
    }

    // ── The path rules ───────────────────────────────────────────────────

    @Test
    fun `a path is keyed without its whitespace`() {
        assertEquals(
            "https://example.com/a.png",
            ArtworkPath.normalize("  https://example.com/a.png  "),
        )
        assertEquals("", ArtworkPath.normalize("   "))
    }

    @Test
    fun `only http and https are remote`() {
        assertTrue(ArtworkPath.isRemote("https://example.com/a.png"))
        assertTrue(ArtworkPath.isRemote("http://example.com/a.png"))
        assertFalse(ArtworkPath.isRemote("/data/local/a.png"))
        assertFalse(ArtworkPath.isRemote(""))
    }

    // ── The source: the framework must never be handed a bitmap twice ────

    @Test
    fun `the notification bitmap is a COPY and never the source itself`() {
        val source = artworkSource().readText()
        assertTrue(
            "the notification bitmap must be a copy - the framework shares " +
                "the bitmap it is handed, so the same instance must never " +
                "be handed over twice",
            source.contains("fun bitmapForNotification(): Bitmap? = privateCopy(source)"),
        )
    }

    @Test
    fun `every bitmap this class owns is a copy`() {
        val source = artworkSource().readText()
        assertTrue(
            "the fallback must be OUR copy - the Resources-cached bitmap is " +
                "shared with every other user of that drawable, and handing " +
                "it to the framework shares a bitmap the whole cache still " +
                "points at",
            source.contains(
                "privateCopy(BitmapFactory.decodeResource(resources, android.R.drawable.ic_media_play))",
            ),
        )
        assertTrue(
            "the copy must produce its OWN pixels - that is what keeps the " +
                "framework's sharing away from the source",
            source.contains("bitmap?.copy(Bitmap.Config.ARGB_8888, false)"),
        )
    }

    @Test
    fun `the artwork is fetched OFF the notification thread`() {
        val source = artworkSource().readText()
        assertTrue(
            "the fetch must run on its own thread - it is network I/O with " +
                "a 3 s connect timeout, and it used to run while the " +
                "notification was being built, once a second",
            source.contains("Executors.newSingleThreadExecutor"),
        )
        assertTrue(
            "the fetch must be submitted to that thread",
            source.contains("loader.execute {"),
        )
    }

    // ── The source: the service must not do any of this itself ──────────

    @Test
    fun `the service does not fetch artwork itself any more`() {
        val source = serviceSource().readText()
        assertFalse(
            "the service must not open a connection - the artwork owns " +
                "that, and the fetch used to block the notification thread",
            source.contains("openConnection"),
        )
        assertFalse(
            "the service must not decode bitmaps - the artwork owns that",
            source.contains("BitmapFactory"),
        )
    }

    @Test
    fun `the service hands the notification a FRESH bitmap`() {
        val source = serviceSource().readText()
        assertTrue(
            "the large icon must come from the artwork's fresh copy - the " +
                "framework must never see the same instance twice",
            source.contains("notificationArtwork.bitmapForNotification()"),
        )
        assertTrue(
            "the large icon must BE that copy",
            source.contains(".setLargeIcon(artworkBitmap)"),
        )
    }

    @Test
    fun `the service does not KEEP the notification bitmap`() {
        val source = serviceSource().readText()
        assertFalse(
            "the service must not import a Bitmap at all - a kept bitmap " +
                "is a bitmap the framework will be handed twice",
            source.contains("import android.graphics.Bitmap"),
        )
        assertFalse(
            "the service must not keep the notification bitmap in a field",
            source.contains("private var artworkBitmap"),
        )
    }

    @Test
    fun `the service tells the artwork when the path changes`() {
        val source = serviceSource().readText()
        assertTrue(
            "the service must tell the artwork about the path, so the " +
                "fetch can happen off the notification thread",
            source.contains("notificationArtwork.request("),
        )
    }

    @Test
    fun `the artwork is released with the service`() {
        val source = serviceSource().readText()
        assertTrue(
            "the service must release the artwork - the loader thread must " +
                "not outlive the service",
            source.contains("notificationArtwork.release()"),
        )
    }

    // ── helpers ───────────────────────────────────────────────────────────

    private fun artworkSource(): File =
        findUp("src/main/java/com/simba/player/NotificationArtwork.kt")

    private fun serviceSource(): File =
        findUp("src/main/java/com/simba/player/MediaPlaybackService.kt")

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
