package com.simba.player.mpv

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * B-007 — "the native side discards mpv's return code".
 *
 * mpv reports a command failure through the RETURN VALUE of
 * `mpv_command()`: 0 is success, a negative value is one of mpv's own
 * error codes (`include/mpv/client.h`, `mpv_error`):
 *
 *   MPV_ERROR_COMMAND        = -12   the core refused the command
 *   MPV_ERROR_LOADING_FAILED = -13   the source could not be opened
 *
 * Before this fix, `main.cpp` threw those values away for `seek`, the
 * relative `seek` and `playlist-clear`, so a refused command was
 * INDISTINGUISHABLE from a completed one: the scrub bar did not move
 * and nothing was reported anywhere. The app believed it worked.
 *
 * ## What this test can and cannot prove
 *
 * The C++ has NO unit-test harness (the module's CMake builds the .so
 * for the AAR; there is no test binary), and mpv itself is not
 * available to a JVM test. So the RUNTIME proof of "a refused seek
 * reaches JS" needs a device — that part is honestly untestable here.
 *
 * What IS testable, and what this file tests:
 *
 *  1. The CONTRACT a refusal lands on. The native layer reports the
 *     refusal through the EXISTING error path (`MPVLib.onNativeError`
 *     -> the `onError` event), and the bridge maps mpv's numeric code
 *     to the lib's stable `{codeName, code}` pair. A refused command
 *     must land on `E_COMMAND_FAILED` / 3016 — a documented, permanent
 *     number — and NOT on a message-derived guess.
 *
 *  2. The NATIVE SOURCE itself. The defect was literally "the return
 *     value is thrown away", which is a property of the SOURCE, not of
 *     a runtime value. So the source is inspected: every `mpv_command()`
 *     call site must be one that either reports a refusal or is the one
 *     documented fire-and-forget, and the three commands the register
 *     named must be issued through the reporting helper.
 *
 * These are guard tests, not a device proof. They fail when the
 * behaviour regresses; they cannot prove the runtime path end to end.
 */
class MpvCommandFailureTest {

    // ── The contract a refused command lands on ──────────────────────────

    @Test
    fun `a refused command lands on the stable E_COMMAND_FAILED contract`() {
        // MPV_ERROR_COMMAND = -12 (mpv's `include/mpv/client.h`).
        assertEquals(
            "E_COMMAND_FAILED",
            MpvErrorContract.mapCode(MPV_ERROR_COMMAND, "mpv command 'seek' failed: command failed"),
        )
        assertEquals(
            3016,
            MpvErrorContract.numeric(
                MpvErrorContract.mapCode(MPV_ERROR_COMMAND, "mpv command 'seek' failed: command failed"),
            ),
        )
    }

    @Test
    fun `the command code is chosen by NUMBER and not by the message`() {
        // The message heuristics are the FALLBACK for codes that carry
        // no information of their own. -12 and -13 carry theirs, so a
        // message that would trip the fallback ("format", "codec",
        // "network", ...) must not hijack them.
        assertEquals(
            "E_COMMAND_FAILED",
            MpvErrorContract.mapCode(MPV_ERROR_COMMAND, "unsupported codec format network"),
        )
        // MPV_ERROR_LOADING_FAILED = -13.
        assertEquals(
            "E_LOAD_FAILED",
            MpvErrorContract.mapCode(MPV_ERROR_LOADING_FAILED, "unsupported codec format network"),
        )
        assertEquals(3001, MpvErrorContract.numeric("E_LOAD_FAILED"))
    }

    @Test
    fun `an unmapped code degrades instead of breaking the bridge`() {
        // The numeric codes are PERMANENT (do not reuse one for a
        // different meaning). An unmapped code degrades to 0 rather
        // than throwing, so a new mpv code cannot break the bridge.
        assertEquals(0, MpvErrorContract.numeric("E_SOMETHING_NEW"))
        // The message never gets a vote on a code that carries its own:
        // -12 is E_COMMAND_FAILED with or without a message.
        assertEquals(
            "an empty message must not change the code the command lands on",
            3016,
            MpvErrorContract.numeric(MpvErrorContract.mapCode(MPV_ERROR_COMMAND, "")),
        )
    }

    // ── The native source: no result is thrown away ──────────────────────

    @Test
    fun `no mpv command call in the native source throws its return value away`() {
        val blocks = blocks()
        val callSites = blocks.flatMap { block ->
            block.codeLines.mapIndexedNotNull { index, line ->
                if (line.contains("mpv_command(")) block.name to index else null
            }
        }
        assertTrue(
            "main.cpp must still contain mpv_command() call sites (the scan found none)",
            callSites.isNotEmpty(),
        )
        callSites.forEach { (function, _) ->
            assertTrue(
                "mpv_command() is called directly in '$function'. Every command that can " +
                    "fail must go through runMpvCommand(), which REPORTS the refusal; " +
                    "the only direct callers are the reporting helper itself, the " +
                    "documented fire-and-forget flush, and the two loadfile paths that " +
                    "already capture and act on the result.",
                function in DIRECT_CALLERS_ALLOWED,
            )
        }
    }

