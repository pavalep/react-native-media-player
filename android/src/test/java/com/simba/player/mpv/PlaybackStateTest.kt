package com.simba.player.mpv

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The ONE owner of "what is the engine doing right now".
 *
 * These are PLAIN JUnit tests on purpose. `PlaybackState`'s derivation
 * is pure Kotlin — no Android, no mpv — so it runs on any JVM: no
 * device, no Robolectric, no network download. The Robolectric-dependent
 * tests in this module are `@Ignore`d because they cannot run offline,
 * and a guard that never runs is not a guard.
 *
 * ## What these tests are for
 *
 * The PiP play/pause button was inert on the device (emulator-5554, API
 * 37, 2026-11-04): the action reached the library's receiver, the
 * receiver logged "play/pause: played", and the picture kept moving.
 *
 * The cause was that the receiver read mpv's `playback-state` — a
 * property mpv does NOT have. It is absent from mpv's own manuals
 * (`DOCS/man/options.rst`, `DOCS/man/mpv.rst`) and from mpv's source
 * (`player/command.c`: `"playback-state"` appears ZERO times, while
 * `"idle-active"`, `"eof-reached"`, `"pause"` and `"playback-time"` all
 * appear). The read failed, the helper returned the JSON literal
 * `null`, and "null" is neither "play" nor "idle", so every answer was
 * wrong in the same direction.
 *
 * These tests pin the fix: the real properties, the one owner, and the
 * literal `null` meaning what it means.
 */
class PlaybackStateTest {

    // ── The derivation ────────────────────────────────────────────────────

    @Test
    fun `an engine with nothing loaded is idle`() {
        assertEquals(
            PlaybackState.IDLE,
            PlaybackState.derive(idleActive = true, eofReached = false, paused = false),
        )
    }

    @Test
    fun `a file that reached its end is stopped`() {
        assertEquals(
            PlaybackState.STOPPED,
            PlaybackState.derive(idleActive = false, eofReached = true, paused = false),
        )
    }

    @Test
    fun `a paused file is paused`() {
        assertEquals(
            PlaybackState.PAUSED,
            PlaybackState.derive(idleActive = false, eofReached = false, paused = true),
        )
    }

    @Test
    fun `a running file is playing`() {
        assertEquals(
            PlaybackState.PLAYING,
            PlaybackState.derive(idleActive = false, eofReached = false, paused = false),
        )
    }

    @Test
    fun `idle wins over ended and paused`() {
        // An engine that is idle has nothing loaded, so the end of some
        // earlier file and a stale pause flag must not override it.
        assertEquals(
            PlaybackState.IDLE,
            PlaybackState.derive(idleActive = true, eofReached = true, paused = true),
        )
    }

    @Test
    fun `ended wins over paused`() {
        // A file that ended is stopped, whether or not the pause flag
        // also happens to be set.
        assertEquals(
            PlaybackState.STOPPED,
            PlaybackState.derive(idleActive = false, eofReached = true, paused = true),
        )
    }

    // ── isPlaying ─────────────────────────────────────────────────────────

    @Test
    fun `only playing means playing`() {
        assertTrue(PlaybackState.isPlaying(PlaybackState.PLAYING))
        assertFalse(PlaybackState.isPlaying(PlaybackState.PAUSED))
        assertFalse(PlaybackState.isPlaying(PlaybackState.STOPPED))
        assertFalse(PlaybackState.isPlaying(PlaybackState.IDLE))
    }

    @Test
    fun `the JSON quoting is tolerated`() {
        // The native helper returns a JSON node, so a string arrives
        // wrapped in quotes.
        assertTrue(PlaybackState.isPlaying("\"playing\""))
        assertTrue(PlaybackState.isPlaying("  \"playing\"  "))
    }

    @Test
    fun `the JSON literal null is NOT playing`() {
        // This is the EXACT value the native helper returned for the
        // property that does not exist. Before v3.3.1 it was compared
        // against "play", so the PiP button always answered "not
        // playing" and called PLAY on an already-playing video.
        assertFalse(PlaybackState.isPlaying("null"))
        assertFalse(PlaybackState.isPlaying("\"null\""))
        assertFalse(PlaybackState.isPlaying(null))
        assertFalse(PlaybackState.isPlaying(""))
    }

    @Test
    fun `a stopped file is NOT playing`() {
        // The file ended and the engine is sitting on its last frame. A
        // play/pause button that shows "play" for an ended file is right,
        // so the state has to be read and not guessed.
        assertFalse(PlaybackState.isPlaying(PlaybackState.STOPPED))
    }

    // ── hasMedia ──────────────────────────────────────────────────────────

    @Test
    fun `paused and playing both mean media is loaded`() {
        assertTrue(PlaybackState.hasMedia(PlaybackState.PAUSED))
        assertTrue(PlaybackState.hasMedia(PlaybackState.PLAYING))
    }

    @Test
    fun `idle and stopped mean no media`() {
        assertFalse(PlaybackState.hasMedia(PlaybackState.IDLE))
        assertFalse(PlaybackState.hasMedia(PlaybackState.STOPPED))
    }

    @Test
    fun `the JSON literal null means NO media`() {
        // The EXACT value the native helper returned for the property
        // that does not exist. The old check read
        // "not empty && != idle && != stopped", which was TRUE for
        // "null" — so the library always believed media was loaded, and
        // the app\'s own media check did too.
        assertFalse(PlaybackState.hasMedia("null"))
        assertFalse(PlaybackState.hasMedia(null))
        assertFalse(PlaybackState.hasMedia(""))
    }

