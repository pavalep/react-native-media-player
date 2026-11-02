/**
 * Quantise the buffered ("cache") ranges to the resolution the scrub bar
 * can actually draw.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * mpv's `demuxer-cache-state` is a LEVEL that changes on every cache tick.
 * The lib's own device measurement (recorded in `PlayerProvider.tsx`) counts
 * `onCacheState` reaching JS 827 times over one playback window. Every one
 * of those arrivals used to publish a NEW `cacheRanges` array into the
 * progress context, so every consumer of `usePlayerProgress()` re-rendered
 * and the buffered band on the scrub bar was redrawn — for a movement of a
 * fraction of a layout unit.
 *
 * The band is drawn on a track the consumer measures with `onLayout` and
 * maps with `(ms / durationMs) * trackWidth`. On a ~300 dp track, one dp is
 * `durationMs / 300` of the timeline.
 *
 * ── THE RULE ───────────────────────────────────────────────────────────────
 * Cut the timeline into `CACHE_RANGE_GRID_DIVISOR` (1000) equal cells and
 * snap every range boundary to the nearest cell boundary:
 *
 *     step  = durationMs / 1000
 *     index = round(ms / step)        -> an integer in [0, 1000]
 *     value = index * step            -> milliseconds again
 *
 * Two consequences, and they are the whole point of the exercise:
 *
 *   1. The number of DISTINCT published values for a boundary is bounded by
 *      1001 for ANY media length. The grid is relative to the DURATION, not
 *      to the media length in seconds, so a 3-minute clip and a 3-hour film
 *      get the same bound.
 *   2. The band moves in steps of `durationMs / 1000` of the timeline —
 *      ~0.3 dp on a ~300 dp track. That is a third of a layout unit, so
 *      the movement is at the rounding level of the painted rect (at most
 *      one physical pixel on a 3x display), and not a visible slide.
 *
 * The number of published states therefore stops being a function of how
 * often mpv ticks and becomes a function of how far the buffer actually
 * travels: a buffer that grows by 30 seconds on a 2-hour film crosses ~4
 * cells, no matter how many ticks mpv emitted to say so.
 *
 * ── THE DEGENERATE CASES ───────────────────────────────────────────────────
 *   - `durationMs <= 0` (unknown duration — a live stream): the grid cannot
 *     be computed from the duration, so this falls back to a FIXED grid of
 *     `UNKNOWN_DURATION_GRID_MS` (1000 ms). The trade-off is explicit: an
 *     absolute grid cannot bound the number of distinct values over an
 *     unbounded live timeline, but it does bound the RATE — at most one
 *     published change per second of media time instead of one per native
 *     tick. A duration-relative grid here would be a fiction: there is no
 *     duration to be relative to.
 *   - an empty range list stays empty.
 *   - a range that extends beyond the duration is clamped to it, so a
 *     boundary can never leave `[0, durationMs]` and the "at most 1001
 *     distinct values" bound stays true.
 *   - a range that is inverted (`end < start`) collapses to zero length
 *     instead of being DROPPED: dropping it would change the range COUNT,
 *     and a count that flickers on and off is exactly the churn this module
 *     exists to remove. A zero-length range is not painted anyway — the
 *     consumer drops those too.
 *   - a range whose bounds are not finite numbers is dropped: that is a
 *     data error, not a position, and it cannot be painted.
 *
 * ── ONE OWNER ──────────────────────────────────────────────────────────────
 * This module is the ONLY place the rule lives. The provider calls it on
 * the publish path; nothing else re-implements the arithmetic.
 */

/** A buffered span, in milliseconds from the start of the stream. */
export interface CacheRange {
  /** Start of the buffered span, in milliseconds. */
  start: number;
  /** End of the buffered span, in milliseconds. */
  end: number;
}

/**
 * How many cells the timeline is cut into. One cell is `durationMs / 1000`
 * of the timeline, which is the resolution the buffered band is drawn at.
 */
export const CACHE_RANGE_GRID_DIVISOR = 1000;

/**
 * The fallback grid, in milliseconds, used when the duration is unknown.
 *
 * A live stream has no duration, so there is no duration-relative grid to
 * compute. One second of media time is far below the resolution of any
 * scrub bar, and it bounds the publish rate to one change per second of
 * media time instead of one change per native tick.
 */
export const UNKNOWN_DURATION_GRID_MS = 1000;

/**
 * Clamp `value` into `[lo, hi]`. `hi` may be `Infinity`.
 *
 * The lower bound is inclusive (`<=`), which also normalises `-0` to `0`:
 * a boundary snapped onto cell 0 must publish `0`, not `-0`, because
 * `Object.is(-0, 0)` is false and the provider's equality guard compares
 * with `===`.
 */
function clamp(value: number, lo: number, hi: number): number {
  if (value <= lo) return lo;
  if (value > hi) return hi;
  return value;
}

/**
 * Snap one boundary, in milliseconds, onto the grid.
 *
 * `step` is the cell size; `upperBound` is the largest value the boundary
 * may take (the duration, or `Infinity` when the duration is unknown).
 *
 * THIS is the one place the boundary is clamped: a boundary can never
 * leave `[0, durationMs]`, so the number of distinct published values is
 * bounded by the number of cells and not by what mpv reported.
 *
 * The snapped value is rounded to the microsecond so the published number
 * is a clean value (`130454.464`) instead of the float dust an exact
 * `index * step` leaves behind (`130454.46399999999`). The rounding is a
 * pure function of the snapped value, so two raw inputs that land on the
 * same cell still produce the SAME published number.
 */
function snapToGrid(ms: number, step: number, upperBound: number): number {
  const index = Math.round(ms / step);
  const snapped = index * step;
  const rounded = Math.round(snapped * 1000) / 1000;
  return clamp(rounded, 0, upperBound);
}

/**
 * Quantise buffered ranges onto the grid the scrub bar is drawn at.
 *
 * @param ranges   The raw ranges, in milliseconds, as they arrived from
 *                 mpv's `demuxer-cache-state`.
 * @param durationMs The media duration in milliseconds. `0` (or less)
 *                 means "unknown" and selects the fixed fallback grid.
 * @returns A NEW array of quantised ranges, in milliseconds. The input is
 *          never mutated.
 */
export function quantiseCacheRanges(
  ranges: ReadonlyArray<CacheRange>,
  durationMs: number,
): Array<CacheRange> {
  if (!Array.isArray(ranges) || ranges.length === 0) {
    return [];
  }

  const knownDuration =
    typeof durationMs === 'number' &&
    Number.isFinite(durationMs) &&
    durationMs > 0;
  const step = knownDuration
    ? durationMs / CACHE_RANGE_GRID_DIVISOR
    : UNKNOWN_DURATION_GRID_MS;
  const upperBound = knownDuration ? durationMs : Number.POSITIVE_INFINITY;

  const out: Array<CacheRange> = [];
  for (const range of ranges) {
    const start = range?.start;
    const end = range?.end;
    if (typeof start !== 'number' || typeof end !== 'number') continue;
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;

    // An inverted range cannot be painted. Collapse it to zero length
    // instead of dropping it, so the range COUNT cannot flicker: a count
    // that flips on and off is exactly the churn this module exists to
    // remove. Both boundaries then snap to the same cell.
    const safeEnd = end < start ? start : end;

    out.push({
      start: snapToGrid(start, step, upperBound),
      end: snapToGrid(safeEnd, step, upperBound),
    });
  }
  return out;
}
