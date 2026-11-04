package com.simba.player.mpv

import com.simba.player.PlaybackHost

/**
 * The ONE owner of "what is the engine doing right now".
 *
 * ## Why this file exists
 *
 * Until v3.3.1 this library had TWO owners of the same fact:
 *
 *  - `MpvBridgeModule.getPlaybackState()` read mpv's REAL properties —
 *    `idle-active`, `eof-reached`, `pause` — and derived one of
 *    `idle` / `stopped` / `paused` / `playing`.
 *
 *  - the PiP paths read a property named **`playback-state`**, which is
 *    NOT an mpv property. It is absent from mpv's own option and
 *    property manuals (`DOCS/man/options.rst`, `DOCS/man/mpv.rst`) and
 *    from mpv's source (`player/command.c`: `"playback-state"` appears
 *    ZERO times, while `"idle-active"`, `"eof-reached"`, `"pause"` and
 *    `"playback-time"` all appear).
 *
 * The consequence was measured on emulator-5554 (API 37) on
 * 2026-11-04: `mpv_get_property` on a property that does not exist
 * fails, the bridge's native helper returns the JSON literal `null`,
 * and every caller of that read answered "not playing" — forever.
 *
 * So the PiP play/pause button called `play` on an already-playing
 * video and logged "play/pause: played" while the picture kept moving.
 * The button looked alive and did nothing.
 *
 * Two owners for one fact is two chances to get it wrong, and this one
 * was wrong in a way no test could see: the string it compared against
 * was a plausible-looking vocabulary that mpv never emits.
 *
 * ## The vocabulary
 *
 * Four words, and they are the ones this library has always published
 * to JS through `getPlaybackState()`:
 *
 *  - `idle` — no media, the engine has nothing loaded.
 *  - `stopped` — the file reached its end.
 *  - `paused` — the file is loaded and the clock is not running.
 *  - `playing` — the picture is moving.
 *
 * ## What is deliberately NOT here
 *
 * The derivation is PURE Kotlin — no Android, no mpv — so it can be
 * exercised by a plain JUnit test with no device, no Robolectric and no
 * network download. The live read is [live], and it is the only
 * function here that touches the engine.
 */
object PlaybackState {

    // ── The vocabulary ────────────────────────────────────────────────────

    const val IDLE = "idle"
    const val STOPPED = "stopped"
    const val PAUSED = "paused"
    const val PLAYING = "playing"

    // ── mpv's REAL property names ─────────────────────────────────────────

    /**
     * mpv's real properties. These three are the ones that answer the
     * question; `playback-state` is NOT among them and never was.
     */
    const val PROP_IDLE_ACTIVE = "idle-active"
    const val PROP_EOF_REACHED = "eof-reached"
    const val PROP_PAUSE = "pause"

    // ── The pure derivation ───────────────────────────────────────────────

    /**
     * The state, derived from mpv's three real properties.
     *
     * The order matters and it is the order the platform's own session
     * uses: a file that ended is `stopped` even though the engine is
     * still loaded, and an engine with nothing loaded is `idle` whatever
     * the pause flag says.
     */
    fun derive(idleActive: Boolean, eofReached: Boolean, paused: Boolean): String {
        return when {
            idleActive -> IDLE
            eofReached -> STOPPED
            paused -> PAUSED
            else -> PLAYING
        }
    }

    /**
     * Whether [state] means the picture is moving.
     *
     * `stopped` is NOT playing: the file ended and the engine is sitting
     * on its last frame. A play/pause button that shows "play" for an
     * ended file is right, so the state has to be read, not guessed.
     */
    fun isPlaying(state: String?): Boolean {
        return normalise(state).equals(PLAYING, ignoreCase = true)
    }

    /**
     * Whether [state] means something is still loaded.
     *
     * `idle` and `stopped` are the two "no media" answers; `paused` and
     * `playing` both mean a file is loaded.
     */
    fun hasMedia(state: String?): Boolean {
        val value = normalise(state)
        if (value.isEmpty()) return false
        return !value.equals(IDLE, ignoreCase = true) &&
            !value.equals(STOPPED, ignoreCase = true)
    }

    /**
     * A boolean property, read from the JSON the native helper returns.
     *
     * mpv's boolean properties arrive as `true` / `false`; a property
     * that is not set arrives as the JSON literal `null`, which is NOT
     * a boolean and must not be read as `false` by accident — but for
     * these three properties "not set" and "false" mean the same thing,
     * so `null` is false here.
     */
    fun parseBoolean(raw: String?): Boolean {
        return normalise(raw).equals("true", ignoreCase = true)
    }

    /**
     * A property value with its JSON quoting and surrounding space
     * removed, and the JSON literal `null` turned into an empty string.
     */
    private fun normalise(raw: String?): String {
        val value = raw?.trim()?.trim('"')?.trim() ?: return ""
        if (value.equals("null", ignoreCase = true)) return ""
        return value
    }

    // ── The live read ─────────────────────────────────────────────────────

    /**
     * The engine's state RIGHT NOW, read through [PlaybackHost].
     *
     * The pointer is the engine's own handle — the same one every other
     * engine call in this library uses — and it is read at the moment of
     * use, never from a cached flag. A JS flag can be stale by the time
     * the user presses HOME, and the PiP action's icon has to be true
     * even while the app is paused and no JS is running.
     */
    fun live(): String {
        val ptr = PlaybackHost.handle()
        if (ptr == 0L) return IDLE
        return try {
            derive(
                idleActive = parseBoolean(MPVLib.nativeGetProperty(ptr, PROP_IDLE_ACTIVE)),
                eofReached = parseBoolean(MPVLib.nativeGetProperty(ptr, PROP_EOF_REACHED)),
                paused = parseBoolean(MPVLib.nativeGetProperty(ptr, PROP_PAUSE)),
            )
        } catch (e: Throwable) {
            // The native lease guard refuses calls against a destroyed
            // engine; that is a normal outcome, not a crash.
            IDLE
        }
    }

    /**
     * Whether the engine is playing right now.
     */
    fun isPlayingNow(): Boolean = isPlaying(live())

    /**
     * Whether the engine still has a file loaded.
     */
    fun hasMediaNow(): Boolean = hasMedia(live())
}
