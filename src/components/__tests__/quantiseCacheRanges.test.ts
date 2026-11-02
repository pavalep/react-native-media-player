/**
 * Unit tests for the buffered-range quantiser.
 *
 * THE CONTRACT
 * ------------
 * mpv's `demuxer-cache-state` ticks continuously, and every tick used to
 * publish a new `cacheRanges` array into the progress context. The band
 * that array paints is drawn on a ~300 dp scrub bar, so a boundary that
 * moves by ~1/1000 of the timeline is at the rounding level of the
 * painted rect. The quantiser snaps every boundary onto that grid, so the
 * number of DISTINCT published values is bounded by the grid and not by
 * the tick rate.
 *
 * These tests pin:
 *   - the exact arithmetic (which cell a boundary lands in, and what is
 *     published for it),
 *   - that two raw inputs inside ONE cell publish the SAME number (this
 *     is what makes the context stop changing),
 *   - that a boundary that CROSSES a cell still moves (the quantiser is
 *     not "never publish"),
 *   - the degenerate cases: unknown duration, empty list, a range past
 *     the duration, an inverted range, a non-finite bound,
 *   - the bound itself: at most `CACHE_RANGE_GRID_DIVISOR + 1` distinct
 *     published values for ANY media length.
 *
 * The provider-level proof that the CONTEXT stopped changing lives in
 * `PlayerProvider.cacheStateQuantisation.test.tsx`.
 */

import {
  CACHE_RANGE_GRID_DIVISOR,
  quantiseCacheRanges,
  UNKNOWN_DURATION_GRID_MS,
} from '../quantiseCacheRanges';

/** The real movie length from the device session: 7673.792 seconds. */
const DURATION_MS = 7673792;
/** One grid cell: `durationMs / 1000`. */
const STEP_MS = DURATION_MS / CACHE_RANGE_GRID_DIVISOR;

