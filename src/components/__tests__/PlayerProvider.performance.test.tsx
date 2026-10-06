/**
 * v1.10.0 — performance contract tests for `PlayerProvider`.
 *
 * WHY THIS FILE EXISTS SEPARATELY
 * -------------------------------
 * The pre-1.10.0 suite passed 177/177 while the provider was re-rendering
 * all 12 chrome components once per video frame. Nothing was broken in a way
 * the existing tests could see, because the suite asserts VALUES ("the
 * title is right", "seekable is true") and never asserts HOW OFTEN React
 * was asked to re-render.
 *
 * That is the whole point of these tests: they pin WORK, not values. Each
 * one fails if its fix is reverted.
 *
 * The defect being pinned (see the notes on `playerStateEqual` in
 * PlayerProvider.tsx):
 *   `applyPlayerEvent` returns a freshly-spread object for every event, so
 *   the provider's `nextState !== stateRef.current` guard was comparing a
 *   brand-new object against itself and was therefore ALWAYS true. Every
 *   event produced a setState and a context-value replacement.
 */

import React from 'react';
import { NativeModules } from 'react-native';
import { act, renderHook } from '@testing-library/react-native';
import { PlayerProvider } from '../PlayerProvider';
import { usePlayer } from '../../types/player';

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <PlayerProvider>{children}</PlayerProvider>
);

/**
 * Deliver an event through the SAME emitter production uses.
 *
 * The bridge's `resolveEmitter()` builds a `NativeEventEmitter` over
 * `NativeModules.MpvPlayerModule`, and on the native side the events are
 * published through `RCTDeviceEventEmitter` (documented in
 * MpvPlayerModule.ts: "the events are emitted via RCTDeviceEventEmitter").
 * RN's own jest preset mocks `DeviceEventEmitter`/`RCTDeviceEventEmitter`,
 * and `NativeEventEmitter` delegates to it, so emitting there drives the
 * real subscription the provider registered — not a stub.
 */
function emit(eventName: string, payload: Record<string, unknown>): void {
  const {
    DeviceEventEmitter,
  } = require('react-native') as typeof import('react-native');
  DeviceEventEmitter.emit(eventName, payload);
}

/**
 * Count how many times a `usePlayer()` consumer actually re-rendered.
 *
 * `usePlayer()` reads ONLY `PlayerStateContext` (it does not read progress —
 * that is what `usePlayerProgress()` is for), so this counter measures the
 * STATE channel specifically. That is the channel `onPlaybackStateChanged`
 * writes to, and the channel whose guard was dead code.
 *
 * The probe returns the hook value so the tests can assert on it too.
 */
