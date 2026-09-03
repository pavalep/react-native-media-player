/**
 * Unit tests for `src/types/player.ts` — the player state/commands API.
 *
 * Spec §Phase 34:
 *  - 34.2 usePlayer returns initial state — covered below.
 *  - 34.3 usePlayerProgress updates on event — current implementation
 *    is a Phase 24 stub (returns `{ positionMs: 0, durationMs: 0 }`).
 *    The "updates on event" wiring is Phase 25+/W7+; we test the
 *    initial-state contract here and leave the update contract for
 *    Phase 39 (instrumented test).
 *
 * The MpvPlayerModule bridge mock is installed globally in
 * `jest.setup.ts` (it extends the @react-native/jest-preset's own
 * `NativeModules` mock rather than overriding it).
 */

import { renderHook } from '@testing-library/react-native';
import { NativeModules } from 'react-native';
import { usePlayer, usePlayerProgress } from '../player';
import type { PlayerState } from '../player';

// The default state from `player.ts` is module-private (DEFAULT_STATE,
// not exported). Pin the values here so the test catches an
// accidental refactor — any change to the documented baseline must
// be a deliberate choice.
const EXPECTED_DEFAULT_STATE: PlayerState = {
  isPlaying: false,
  title: 'Simba Player',
  artist: '',
  album: '',
};

// Helper to clear all bridge mock call counts between tests. The
// global mock is shared across all test files in this module — see
// jest.setup.ts.
function clearBridgeMocks() {
  for (const key of Object.keys(NativeModules.MpvPlayerModule)) {
    const fn = (NativeModules.MpvPlayerModule as Record<string, jest.Mock>)[key];
    if (typeof fn?.mockClear === 'function') {
      fn.mockClear();
    }
  }
}

describe('usePlayer', () => {
  beforeEach(() => {
    clearBridgeMocks();
  });

  it('returns the documented initial state', async () => {
    // Spec §Phase 34.2: usePlayer returns initial state.
    const { result } = await renderHook(() => usePlayer());
    expect(result.current.state).toEqual(EXPECTED_DEFAULT_STATE);
  });

  it('initial state has isPlaying=false', async () => {
    // The player can't be playing before any media has loaded.
    const { result } = await renderHook(() => usePlayer());
    expect(result.current.state.isPlaying).toBe(false);
  });

  it('initial state has the documented baseline metadata', async () => {
    // The current default title is "Simba Player" (placeholder shown
    // before the first onFileLoaded event arrives). artist/album are
    // empty strings (not undefined) so DefaultControls can render
    // placeholder text without conditional checks at every consumer.
    const { result } = await renderHook(() => usePlayer());
    expect(result.current.state.title).toBe('Simba Player');
    expect(result.current.state.artist).toBe('');
    expect(result.current.state.album).toBe('');
  });

  it('exposes the documented commands object', async () => {
    // Pin the contract: usePlayer returns { state, commands }. A
    // refactor that changes the shape would silently break
    // DefaultControls.
    const { result } = await renderHook(() => usePlayer());
    expect(result.current.commands).toBeDefined();
    expect(typeof result.current.commands.play).toBe('function');
    expect(typeof result.current.commands.pause).toBe('function');
    expect(typeof result.current.commands.seek).toBe('function');
    expect(typeof result.current.commands.skipBackward).toBe('function');
    expect(typeof result.current.commands.skipForward).toBe('function');
  });

  it('commands.play delegates to the native bridge', async () => {
    // Verify the bridge wiring (Phase 24): play() calls
    // NativeModules.MpvPlayerModule.play() (the typed wrapper is
    // `bridge.play` in MpvPlayerModule.ts).
    const { result } = await renderHook(() => usePlayer());
    await result.current.commands.play();
    expect(NativeModules.MpvPlayerModule.play).toHaveBeenCalledTimes(1);
  });

  it('commands.pause delegates to the native bridge', async () => {
    const { result } = await renderHook(() => usePlayer());
    await result.current.commands.pause();
    expect(NativeModules.MpvPlayerModule.pause).toHaveBeenCalledTimes(1);
  });

  it('commands.seek(ms) calls seekAbsolute on the bridge', async () => {
    // Phase 24 wiring: commands.seek() translates to
    // bridge.seekAbsolute(positionSec) — note seconds vs ms. The
    // command takes ms (consumer-friendly) and converts internally.
    const { result } = await renderHook(() => usePlayer());
    await result.current.commands.seek(10000); // 10s in ms
    expect(NativeModules.MpvPlayerModule.seekAbsolute).toHaveBeenCalledWith(
      10, // 10000ms / 1000 = 10s
    );
  });

  it('commands.seek accepts zero', async () => {
    // Edge case: seek to the start of the media. Should not throw.
    const { result } = await renderHook(() => usePlayer());
    expect(() => result.current.commands.seek(0)).not.toThrow();
    expect(NativeModules.MpvPlayerModule.seekAbsolute).toHaveBeenCalledWith(0);
  });

  it('commands.skipForward(seconds) calls seekForward on bridge', async () => {
    const { result } = await renderHook(() => usePlayer());
    await result.current.commands.skipForward(15);
    expect(NativeModules.MpvPlayerModule.seekForward).toHaveBeenCalledWith(15);
  });

  it('commands.skipBackward(seconds) calls seekBackward on bridge', async () => {
    const { result } = await renderHook(() => usePlayer());
    await result.current.commands.skipBackward(10);
    expect(NativeModules.MpvPlayerModule.seekBackward).toHaveBeenCalledWith(10);
  });

  it('returns stable command references across renders', async () => {
    // Spec §Phase 34.5: PlayerProvider must not cause unnecessary
    // re-renders. Stable command references let DefaultControls memo
    // its handlers.
    const { result, rerender } = await renderHook(() => usePlayer());
    const firstCommands = result.current.commands;
    await rerender({});
    expect(result.current.commands).toBe(firstCommands);
  });
});

describe('usePlayerProgress', () => {
  it('returns the documented initial state', async () => {
    // Spec §Phase 34.3: usePlayerProgress returns initial state. The
    // current implementation is a Phase 24 stub; we pin the contract
    // here so the eventual wiring (Phase 39 instrumented test) is a
    // drop-in replacement.
    const { result } = await renderHook(() => usePlayerProgress());
    expect(result.current).toEqual({ positionMs: 0, durationMs: 0 });
  });

  it('returns 0/0 when called outside any provider', async () => {
    // The hook must be safe to call anywhere — consumers can use
    // it without wrapping in PlayerProvider. (Unlike usePlayerConfig,
    // usePlayerProgress doesn't throw; see Phase 24 design notes.)
    const { result } = await renderHook(() => usePlayerProgress());
    expect(result.current.positionMs).toBe(0);
    expect(result.current.durationMs).toBe(0);
  });

  it('progress object has the documented fields', async () => {
    const { result } = await renderHook(() => usePlayerProgress());
    expect(typeof result.current.positionMs).toBe('number');
    expect(typeof result.current.durationMs).toBe('number');
  });
});
