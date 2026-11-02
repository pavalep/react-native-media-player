/**
 * The buffered band must stop churning the progress context.
 *
 * THE DEFECT
 * ----------
 * mpv's `demuxer-cache-state` is a level that ticks continuously. The lib's
 * own device measurement records `onCacheState` reaching JS 827 times over
 * one playback window, and every one of those arrivals published a NEW
 * `cacheRanges` array into the progress context. Every consumer of
 * `usePlayerProgress()` therefore re-rendered, and the buffered band on the
 * scrub bar was redrawn — for a movement of a fraction of a layout unit.
 *
 * THE FIX
 * -------
 * The published ranges are quantised onto the grid the band is drawn at
 * (`durationMs / 1000` per cell), so the number of DISTINCT published
 * values stops being a function of the tick rate.
 *
 * THE PROOF
 * ---------
 * "The numbers are rounded" is not the claim. The claim is that the
 * CONTEXT stopped changing. That is pinned here by:
 *
 *   1. the published `cacheRanges` ARRAY IDENTITY being the SAME object
 *      after two DIFFERENT raw inputs that land in one cell, and
 *   2. the consumer's render count not moving at all across those two
 *      arrivals.
 *
 * Both fail on the unquantised provider: the raw values differ, the
 * provider's equality guard sees a difference, and the context is
 * republished with a fresh array.
 *
 * The MpvPlayerModule bridge mock is installed globally in
 * `jest.setup.ts`; its `getDuration` returns 0, so the hydrated baseline
 * duration is 0 and every value asserted here arrives through the EVENT
 * path.
 */

import React from 'react';
import { act, renderHook } from '@testing-library/react-native';
import { PlayerProvider } from '../PlayerProvider';
import { usePlayerProgress } from '../../types/player';

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <PlayerProvider>{children}</PlayerProvider>
);

/**
 * Deliver an event through the SAME emitter production uses.
 *
 * `DeviceEventEmitter.emit` drives the real subscription the provider
 * registered — the bridge's `resolveEmitter()` builds a
 * `NativeEventEmitter` over `NativeModules.MpvPlayerModule`, and on the
 * native side the events are published through `RCTDeviceEventEmitter`.
 */
function emit(eventName: string, payload: Record<string, unknown>): void {
  const {
    DeviceEventEmitter,
  } = require('react-native') as typeof import('react-native');
  DeviceEventEmitter.emit(eventName, payload);
}

/** The real movie length from the device session: 7673.792 seconds. */
const DURATION_S = 7673.792;
const DURATION_MS = 7673792;
/** One grid cell: `durationMs / 1000`. */
const STEP_MS = DURATION_MS / 1000;

describe('PlayerProvider quantises the buffered ranges it publishes', () => {
  it('publishes the IDENTICAL value for two raw inputs in one cell', async () => {
    let renderCount = 0;
    const { result, unmount } = await renderHook(
      () => {
        renderCount += 1;
        return usePlayerProgress();
      },
      { wrapper },
    );

    await act(async () => {
      emit('onDurationChanged', { duration: DURATION_S });
    });
    await act(async () => {
      emit('onCacheState', { ranges: [{ start: 0, end: 130713.917 }] });
    });

    const publishedRanges = result.current.cacheRanges;
    const publishedProgress = result.current;
    const rendersAfterFirst = renderCount;

    // A DIFFERENT raw value — 1 ms further along the timeline — that
    // lands in the SAME cell.
    await act(async () => {
      emit('onCacheState', { ranges: [{ start: 0, end: 130713.917 + 1 }] });
    });

    // Same ARRAY, not an equal one: the context value never changed, so
    // no consumer was asked to re-read it.
    expect(result.current.cacheRanges).toBe(publishedRanges);
    expect(result.current).toBe(publishedProgress);
    expect(renderCount).toBe(rendersAfterFirst);
    // And the published value is the QUANTISED one, not the raw one.
    expect(result.current.cacheRanges).toEqual([
      { start: 0, end: 130454.464 },
    ]);

    await unmount();
  });

  it('moves the published value when the raw range crosses a cell', async () => {
    // The counterpart of the test above: the fix must not freeze the
    // band. A whole cell of movement has to reach the context.
    let renderCount = 0;
    const { result, unmount } = await renderHook(
      () => {
        renderCount += 1;
        return usePlayerProgress();
      },
      { wrapper },
    );

    await act(async () => {
      emit('onDurationChanged', { duration: DURATION_S });
    });
    await act(async () => {
      emit('onCacheState', { ranges: [{ start: 0, end: 130713.917 }] });
    });

    const publishedRanges = result.current.cacheRanges;
    const rendersAfterFirst = renderCount;

    await act(async () => {
      emit('onCacheState', {
        ranges: [{ start: 0, end: 130713.917 + STEP_MS }],
      });
    });

    expect(result.current.cacheRanges).not.toBe(publishedRanges);
    expect(result.current.cacheRanges).toEqual([
      { start: 0, end: 138128.256 },
    ]);
    expect(renderCount).toBeGreaterThan(rendersAfterFirst);

    await unmount();
  });

  it('publishes a bounded number of states for a burst of native ticks', async () => {
    // The device measurement: `onCacheState` reached JS 827 times over
    // one playback window. Each arrival is flushed on its own here, the
    // way native delivers them (one event per frame), so every one of
    // them WOULD have been a context change before the fix.
    //
    // The buffer grows by 300 ms per tick across 200 ticks — 60 seconds
    // of travel — which is 7 cell boundaries on a 2h08m film.
    let renderCount = 0;
    const { result, unmount } = await renderHook(
      () => {
        renderCount += 1;
        return usePlayerProgress();
      },
      { wrapper },
    );

    await act(async () => {
      emit('onDurationChanged', { duration: DURATION_S });
    });
    const baseline = renderCount;

    for (let i = 1; i <= 200; i++) {
      // eslint-disable-next-line no-await-in-loop
      await act(async () => {
        emit('onCacheState', {
          ranges: [{ start: 0, end: i * 300 }],
        });
      });
    }

    const contextChanges = renderCount - baseline;

    // The buffer travelled 60 s, so it crossed 7 cell boundaries: the
    // context changed 9 times (cells 0..8 plus the first publish), not
    // 200 times. The unquantised provider changes it 200 times — one
    // per arrival — which is the churn this file exists to pin.
    expect(contextChanges).toBeGreaterThan(0);
    expect(contextChanges).toBeLessThanOrEqual(10);
    expect(contextChanges).toBe(9);
    // And the final published value is the quantised one — cell 8 of the
    // 7673.792 ms grid — not the raw 60000.
    expect(result.current.cacheRanges).toEqual([
      { start: 0, end: 61390.336 },
    ]);

    await unmount();
  });

  it('falls back to the fixed grid when the duration is unknown', async () => {
    // A live stream: the duration never arrives, so the grid is an
    // absolute one second of media time.
    const { result, unmount } = await renderHook(() => usePlayerProgress(), {
      wrapper,
    });

    await act(async () => {
      emit('onCacheState', { ranges: [{ start: 0, end: 12345 }] });
    });

    expect(result.current.durationMs).toBe(0);
    expect(result.current.cacheRanges).toEqual([{ start: 0, end: 12000 }]);

    await unmount();
  });
});