describe('quantiseCacheRanges', () => {
  it('snaps a boundary onto the duration grid', () => {
    const out = quantiseCacheRanges(
      [{ start: 0, end: 130713.917 }],
      DURATION_MS,
    );

    // 130713.917 / 7673.792 = 17.03… -> cell 17 -> 17 * 7673.792.
    expect(out).toEqual([{ start: 0, end: 130454.464 }]);
    expect(out[0].end).toBe(17 * STEP_MS);
  });

  it('publishes the SAME number for two raw inputs inside one cell', () => {
    // This is the property the whole fix rests on: the provider compares
    // the published values, so two raw inputs in one cell must produce
    // one value, not two.
    const a = quantiseCacheRanges(
      [{ start: 0, end: 130713.917 }],
      DURATION_MS,
    );
    const b = quantiseCacheRanges(
      [{ start: 0, end: 130713.917 + 1 }],
      DURATION_MS,
    );

    expect(b).toEqual(a);
    expect(b[0].end).toBe(a[0].end);
    expect(b[0].start).toBe(a[0].start);
  });

  it('moves the boundary when the raw value crosses a cell', () => {
    // The counterpart of the test above: the quantiser must not freeze
    // the band. One whole cell of movement has to show up.
    const a = quantiseCacheRanges(
      [{ start: 0, end: 130713.917 }],
      DURATION_MS,
    );
    const b = quantiseCacheRanges(
      [{ start: 0, end: 130713.917 + STEP_MS }],
      DURATION_MS,
    );

    expect(b[0].end).not.toBe(a[0].end);
    expect(b[0].end).toBe(18 * STEP_MS);
  });

  it('clamps a range that extends beyond the duration', () => {
    const out = quantiseCacheRanges(
      [{ start: 0, end: DURATION_MS * 2 }],
      DURATION_MS,
    );

    expect(out).toEqual([{ start: 0, end: DURATION_MS }]);
  });

  it('clamps a negative boundary to zero', () => {
    const out = quantiseCacheRanges(
      [{ start: -500, end: 1000 }],
      DURATION_MS,
    );

    expect(out[0].start).toBe(0);
  });

  it('never publishes a boundary outside [0, durationMs]', () => {
    const raws = [
      -1, 0, 1, STEP_MS, DURATION_MS / 2, DURATION_MS - 1, DURATION_MS,
      DURATION_MS * 3,
    ];

    for (const raw of raws) {
      const out = quantiseCacheRanges([{ start: raw, end: raw }], DURATION_MS);
      expect(out[0].start).toBeGreaterThanOrEqual(0);
      expect(out[0].end).toBeLessThanOrEqual(DURATION_MS);
    }
  });

  it('uses the fixed fallback grid when the duration is unknown', () => {
    // A live stream: there is no duration to be relative to, so the grid
    // is an absolute one second of media time.
    const out = quantiseCacheRanges([{ start: 0, end: 12345 }], 0);

    expect(out).toEqual([{ start: 0, end: 12 * UNKNOWN_DURATION_GRID_MS }]);
    // The literal, so the assertion does not move with the constant.
    expect(out[0].end).toBe(12000);
  });

  it('uses the fixed fallback grid when the duration is negative', () => {
    const out = quantiseCacheRanges([{ start: 0, end: 12345 }], -1);

    expect(out).toEqual([{ start: 0, end: 12 * UNKNOWN_DURATION_GRID_MS }]);
  });

  it('keeps an empty range list empty', () => {
    expect(quantiseCacheRanges([], DURATION_MS)).toEqual([]);
  });

  it('collapses an inverted range to zero length instead of dropping it', () => {
    // Dropping it would change the range COUNT, and a count that flickers
    // is exactly the churn this module exists to remove.
    const out = quantiseCacheRanges([{ start: 5000, end: 1000 }], DURATION_MS);

    expect(out).toHaveLength(1);
    expect(out[0].start).toBe(out[0].end);
  });

  it('drops a range whose bounds are not finite numbers', () => {
    const out = quantiseCacheRanges(
      [
        { start: 0, end: Number.NaN },
        { start: Number.POSITIVE_INFINITY, end: 100 },
        { start: 0, end: 130713.917 },
      ],
      DURATION_MS,
    );

    expect(out).toHaveLength(1);
    expect(out[0].end).toBe(130454.464);
  });

  it('publishes a clean number, not the float dust of the multiplication', () => {
    // 61096 ms of media: cell 3 is `3 * 61.096`, which IEEE-754
    // evaluates as 183.28799999999998. The published value is rounded to
    // the microsecond, so the consumer never sees the dust.
    //
    // (The LAST cell is not a witness: the upper clamp would hide the
    // dust there, because the clamp returns the duration itself.)
    const durationMs = 61096;
    const out = quantiseCacheRanges(
      [{ start: 0, end: 183.288 }],
      durationMs,
    );

    expect(out[0].end).toBe(183.288);
  });

  it('is idempotent', () => {
    // Quantising an already-quantised value must change nothing: the
    // provider can be handed a value that has been through this module
    // already, and a second pass must not walk it up the grid.
    const once = quantiseCacheRanges(
      [{ start: 0, end: 130713.917 }],
      DURATION_MS,
    );
    const twice = quantiseCacheRanges(once, DURATION_MS);

    expect(twice).toEqual(once);
  });

  it('does not mutate the input', () => {
    const input = [{ start: 0, end: 130713.917 }];
    const before = JSON.stringify(input);

    quantiseCacheRanges(input, DURATION_MS);

    expect(JSON.stringify(input)).toBe(before);
  });

  it('bounds the distinct published values by the grid, for ANY media length', () => {
    // 5000 raw boundaries spread over the whole timeline, for a 2-hour
    // film AND for a 3-minute clip. The bound is the grid, not the media
    // length: that is the whole reason the grid is duration-relative.
    for (const durationMs of [DURATION_MS, 180000]) {
      const seen = new Set<number>();
      for (let i = 0; i < 5000; i++) {
        const raw = (i / 5000) * durationMs;
        const out = quantiseCacheRanges([{ start: 0, end: raw }], durationMs);
        seen.add(out[0].end);
      }
      expect(seen.size).toBeLessThanOrEqual(CACHE_RANGE_GRID_DIVISOR + 1);
    }
  });

  it('never publishes a smaller value for a larger raw boundary', () => {
    let previous = -1;
    for (let i = 0; i < 1000; i++) {
      const raw = (i / 1000) * DURATION_MS;
      const out = quantiseCacheRanges([{ start: 0, end: raw }], DURATION_MS);
      expect(out[0].end).toBeGreaterThanOrEqual(previous);
      previous = out[0].end;
    }
  });
});
