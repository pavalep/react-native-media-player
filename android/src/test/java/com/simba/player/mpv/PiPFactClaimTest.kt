package com.simba.player.mpv

import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Two more Picture-in-Picture facts, pinned in the PROSE as well as in the
 * code.
 *
 * ## Why prose is guarded at all
 *
 * The library's first guards stripped comments before they looked, because
 * they were checking what the CODE does. That was correct for them, and it
 * left a hole. Two false claims reached a published release because a
 * docblock said something the code no longer did:
 *
 *  - **`playback-state`** — a property mpv does **not** have. The code
 *    guard caught the code (it read it in four places). A docblock that
 *    said *"Read from mpv's `playback-state` at the moment of use"* was
 *    invisible to it, and it survived into npm 3.3.1.
 *  - **the platform's auto-enter switch.** The code guard caught the code
 *    (the switch must not be armed). Two docblocks still described the
 *    library as arming it *"only while media is loaded"*.
 *
 * A docblock is a CLAIM. It is read by the next person, and a false one
 * sends them looking for a mechanism that does not exist.
 *
 * ## What these tests can and cannot prove
 *
 * They prove that no source file, and no shipped README, ASSERTS these
 * facts. They cannot prove the platform's behaviour or mpv's property list —
 * only a device and mpv's own source can, and both are cited in the README
 * and the CHANGELOG.
 */
class PiPFactClaimTest {

    // ── The platform's auto-enter switch is never armed ───────────────────

    @Test
    fun `no shipped file claims that the library arms the platform's auto-enter switch`() {
        val offenders = mutableListOf<String>()

        for (file in ClaimScan.files()) {
            for (block in ClaimScan.blocks(file)) {
                if (!MENTIONS_THE_SWITCH.containsMatchIn(block.text)) continue
                if (!CLAIMS_ARMED.containsMatchIn(block.text)) continue
                // A block that says the switch is NOT armed, or that the
                // claim is retracted, is a CORRECTION - it is allowed.
                if (NEGATES_ARMING.containsMatchIn(block.text)) continue
                offenders += "${file.name}:${block.firstLine}: " +
                    block.text.take(240).replace(Regex("\\s+"), " ")
            }
        }

        assertTrue(
            "the platform's auto-enter switch is NEVER armed - the app owns the " +
                "entry. These files still claim the library arms it:\n" +
                offenders.joinToString("\n"),
            offenders.isEmpty(),
        )
    }

    // ── The playback state is not read from `playback-state` ──────────────

    @Test
    fun `no shipped file claims the state is read from playback-state`() {
        val offenders = mutableListOf<String>()

        for (file in ClaimScan.files()) {
            for (block in ClaimScan.blocks(file)) {
                if (!MENTIONS_PLAYBACK_STATE.containsMatchIn(block.text)) continue
                // A block that says the property was used TO BE read, or that
                // it is not an mpv property, or that the claim is retracted,
                // is a CORRECTION - it is allowed.
                if (NEGATES_THE_PROPERTY.containsMatchIn(block.text)) continue
                offenders += "${file.name}:${block.firstLine}: " +
                    block.text.take(240).replace(Regex("\\s+"), " ")
            }
        }

        assertTrue(
            "`playback-state` is NOT an mpv property - it must never be read, " +
                "and nothing may say it is. These files still claim it:\n" +
                offenders.joinToString("\n"),
            offenders.isEmpty(),
        )
    }

    // ── The scan has to actually reach things ─────────────────────────────

    @Test
    fun `the scan actually reaches the library's own files`() {
        // A scan that finds nothing proves nothing. This is the check that
        // the walk reached the sources the claims lived in.
        val files = ClaimScan.files()

        assertTrue("the scan must reach some files", files.isNotEmpty())
        for (expected in listOf("MpvBridgeModule.kt", "MpvRenderView.kt", "PipManager.kt", "PlaybackState.kt", "config.ts", "README.md")) {
            assertTrue("the scan must reach $expected", files.any { it.name == expected })
        }
    }

    // ── the shapes ────────────────────────────────────────────────────────

    private val MENTIONS_THE_SWITCH = Regex(
        "(?i)(auto-enter\\s+switch|autoenter|setAutoEnterEnabled|enter PiP by itself)",
    )

    private val CLAIMS_ARMED = Regex("(?i)(\\barmed\\b|\\barm\\b|\\barming\\b)")

    private val NEGATES_ARMING = Regex("(?i)(\\bnot\\b|\\bnever\\b|\\bfalse\\b|retract)")

    private val MENTIONS_PLAYBACK_STATE = Regex("(?i)playback-state")

    private val NEGATES_THE_PROPERTY = Regex(
        "(?i)(used to read|no longer read|not an mpv property|does not have|not have|" +
            "never read|never was|not among|retract|absent)",
    )
}