    // ── parseBoolean ──────────────────────────────────────────────────────

    @Test
    fun `the boolean properties are read`() {
        assertTrue(PlaybackState.parseBoolean("true"))
        assertTrue(PlaybackState.parseBoolean("\"true\""))
        assertFalse(PlaybackState.parseBoolean("false"))
    }

    @Test
    fun `an unset property is false`() {
        assertFalse(PlaybackState.parseBoolean("null"))
        assertFalse(PlaybackState.parseBoolean(null))
        assertFalse(PlaybackState.parseBoolean(""))
    }

    // ── The properties are the REAL ones ──────────────────────────────────

    @Test
    fun `the owner reads mpv's REAL properties`() {
        val code = code(findUp("src/main/java/com/simba/player/mpv/PlaybackState.kt").readText())

        assertTrue(
            "mpv reports 'nothing loaded' through `idle-active`",
            code.contains("\"idle-active\""),
        )
        assertTrue(
            "mpv reports 'the file ended' through `eof-reached`",
            code.contains("\"eof-reached\""),
        )
        assertTrue(
            "mpv reports 'the clock is stopped' through `pause`",
            code.contains("\"pause\""),
        )
    }

    @Test
    fun `playback-state is NEVER read again`() {
        // `playback-state` is not an mpv property. It was read in four
        // places and every answer was wrong. The comments are stripped
        // first, because the REASON it is not used is written down in
        // prose — and prose is not a read.
        val sources = listOf(
            "src/main/java/com/simba/player/mpv/MpvBridgeModule.kt",
            "src/main/java/com/simba/player/mpv/PlaybackState.kt",
            "src/main/java/com/simba/player/PipManager.kt",
            "src/main/java/com/simba/player/PipNativeEntry.kt",
        )

        for (relative in sources) {
            val file = findUp(relative)
            assertFalse(
                "`playback-state` is not an mpv property - it must never be " +
                    "read again (" + file.name + ")",
                code(file.readText()).contains("playback-state"),
            )
        }
    }

    // ── One owner per fact ────────────────────────────────────────────────

    @Test
    fun `the bridge asks the ONE owner for the playback state`() {
        val code = code(findUp("src/main/java/com/simba/player/mpv/MpvBridgeModule.kt").readText())

        assertTrue(
            "the bridge's state query must go through the owner",
            code.contains("PlaybackState.live()"),
        )
        assertTrue(
            "the PiP action's icon must go through the owner",
            code.contains("PlaybackState.isPlaying("),
        )
        assertTrue(
            "the media check must go through the owner",
            code.contains("PlaybackState.hasMedia("),
        )
    }

    @Test
    fun `the PiP action receiver asks the ONE owner too`() {
        val code = code(findUp("src/main/java/com/simba/player/PipManager.kt").readText())

        assertTrue(
            "the receiver must read the state through the owner - it used " +
                "to read the property that does not exist, so the button " +
                "always called PLAY",
            code.contains("PlaybackState.live()"),
        )
        assertTrue(
            "the receiver must decide through the owner",
            code.contains("PlaybackState.isPlaying("),
        )
    }

    @Test
    fun `the owner is the ONLY thing that reads mpv's state properties`() {
        // A second reader is a second chance to get the same fact wrong,
        // and that is exactly how this defect happened.
        val code = code(findUp("src/main/java/com/simba/player/mpv/MpvBridgeModule.kt").readText())

        assertFalse(
            "the bridge must not read the state properties itself - the " +
                "owner does it",
            code.contains("nativeGetProperty(nativePtr, \"idle-active\")") ||
                code.contains("nativeGetProperty(nativePtr, \"eof-reached\")") ||
                code.contains("nativeGetProperty(nativePtr, \"pause\")"),
        )
    }

    // ── The PiP entry ─────────────────────────────────────────────────────

    @Test
    fun `the platform's auto-enter switch is NOT armed`() {
        val code = code(findUp("src/main/java/com/simba/player/PipManager.kt").readText())

        assertFalse(
            "the platform's auto-enter switch must NOT be armed - it " +
                "transitions the window itself, through the Shell transition, " +
                "and the app's hooks are never called: `onUserLeaveHint()` did " +
                "not fire at all on a HOME press (measured on emulator-5554, " +
                "API 37, 2026-11-04)",
            code.contains("setAutoEnterEnabled(true)"),
        )
    }

    @Test
    fun `the chrome is hidden BEFORE the window is asked for`() {
        val body = code(findUp("src/main/java/com/simba/player/mpv/MpvBridgeModule.kt").readText())
            .substringAfter("fun notifyUserLeaveHint(activity: Activity): Boolean {")
            .substringBefore("private fun enterPictureInPicture(")

        val hide = body.indexOf("hideConsumerChrome()")
        val ask = body.indexOf("enterPictureInPicture(activity, state = state)")

        assertTrue("the entry must hide the chrome", hide >= 0)
        assertTrue("the entry must ask for the window", ask >= 0)
        assertTrue(
            "the chrome must be hidden BEFORE the window is asked for - the " +
                "PiP window IS the Activity's own window, so whatever the " +
                "chrome draws is what the PiP window shows",
            hide < ask,
        )
    }

    // ── helpers ───────────────────────────────────────────────────────────

    /** The file's CODE, with its comments removed. */
    private fun code(source: String): String =
        source
            .replace(Regex("/\\*.*?\\*/", RegexOption.DOT_MATCHES_ALL), "")
            .replace(Regex("//[^\\n]*"), "")

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