    @Test
    fun `the three commands the register named are issued through the reporting helper`() {
        val blocks = blocks()

        // `seek` (absolute) and `seek` (relative) — the register's first
        // two. The args array and the reporting call live in the same
        // function, so the function is what is checked.
        val seekCallers = blocks.filter { block ->
            block.codeLines.any { it.contains("""{"seek", cmd,""") }
        }
        assertEquals(
            "both the absolute and the relative seek must exist",
            2,
            seekCallers.size,
        )
        seekCallers.forEach { block ->
            assertTrue(
                "the seek in '${block.name}' must be issued through runMpvCommand() so a " +
                    "refusal is reported instead of swallowed",
                block.codeLines.any { it.contains("runMpvCommand(") },
            )
        }

        // `playlist-clear` — the register's third. It is issued from two
        // places: the load-playlist path and the clear path.
        val clearCallers = blocks.filter { block ->
            block.codeLines.any { it.contains("""{"playlist-clear", nullptr}""") }
        }
        assertEquals(
            "the playlist must be cleared from both the load path and the clear path",
            2,
            clearCallers.size,
        )
        clearCallers.forEach { block ->
            assertTrue(
                "the playlist-clear in '${block.name}' must be issued through " +
                    "runMpvCommand() so a refusal is reported instead of swallowed",
                block.codeLines.any { it.contains("runMpvCommand(") },
            )
        }
    }

    @Test
    fun `a refused command is reported through the EXISTING error path`() {
        val blocks = blocks()

        val runner = blocks.single { it.name == "runMpvCommand" }
        assertTrue(
            "runMpvCommand() must check the result it got from mpv",
            runner.codeLines.any { it.contains("result < 0") },
        )
        assertTrue(
            "runMpvCommand() must report the refusal",
            runner.codeLines.any { it.contains("reportCommandFailure(") },
        )

        val reporter = blocks.single { it.name == "reportCommandFailure" }
        assertTrue(
            "the refusal must travel the EXISTING error callback (MPVLib.onNativeError), " +
                "not a new event and not a new channel",
            reporter.codeLines.any { it.contains("g_mid_onError") },
        )
        // `recoverable = true` is the TRUTH for a refused command:
        // playback did not stop, so the app must not paint a terminal
        // error card over a picture that is still moving.
        assertTrue(
            "a refused command must be reported as recoverable (playback continued)",
            reporter.codeLines.any { it.contains("static_cast<jboolean>(true)") },
        )
    }

    @Test
    fun `the one fire-and-forget command says so in the source`() {
        // `flushMpvCore` runs mpv's no-op `ignore` command purely to
        // BLOCK until mpv drains its core queue. Its return value
        // carries no information, so it is deliberately not acted on —
        // but that has to be DOCUMENTED, so the next reader does not
        // mistake it for the B-007 defect again.
        val flush = blocks().single { it.name == "flushMpvCore" }
        assertTrue(
            "the fire-and-forget flush must document that it is deliberate",
            flush.rawLines.any { it.contains("FIRE-AND-FORGET") },
        )
    }

    // ── Helpers ──────────────────────────────────────────────────────────

    /**
     * One top-level function of main.cpp.
     *
     * `rawLines` keeps the comments (a documentation assertion needs
     * them); `codeLines` has them stripped (a code assertion must not
     * be fooled by prose — including this fix's own explanation).
     */
    private data class FunctionBlock(
        val name: String,
        val rawLines: List<String>,
        val codeLines: List<String>,
    )

    /**
     * The functions in main.cpp that may call `mpv_command()` directly.
     *
     *  - `runMpvCommand` — the reporting helper. It IS the fix.
     *  - `flushMpvCore` — the documented fire-and-forget `ignore`.
     *  - `nativeLoadFileInternal` / `nativeLoadPlaylist` — the two
     *    `loadfile` paths. They already CAPTURE the result and act on it
     *    (the pending request token is dropped, and the playlist load
     *    logs the failing index); a load failure is reported to JS by
     *    mpv's own END_FILE event, which is a TERMINAL failure and is
     *    therefore not the same contract as a refused command.
     */
    private val DIRECT_CALLERS_ALLOWED = setOf(
        "runMpvCommand",
        "flushMpvCore",
        "nativeLoadFileInternal",
        "Java_com_simba_player_mpv_MPVLib_nativeLoadPlaylist",
    )

