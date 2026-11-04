package com.simba.player.mpv

import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The source-rect hint is a TRANSITION hint, NOT a crop.
 *
 * ## The defect this guards
 *
 * The library's 3.2.0 and 3.3.0 releases claimed — in the README, in the
 * CHANGELOG, in `MpvBridgeModule`'s docblocks, in `MpvRenderView` and in
 * `src/types/config.ts` — that **"the platform CROPS the app's window to the
 * rect in `setSourceRectHint(...)`"**, and that this crop is what keeps the
 * app's chrome out of the Picture-in-Picture window.
 *
 * That is **false**, and the device proved it: with the hint committed, the
 * PiP window showed the app's **full** expanded chrome, scaled down, with a
 * frozen clock (emulator-5554, API 37, 2026-11-04). `setSourceRectHint` is a
 * TRANSITION hint — the region the PiP window animates **FROM** — and
 * nothing more. The chrome is kept out by HIDING it before the entry, in
 * native code.
 *
 * A docblock is a CLAIM. A false claim in a docblock does not fail a build;
 * it sends the next reader looking for a platform mechanism that does not
 * exist, and it is exactly that belief that produced this defect. So the
 * claim is pinned here, mechanically — in the PROSE, not only in the code.
 *
 * ## What this test can and cannot prove
 *
 * It proves that no source file, and no shipped README, ASSERTS the crop. It
 * cannot prove the platform's behaviour — only a device can. That
 * measurement is recorded in the README and the CHANGELOG.
 *
 * ## Why the CHANGELOG is not scanned
 *
 * `CHANGELOG.md` is the historical record: it **quotes** the 3.3.0 claim on
 * purpose, under a retraction note, because a retraction that deletes the
 * wrong text is not a retraction. It is reviewed by hand.
 */
class PipSourceRectClaimTest {

    // ── The guard ──────────────────────────────────────────────────────────

    @Test
    fun `no shipped file claims that the platform crops the app's window`() {
        val offenders = mutableListOf<String>()

        for (file in ClaimScan.files()) {
            for (block in ClaimScan.blocks(file)) {
                if (!ASSERTS_THE_CROP.containsMatchIn(block.text)) continue
                // A block that says the claim is FALSE, or that says the
                // hint does not crop, is a RETRACTION - it is allowed, and it
                // is how the old claim is quoted and corrected.
                if (NEGATES_THE_CROP.containsMatchIn(block.text)) continue
                offenders += "${file.name}:${block.firstLine}: " +
                    block.text.take(240).replace(Regex("\\s+"), " ")
            }
        }

        assertTrue(
            "the platform does NOT crop the app's window - `setSourceRectHint` " +
                "is a TRANSITION hint, not a crop. These files still assert it:\n" +
                offenders.joinToString("\n"),
            offenders.isEmpty(),
        )
    }

    @Test
    fun `the scan actually reaches the library's own files`() {
        // A scan that finds nothing proves nothing. This is the check that
        // the walk reached the sources the claim lived in.
        val files = ClaimScan.files()

        assertTrue("the scan must reach some files", files.isNotEmpty())
        for (expected in listOf("MpvBridgeModule.kt", "MpvRenderView.kt", "PipManager.kt", "config.ts", "README.md")) {
            assertTrue("the scan must reach $expected", files.any { it.name == expected })
        }
    }

    @Test
    fun `the scan reaches every file the false claim lived in`() {
        // The guard's own reach: if the walk silently stopped at the first
        // directory, the guard would pass while covering nothing.
        val files = ClaimScan.files()

        assertTrue(
            "the scan must reach the Kotlin sources",
            files.count { it.extension == "kt" } >= 10,
        )
    }

    // ── the shapes ────────────────────────────────────────────────────────

    /**
     * The shape of the FALSE claim. It says the platform crops a window.
     */
    private val ASSERTS_THE_CROP = Regex(
        "(?i)(crops?\\s+(\\*+\\s*)?(the\\s+)?(app'?s|your)\\s+window" +
            "|platform\\s+crops?" +
            "|cropped\\s+away\\s+by\\s+the\\s+platform)",
    )

    /**
     * The shape of a CORRECTION. It says the hint does NOT crop, or that the
     * claim is false, or that it is retracted.
     */
    private val NEGATES_THE_CROP = Regex(
        "(?i)(not[\\s*]*a?[\\s*]*crop" +
            "|no[\\s*]*crop" +
            "|never[\\s*]*crop" +
            "|is[\\s*]*false" +
            "|retract)",
    )
}
