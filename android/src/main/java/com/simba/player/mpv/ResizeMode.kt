package com.simba.player.mpv

/**
 * The resize modes, and the mpv properties each one means.
 *
 * ## Why this file exists
 *
 * `<SimbaVideo resizeMode="cover" />` used to be translated into mpv's
 * `video-zoom` in **JavaScript** — `cover` became `"1"`, `stretch` became
 * `"2"` — and the native side wrote that straight into the engine.
 *
 * mpv's `video-zoom` is not a fit / fill / stretch enum. From mpv's own
 * manual (`--video-zoom`):
 *
 * > Adjust the video display scale factor by the given value. The parameter is
 * > given log 2. For example, `--video-zoom=0` is unscaled, `--video-zoom=1` is
 * > twice the size, `--video-zoom=-2` is one fourth of the size, and so on.
 *
 * So `cover` rendered as a **2x magnified**, cropped picture and `stretch` as
 * a **4x magnified** one. Neither was what its name said, and the aspect was
 * never ignored. The app asks for `cover` on its mini-player dock, so the
 * dock was a hugely zoomed picture.
 *
 * The three modes are three DIFFERENT combinations of mpv's own properties,
 * not three values of one property:
 *
 * | mode     | `video-zoom` | `keepaspect` | `panscan` |
 * |----------|--------------|---------------|-----------|
 * | contain  | `"0"`        | `"yes"`       | `"0"`     |
 * | cover    | `"0"`        | `"yes"`       | `"1.0"`   |
 * | stretch  | `"0"`        | `"no"`        | `"0"`     |
 *
 *  - **`contain`** — `video-zoom=0` (unscaled) + `keepaspect=yes` (mpv's
 *    default) + `panscan=0`. The picture keeps its own aspect and is
 *    letterboxed / pillarboxed into the view.
 *  - **`cover`** — `video-zoom=0` + `keepaspect=yes` + `panscan=1.0`. mpv's
 *    manual (`--panscan`): "The difference between `--panscan` and
 *    `--video-zoom` is that `--panscan` can only zoom in until either the
 *    video width or height fills the window". So `panscan=1.0` crops the
 *    overflow away and the picture FILLS the view, aspect preserved.
 *  - **`stretch`** — `video-zoom=0` + `keepaspect=no`. mpv's manual
 *    (`--keepaspect`): "`--keepaspect=no` will always stretch the video to
 *    window size". The picture FILLS the view and its aspect is ignored.
 *
 * ## Why the properties are all written, every time
 *
 * mpv's properties **persist**. Switching from `cover` back to `contain` has
 * to put `panscan` back to `0`, and switching from `stretch` back to
 * `contain` has to put `keepaspect` back to `yes`. Writing only the
 * properties the new mode "uses" would leave the previous mode's property in
 * place, so every mode writes all three.
 *
 * ## Why this file is pure
 *
 * There is no Android framework type and no React Native type in here, on
 * purpose. The module's Robolectric suites are `@Ignore`d because they cannot
 * run offline, so a decision that lived behind an Android type would ship
 * untested. Keeping the mapping here means the unit test is plain JUnit and
 * actually EXECUTES.
 *
 * The native-side half — when to write the properties, and to which handle —
 * lives in `MpvRenderView`. The question "what does this mode mean?" lives
 * here. One owner per fact.
 */
object ResizeMode {

    // ── The mode names ────────────────────────────────────────────────────

    /** Fit the picture inside the view, letterboxed / pillarboxed. */
    const val CONTAIN = "contain"

    /** Fill the view, cropping the overflow, aspect preserved. */
    const val COVER = "cover"

    /** Fill the view, aspect ignored. */
    const val STRETCH = "stretch"

    // ── The mpv property names ────────────────────────────────────────────

    /** mpv's scale factor. A log2 multiplier, NOT a fit / fill enum. */
    const val PROP_VIDEO_ZOOM = "video-zoom"

    /** mpv's "keep the video's own aspect" switch. */
    const val PROP_KEEP_ASPECT = "keepaspect"

    /** mpv's pan-and-scan range: how much of the image is cropped away. */
    const val PROP_PANSCAN = "panscan"

    // ── The mpv property values ───────────────────────────────────────────

    /** `video-zoom=0` — unscaled (mpv's manual: "`--video-zoom=0` is unscaled"). */
    const val ZOOM_UNSCALED = "0"

    /** `keepaspect=yes` — the video keeps its own aspect. */
    const val KEEP_ASPECT_YES = "yes"

    /** `keepaspect=no` — the video is stretched to the window size. */
    const val KEEP_ASPECT_NO = "no"

    /** `panscan=0` — nothing is cropped away. */
    const val PANSCAN_NONE = "0"

    /** `panscan=1.0` — crop until the picture fills the window. */
    const val PANSCAN_CROP = "1.0"

    /**
     * The mpv properties one mode means, plus the one fact about the mode
     * that the PiP code needs.
     *
     * @param mode      The mode's canonical name.
     * @param videoZoom The `video-zoom` value.
     * @param keepAspect The `keepaspect` value.
     * @param panScan   The `panscan` value.
     * @param fillsView Whether the picture FILLS its view — no
     *                  letterbox / pillarbox inset — or FITS inside it.
     */
    data class MpvSettings(
        val mode: String,
        val videoZoom: String,
        val keepAspect: String,
        val panScan: String,
        val fillsView: Boolean,
    )

    /** `contain`: fitted inside the view, bars around it. */
    val CONTAIN_SETTINGS = MpvSettings(
        mode = CONTAIN,
        videoZoom = ZOOM_UNSCALED,
        keepAspect = KEEP_ASPECT_YES,
        panScan = PANSCAN_NONE,
        fillsView = false,
    )

    /** `cover`: fills the view, the overflow is cropped away. */
    val COVER_SETTINGS = MpvSettings(
        mode = COVER,
        videoZoom = ZOOM_UNSCALED,
        keepAspect = KEEP_ASPECT_YES,
        panScan = PANSCAN_CROP,
        fillsView = true,
    )

    /** `stretch`: fills the view, the aspect is ignored. */
    val STRETCH_SETTINGS = MpvSettings(
        mode = STRETCH,
        videoZoom = ZOOM_UNSCALED,
        keepAspect = KEEP_ASPECT_NO,
        panScan = PANSCAN_NONE,
        fillsView = true,
    )

    /**
     * The mpv settings a mode means.
     *
     * An unrecognised mode — a blank string, a name this build does not know
     * — is treated as `contain`. `contain` is the app's default `resizeMode`,
     * so it is the mode the picture is actually rendering with in the common
     * case, and it is the mode that keeps the picture's shape equal to the
     * video's shape. A wrong-but-valid fit is recoverable; a mode the engine
     * cannot honour is not.
     *
     * The name is trimmed and lower-cased first, so a mode that arrives with
     * stray whitespace or in a different case still resolves.
     */
    fun settingsFor(mode: String?): MpvSettings =
        when (mode?.trim()?.lowercase()) {
            COVER -> COVER_SETTINGS
            STRETCH -> STRETCH_SETTINGS
            else -> CONTAIN_SETTINGS
        }

    /**
     * Whether the mode's picture FILLS its view.
     *
     * `cover` and `stretch` fill it — the picture's frame IS the view's rect,
     * with no letterbox / pillarbox inset. `contain` fits inside it, so the
     * inset applies.
     */
    fun fillsView(mode: String?): Boolean = settingsFor(mode).fillsView
}