    /** main.cpp, split into its top-level functions. */
    private fun blocks(): List<FunctionBlock> {
        val raw = mainCpp().readText()
        val rawLines = raw.lines()
        // stripComments keeps the line count intact, so the two views
        // stay aligned by index.
        val codeLines = stripComments(raw).lines()
        assertEquals(
            "the comment stripper must not change the line count",
            rawLines.size,
            codeLines.size,
        )

        val blocks = mutableListOf<FunctionBlock>()
        var currentName: String? = null
        var currentStart = 0
        rawLines.forEachIndexed { index, line ->
            val name = topLevelFunctionName(line)
            if (name != null) {
                if (currentName != null) {
                    blocks += block(currentName!!, currentStart, index, rawLines, codeLines)
                }
                currentName = name
                currentStart = index
            }
        }
        if (currentName != null) {
            blocks += block(currentName!!, currentStart, rawLines.size, rawLines, codeLines)
        }
        return blocks
    }

    private fun block(
        name: String,
        from: Int,
        to: Int,
        rawLines: List<String>,
        codeLines: List<String>,
    ) = FunctionBlock(
        name = name,
        rawLines = rawLines.subList(from, to),
        codeLines = codeLines.subList(from, to),
    )

    /**
     * Split main.cpp into its top-level functions.
     *
     * A top-level definition in this file always starts at column 0
     * with a name followed by `(` — that is true of the `static` helpers
     * and of the `Java_com_simba_player_mpv_MPVLib_*` JNI entry points
     * alike (the `extern "C" JNIEXPORT ... JNICALL` line above them
     * carries no `(` and is therefore not a definition).
     */
    private fun topLevelFunctionName(line: String): String? {
        if (line.isEmpty() || line[0] == ' ' || line[0] == '\t') return null
        if (!line[0].isLetter() && line[0] != '_') return null
        val open = line.indexOf('(')
        if (open <= 0) return null
        val head = line.substring(0, open).trim()
        val name = head.split(' ', '\t').lastOrNull() ?: return null
        return name.ifEmpty { null }
    }

    /**
     * Remove C/C++ comments so a scan cannot be fooled by prose — or by
     * this file's own explanation of the fix. The line count is
     * preserved: a comment becomes an empty line, never a missing one.
     */
    private fun stripComments(source: String): String {
        val out = StringBuilder(source.length)
        var i = 0
        var inLineComment = false
        var inBlockComment = false
        var inString = false
        var inChar = false
        while (i < source.length) {
            val c = source[i]
            val next = if (i + 1 < source.length) source[i + 1] else ' '
            if (inLineComment) {
                if (c == '\n') {
                    inLineComment = false
                    out.append(c)
                }
                i++
            } else if (inBlockComment) {
                if (c == '*' && next == '/') {
                    inBlockComment = false
                    i += 2
                } else {
                    if (c == '\n') out.append(c)
                    i++
                }
            } else if (inString) {
                out.append(c)
                if (c == '\\' && i + 1 < source.length) {
                    out.append(source[i + 1])
                    i += 2
                    continue
                }
                if (c == '"') inString = false
                i++
            } else if (inChar) {
                out.append(c)
                if (c == '\\' && i + 1 < source.length) {
                    out.append(source[i + 1])
                    i += 2
                    continue
                }
                if (c == '\'') inChar = false
                i++
            } else {
                when {
                    c == '/' && next == '/' -> {
                        inLineComment = true
                        i += 2
                    }
                    c == '/' && next == '*' -> {
                        inBlockComment = true
                        i += 2
                    }
                    c == '"' -> {
                        inString = true
                        out.append(c)
                        i++
                    }
                    c == '\'' -> {
                        inChar = true
                        out.append(c)
                        i++
                    }
                    else -> {
                        out.append(c)
                        i++
                    }
                }
            }
        }
        return out.toString()
    }

    /** Locate main.cpp from the test's working directory, walking upwards. */
    private fun mainCpp(): File {
        val start = System.getProperty("user.dir") ?: "."
        var dir: File? = File(start).absoluteFile
        var depth = 0
        while (dir != null && depth < 8) {
            val candidate = File(dir, "src/main/cpp/main.cpp")
            if (candidate.isFile) return candidate
            dir = dir.parentFile
            depth++
        }
        throw AssertionError(
            "main.cpp not found from ${System.getProperty("user.dir")}",
        )
    }

    private companion object {
        /** mpv's `MPV_ERROR_COMMAND` (`include/mpv/client.h`). */
        const val MPV_ERROR_COMMAND = -12

        /** mpv's `MPV_ERROR_LOADING_FAILED` (`include/mpv/client.h`). */
        const val MPV_ERROR_LOADING_FAILED = -13
    }
}
