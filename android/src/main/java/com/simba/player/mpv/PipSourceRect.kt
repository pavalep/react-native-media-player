package com.simba.player.mpv

/**
 * A rectangle in **window** coordinates.
 *
 * `left` / `top` are the rect's origin in window space; `right` / `bottom`
 * are its far edge, which is the exclusive convention `android.graphics.Rect`
 * uses, so the conversion is a straight copy with no off-by-one to argue about.
 *
 * ## Why this exists
 *
 * Android's `setSourceRectHint` wants the region of the window where the
 * video actually is, so PiP entry animates the real frame into the PiP
 * window instead of growing out of a black rectangle.
 *
 * That region is **not** the picture view's box. The app's picture fills its
 * lane (`StyleSheet.absoluteFill`), so the view's rect is the whole window,
 * and handing the view's box to the system would tell it to make the PiP
 * window the shape of the window — portrait on a phone — with the video
 * arriving tiny and letterboxed inside it.
 *
 * So the rect has to be the video's FRAME inside the view: the largest rect
 * of the video's own shape that fits inside the view (letterbox / pillarbox
 * bars around it), or the whole view when the picture is filling it.
 *
 * ## Why the arithmetic is pure
 *
 * There is no Android framework type in this file's arithmetic on purpose.
 * The module's Robolectric tests are `@Ignore`d because they cannot run
 * offline, so a decision that lived behind an Android type would ship
 * untested. Keeping the decision here means the unit test is plain JUnit and
 * actually EXECUTES.
 *
 * The Android-side half — where the picture view is and how big it is — lives
 * in `MpvRenderView`; the question "what rect of that view does the video
 * occupy" lives here. One owner per fact.
 */
data class PictureFrame(val left: Int, val top: Int, val right: Int, val bottom: Int) {

    /** The rect's width. Never negative for a frame this module builds. */
    val width: Int get() = right - left

    /** The rect's height. Never negative for a frame this module builds. */
    val height: Int get() = bottom - top

    /**
     * The rect's shape, as width / height.
     *
     * `0` when the rect has no height — the honest answer for a degenerate
     * rect, and the reason callers must not divide by this themselves.
     */
    val aspect: Float get() = if (height > 0) width.toFloat() / height.toFloat() else 0f
}

/**
 * The PiP source-rect arithmetic.
 *
 * ## What this decides
 *
 * Given the picture view's rect in window coordinates, the video's own aspect
 * ratio, and whether the picture FILLS its view, answer: **which rect of the
 * window is the video?**
 *
 * ## The one fact it asks for
 *
 * `fillsView` is the one fact this arithmetic needs, and it is a fact about
 * the VISIBLE REGION rather than about the engine's internals:
 *
 *  - **Fills the view** (`cover`, `stretch`) — the picture covers every pixel
 *    of the view it is drawn in, so the region of the window the video
 *    occupies IS the view. The frame IS the view rect, and there is no
 *    letterbox / pillarbox inset to subtract.
 *  - **Fits inside the view** (`contain`) — the picture is the largest rect
 *    of the video's own shape that FITS INSIDE the view, centred. Bars sit
 *    above/below (wider video) or left/right (narrower video).
 *
 * The two filling modes answer the same rect, and that is not a
 * coincidence: a picture that fills the view covers every pixel of it, so
 * the region of the window the video occupies IS the view — whatever the
 * engine does with the shape behind it.
 *
 * The fact comes from `MpvRenderView.currentFillsView`, which publishes what
 * the engine is ACTUALLY rendering with. It is NOT the zoom: mpv's
 * `video-zoom` is a log2 scale factor, and a magnified picture still covers
 * every pixel of the view it is drawn in.
 *
 * ## Why the guards return `null`
 *
 * A source rect that describes nothing is worse than no source rect at all:
 * the system would animate the PiP window out of a region that does not
 * contain the video. `null` degrades to the platform's no-hint behaviour,
 * which costs a black transition but never a distorted one.
 */
object PipSourceRect {

    /**
     * The window rect the video occupies, or `null` when there is no such
     * rect to point at.
     *
     * @param viewLeft    The picture view's left edge, in window coordinates.
     * @param viewTop     The picture view's top edge, in window coordinates.
     * @param viewWidth   The picture view's width, in pixels.
     * @param viewHeight  The picture view's height, in pixels.
     * @param videoAspect The video's own width / height.
     * @param fillsView   Whether the picture FILLS the view (`cover`,
     *                    `stretch`) or FITS inside it (`contain`).
     */
    fun frameInWindow(
        viewLeft: Int,
        viewTop: Int,
        viewWidth: Int,
        viewHeight: Int,
        videoAspect: Float,
        fillsView: Boolean,
    ): PictureFrame? {
        // A view with no area has no video in it.
        if (viewWidth <= 0 || viewHeight <= 0) return null

        // NaN and infinity are not shapes. `NaN <= 0f` is false, so the
        // finiteness check has to come first or a NaN aspect would sail
        // through into the arithmetic below.
        if (!videoAspect.isFinite() || videoAspect <= 0f) return null

        return if (fillsView) {
            // The picture covers the whole view, so the visible picture IS
            // the view's rect.
            PictureFrame(
                viewLeft,
                viewTop,
                viewLeft + viewWidth,
                viewTop + viewHeight,
            )
        } else {
            // The picture is fitted inside the view, so the frame is the
            // video's own shape, centred in it.
            fitFrame(viewLeft, viewTop, viewWidth, viewHeight, videoAspect)
        }
    }

    /**
     * The largest rect of the video's shape that fits inside the view,
     * centred in it.
     *
     * Two cases, and they are not interchangeable:
     *
     *  - The video is WIDER than the view → the frame is the view's full
     *    width and a proportionally shorter height, centred vertically.
     *    Letterbox bars above and below.
     *  - The video is NARROWER than the view → the frame is the view's full
     *    height and a proportionally narrower width, centred horizontally.
     *    Pillarbox bars left and right.
     */
    private fun fitFrame(
        viewLeft: Int,
        viewTop: Int,
        viewWidth: Int,
        viewHeight: Int,
        videoAspect: Float,
    ): PictureFrame? {
        val viewAspect = viewWidth.toFloat() / viewHeight.toFloat()

        val fittedWidth: Int
        val fittedHeight: Int
        if (videoAspect > viewAspect) {
            fittedWidth = viewWidth
            fittedHeight = Math.round(viewWidth / videoAspect)
        } else {
            fittedHeight = viewHeight
            fittedWidth = Math.round(viewHeight * videoAspect)
        }

        // A fit that rounds away to nothing has no rect to point at.
        if (fittedWidth <= 0 || fittedHeight <= 0) return null

        // Float rounding can push the fitted edge a pixel past the view's
        // edge. The frame has to stay INSIDE the picture, or the hint would
        // describe a region that is not on screen.
        val width = fittedWidth.coerceAtMost(viewWidth)
        val height = fittedHeight.coerceAtMost(viewHeight)
        if (width <= 0 || height <= 0) return null

        // Integer division centres the frame: the odd leftover pixel stays
        // on the far side, which is the same choice the platform's own
        // letterboxing makes and one pixel nobody can see.
        val left = viewLeft + (viewWidth - width) / 2
        val top = viewTop + (viewHeight - height) / 2
        return PictureFrame(left, top, left + width, top + height)
    }
}
