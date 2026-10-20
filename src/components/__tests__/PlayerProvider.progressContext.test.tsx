/**
 * Regression tests: the PROGRESS context must not lose a field that the
 * STATE context already holds.
 *
 * THE DEFECT (found on device, emulator-5554, 2026-10-20, lib 1.17.0):
 *
 * mpv delivers `duration` and `time-pos` inside ONE batch, ~3 ms apart
 * (measured: `fileLoaded` 19:29:59.615, `time-pos` 19:29:59.616,
 * `duration` 19:29:59.619). The provider handled each event with
 * `applyPlayerEvent(stateRef.current, progressRef.current, ...)` and then
 * wrote the two refs:
 *
 *   - `stateRef.current` was written SYNCHRONOUSLY, in the event handler.
 *   - `progressRef.current` was written INSIDE the `setProgress` updater,
 *     which React DEFERS to the render phase.
 *
 * So the progress ref was one flush behind the state ref. The second event
 * of the batch therefore computed its `nextProgress` from a STALE progress
 * — one that did not yet contain the duration the first event had just
 * delivered — and overwrote it with 0.
 *
 * MEASURED on device:
 *
 *   state.durationMs    = 7673792   (correct)
 *   progress.durationMs = 0         (WRONG)
 *
 * The visible damage was a seek bar with no played fill, NO buffered range
 * at all (the consumer gates the buffered window on `durationMs > 0`), and
 * "--:--" for the remaining time — on a video that was demonstrably
 * playing.
 *
 * These tests pin the fix: the progress ref is written synchronously, in
 * lockstep with the state ref.
 *
 * Test surface:
 *  - duration survives in the progress context when duration and position
 *    arrive in one batch (the exact device order)
 *  - duration survives when the order is reversed
 *  - duration survives across a longer run of interleaved events
 *  - the buffered ranges survive the same interleaving
 *  - the two contexts agree on the duration — the invariant the seek bar
 *    depends on
 *
 * The MpvPlayerModule bridge mock is installed globally in
 * `jest.setup.ts`; its `getDuration` returns 0, so the hydrated baseline
 * duration is 0 and every value asserted here arrives through the EVENT
 * path. A test that passed on the hydrated baseline would prove nothing.
 */

import React from 'react';
import { act, renderHook } from '@testing-library/react-native';
import { PlayerProvider } from '../PlayerProvider';
import { usePlayer, usePlayerProgress } from '../../types/player';

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <PlayerProvider>{children}</PlayerProvider>
);

/**
 * Deliver an event through the SAME emitter production uses.
 *
 * The bridge's `resolveEmitter()` builds a `NativeEventEmitter` over
 * `NativeModules.MpvPlayerModule`, and on the native side the events are
 * published through `RCTDeviceEventEmitter`. RN's own jest preset mocks
 * `DeviceEventEmitter`, and `NativeEventEmitter` delegates to it, so
 * emitting there drives the real subscription the provider registered.
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

describe('PlayerProvider progress context keeps the duration', () => {
  it('keeps the duration when duration and position arrive in ONE batch', async () => {
    // The exact device scenario: two events, one batch, duration FIRST.
    const { result, unmount } = await renderHook(
      () => ({ state: usePlayer().state, progress: usePlayerProgress() }),
      { wrapper },
    );

    // The hydrated baseline is 0 (the bridge mock's getDuration returns 0),
    // so anything asserted below arrived through the event path.
    expect(result.current.state.durationMs).toBe(0);
    expect(result.current.progress.durationMs).toBe(0);

    await act(async () => {
      emit('onDurationChanged', { duration: DURATION_S });
      emit('onPositionChanged', { position: 12.5 });
    });

    expect(result.current.state.durationMs).toBe(DURATION_MS);
    // THE assertion this file exists for. Before the fix this was 0:
    // the position event was computed from a stale progress and replaced
    // the duration with the stale 0.
    expect(result.current.progress.durationMs).toBe(DURATION_MS);
    // The position must not be the casualty of the fix.
    expect(result.current.progress.positionMs).toBe(12500);

    await unmount();
  });

  it('keeps the duration when the position arrives FIRST in the batch', async () => {
    // The mirror order. A fix that only special-cased "duration first"
    // would pass the test above and fail this one.
    const { result, unmount } = await renderHook(
      () => ({ state: usePlayer().state, progress: usePlayerProgress() }),
      { wrapper },
    );

    await act(async () => {
      emit('onPositionChanged', { position: 12.5 });
      emit('onDurationChanged', { duration: DURATION_S });
    });

    expect(result.current.progress.durationMs).toBe(DURATION_MS);
    expect(result.current.progress.positionMs).toBe(12500);

    await unmount();
  });

  it('keeps the duration across a long run of interleaved events', async () => {
    // The real event stream is not two events: mpv keeps sending
    // `time-pos` for the whole session. Every one of them used to carry a
    // stale duration into the progress context.
    const { result, unmount } = await renderHook(
      () => ({ state: usePlayer().state, progress: usePlayerProgress() }),
      { wrapper },
    );

    await act(async () => {
      emit('onDurationChanged', { duration: DURATION_S });
      for (let i = 1; i <= 25; i++) {
        emit('onPositionChanged', { position: i * 0.5 });
      }
    });

    expect(result.current.progress.durationMs).toBe(DURATION_MS);
    expect(result.current.progress.positionMs).toBe(12500);

    await unmount();
  });

  it('keeps the buffered ranges through the same interleaving', async () => {
    // The buffered ranges are the other half of the damage: the consumer
    // gates the buffered window on `durationMs > 0`, so a lost duration
    // silently removed the buffered indicator from the seek bar.
    const { result, unmount } = await renderHook(
      () => ({ state: usePlayer().state, progress: usePlayerProgress() }),
      { wrapper },
    );

    await act(async () => {
      emit('onDurationChanged', { duration: DURATION_S });
      emit('onCacheState', { ranges: [{ start: 0, end: 130713.917 }] });
      emit('onPositionChanged', { position: 12.5 });
    });

    expect(result.current.progress.durationMs).toBe(DURATION_MS);
    expect(result.current.progress.cacheRanges).toEqual([
      { start: 0, end: 130713.917 },
    ]);

    await unmount();
  });

  it('keeps the state context and the progress context in agreement', async () => {
    // The invariant the seek bar depends on: it reads the duration from
    // the progress context and the play state from the state context, so
    // the two must never disagree about the length of the file.
    const { result, unmount } = await renderHook(
      () => ({ state: usePlayer().state, progress: usePlayerProgress() }),
      { wrapper },
    );

    await act(async () => {
      emit('onDurationChanged', { duration: DURATION_S });
      emit('onPositionChanged', { position: 12.5 });
      emit('onCacheState', { ranges: [{ start: 0, end: 130713.917 }] });
    });

    expect(result.current.progress.durationMs).toBe(
      result.current.state.durationMs,
    );
    expect(result.current.progress.durationMs).toBe(DURATION_MS);

    await unmount();
  });
});