function createRenderCounter() {
  let renders = 0;
  const probe = () => {
    renders += 1;
    return usePlayer();
  };
  return { probe, count: () => renders };
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. The no-op guard
// ═══════════════════════════════════════════════════════════════════════════

describe('PlayerProvider no-op event guard', () => {
  /**
   * `isPlaying` defaults to `false`, so 'playing' is a REAL change and
   * 'paused' is a no-op from the default baseline. Every test here has to
   * establish a known baseline before it can assert on a no-op — otherwise
   * it silently asserts the wrong thing, which is exactly the failure mode
   * this file exists to prevent.
   */
  it('does NOT re-render state consumers when an event changes no field', async () => {
    // `onPlaybackStateChanged` is handled by a pure spread-and-return in
    // applyPlayerEvent. Before v1.10.0 this produced a new object every
    // time and re-rendered every usePlayer() consumer, even when
    // `isPlaying` was unchanged — and mpv emits this on pause, seek,
    // speed change and file load.
    const { probe, count } = createRenderCounter();
    const { result, unmount } = await renderHook(probe, { wrapper });

    // Baseline: get INTO 'playing' first. This render is expected.
    await act(async () => {
      emit('onPlaybackStateChanged', { state: 'playing' });
    });
    expect(result.current.state.isPlaying).toBe(true);

    const rendersAfterBaseline = count();

    // Now fire five events that change NOTHING.
    await act(async () => {
      emit('onPlaybackStateChanged', { state: 'playing' });
      emit('onPlaybackStateChanged', { state: 'playing' });
      emit('onPlaybackStateChanged', { state: 'playing' });
      emit('onPlaybackStateChanged', { state: 'playing' });
      emit('onPlaybackStateChanged', { state: 'playing' });
    });

    expect(count()).toBe(rendersAfterBaseline);

    await unmount();
  });

  it('DOES re-render when an event changes a field', async () => {
    // The mirror image of the test above, and the reason the guard above is
    // safe: a guard that never fires is a dropped update, which is worse
    // than a wasted render. Flipping isPlaying must still get through.
    const { probe, count } = createRenderCounter();
    const { result, unmount } = await renderHook(probe, { wrapper });

    await act(async () => {
      emit('onPlaybackStateChanged', { state: 'playing' });
    });
    const rendersAfterBaseline = count();

    await act(async () => {
      emit('onPlaybackStateChanged', { state: 'paused' });
    });

    expect(result.current.state.isPlaying).toBe(false);
    expect(count()).toBeGreaterThan(rendersAfterBaseline);

    await unmount();
  });

  it('propagates a field change that only exists on a NESTED value', async () => {
    // The reason the key list is derived from DEFAULT_STATE at runtime
    // rather than hand-written: `error` is a nested object, and a
    // hand-written comparison that forgot it would silently drop errors.
    const { probe, count } = createRenderCounter();
    const { result, unmount } = await renderHook(probe, { wrapper });

    const rendersAfterMount = count();

    await act(async () => {
      emit('onError', {
        code: 3,
        codeName: 'E_NETWORK_FAILURE',
        recoverable: true,
        message: 'boom',
      });
    });

    expect(result.current.state.error).not.toBeNull();
    expect(count()).toBeGreaterThan(rendersAfterMount);

    await unmount();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. The removed position poll
// ═══════════════════════════════════════════════════════════════════════════

describe('PlayerProvider position source', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('does NOT call the synchronous getPosition/getDuration getters on a timer', async () => {
    // v1.10.0 removed the 1Hz poll. Those two getters are SYNC
    // TurboModule methods: React Native's own guidance is to use sync
    // methods only for sub-5ms work and never on a recurring timer,
    // because they block the JS thread for the JNI round-trip.
    //
    // If a poll is reintroduced, this fails — which is the point. A second
    // writer to `positionMs` is how a seek bar ends up jumping backwards.
    const { unmount } = await renderHook(() => usePlayer().state, { wrapper });

    const getPosition = NativeModules.MpvPlayerModule
      .getPosition as jest.Mock;
    const getDuration = NativeModules.MpvPlayerModule
      .getDuration as jest.Mock;
    getPosition.mockClear();
    getDuration.mockClear();

    await act(async () => {
      jest.advanceTimersByTime(5000);
    });

    expect(getPosition).not.toHaveBeenCalled();
    expect(getDuration).not.toHaveBeenCalled();

    await unmount();
  });

  it('still advances position from the event stream alone', async () => {
    // Removing the poll is only safe if the event path carries position
    // end to end. This proves it does — the seek bar does not depend on
    // the poll it no longer has.
    const { result, unmount } = await renderHook(() => usePlayer().state, {
      wrapper,
    });

    await act(async () => {
      emit('onPositionChanged', { position: 42.5 });
    });

    expect(result.current.positionMs).toBe(42500);

    await unmount();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. The observation contract (regression guard for the native coalescing)
// ═══════════════════════════════════════════════════════════════════════════

describe('PlayerProvider observed property contract', () => {
  it('observes the properties whose events carry position and cache state', async () => {
    // The native layer (event.cpp) now COALESCES `time-pos` and
    // `demuxer-cache-state` before forwarding them, precisely because
    // mpv emits them once per frame / on every cache tick. That
    // optimisation is only correct if these names are actually observed —
    // an unregistered name never reaches the coalescer and the field goes
    // dead, which is the same defect class as `mute` in 1.9.1.
    const { unmount } = await renderHook(() => usePlayer(), { wrapper });

    const observed = (
      NativeModules.MpvPlayerModule.observeProperty as jest.Mock
    ).mock.calls.map((call: unknown[]) => call[0]);

    expect(observed).toEqual(
      expect.arrayContaining(['time-pos', 'duration', 'demuxer-cache-state']),
    );

    await unmount();
  });
});