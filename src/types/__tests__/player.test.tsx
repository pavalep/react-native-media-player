/**
 * Unit tests for `src/types/player.ts` — the player state/commands API.
 *
 * V13 Phase 51: the surface expanded from 4/2/6 to 20/7/38. The
 * tests pin the documented baseline (via `EXPECTED_DEFAULT_STATE`)
 * and verify the contract that matters for consumers:
 *  - `usePlayer()` outside a provider returns the default state
 *    (no throw — DefaultControls must be able to render anywhere)
 *  - `usePlayer()` inside a provider returns the live state
 *  - `usePlayer()` returns stable command references across renders
 *  - `commands.<method>` delegates to the native bridge
 *  - `usePlayerProgress()` returns the documented initial progress
 *  - The 1Hz-pollable progress hook is separate from the full state
 *
 * The MpvPlayerModule bridge mock is installed globally in
 * `jest.setup.ts` (it extends the @react-native/jest-preset's own
 * `NativeModules` mock rather than overriding it).
 */

import React from 'react';
import { NativeModules } from 'react-native';
import { act, renderHook } from '@testing-library/react-native';
import {
  usePlayer,
  usePlayerProgress,
  toMpvPropertyString,
  DEFAULT_PROGRESS,
  DEFAULT_STATE,
  type PlayerState,
  type PlayerProgress,
} from '../player';
import { PlayerProvider } from '../../components/PlayerProvider';
import * as BridgeModule from '../../bridge/MpvPlayerModule';

// The default state is module-public (DEFAULT_STATE), so we import it
// directly. Pin the import here so a refactor that moves the default
// out of this module would surface as a TypeScript error at the
// import site — not as a silent test failure.

// ── Helpers ────────────────────────────────────────────────────────────────

/** Clear all bridge mock call counts between tests. */
function clearBridgeMocks() {
  for (const key of Object.keys(NativeModules.MpvPlayerModule)) {
    const fn = (NativeModules.MpvPlayerModule as Record<string, jest.Mock>)[key];
    if (typeof fn?.mockClear === 'function') {
      fn.mockClear();
    }
  }
}

/**
 * Install a `subscribePlayerEvent` mock that captures every
 * registered handler so the test can fire events directly. Also
 * mocks `removeAllListeners` to a no-op (the captured handlers
 * are cleaned up in the `restoreSubscribes()` helper).
 */
function captureSubscribes(): {
  handlers: Map<string, Array<(payload: unknown) => void>>;
  restore: () => void;
} {
  const handlers = new Map<string, Array<(payload: unknown) => void>>();
  const subSpy = jest
    .spyOn(BridgeModule, 'subscribePlayerEvent')
    .mockImplementation(
      (
        event: string,
        handler: (payload: unknown) => void,
      ): (() => void) => {
        if (!handlers.has(event)) handlers.set(event, []);
        handlers.get(event)!.push(handler);
        return () => {
          // No-op unsubscribe for tests; captured handlers live
          // for the lifetime of the test.
        };
      },
    );
  const removeSpy = jest
    .spyOn(BridgeModule, 'removeAllListeners')
    .mockImplementation(() => {
      // No-op for tests.
    });
  return {
    handlers,
    restore: () => {
      subSpy.mockRestore();
      removeSpy.mockRestore();
    },
  };
}

// ── usePlayer (no provider) ────────────────────────────────────────────────

describe('usePlayer (no provider)', () => {
  beforeEach(() => {
    clearBridgeMocks();
  });

  it('returns the documented default state', async () => {
    // Outside a <PlayerProvider>, usePlayer must NOT throw — it
    // returns DEFAULT_STATE so DefaultControls can render in any
    // environment (jest, web preview, Storybook).
    const { result } = await renderHook(() => usePlayer());
    expect(result.current.state).toEqual(DEFAULT_STATE);
  });

  it('returns the expected V12 fields at their baseline', async () => {
    // Pin the V12 contract: isPlaying=false, title='Simba Player',
    // artist='', album=''. A refactor that changes the baseline
    // would silently break DefaultControls.
    const { result } = await renderHook(() => usePlayer());
    const s = result.current.state;
    expect(s.isPlaying).toBe(false);
    expect(s.title).toBe('Simba Player');
    expect(s.artist).toBe('');
    expect(s.album).toBe('');
  });

  it('returns the V13 expanded fields at their baseline', async () => {
    // Pin the V13 expansion: numeric fields at 0, booleans at false,
    // collection fields empty, currentChapter / videoParams / error
    // at null.
    const { result } = await renderHook(() => usePlayer());
    const s = result.current.state;
    expect(s.positionMs).toBe(0);
    expect(s.durationMs).toBe(0);
    expect(s.isBuffering).toBe(false);
    expect(s.isSeeking).toBe(false);
    expect(s.seekable).toBe(false);
    expect(s.volume).toBe(100);
    expect(s.isMuted).toBe(false);
    expect(s.speed).toBe(1);
    expect(s.loopMode).toBe('none');
    expect(s.playlist).toEqual([]);
    expect(s.currentIndex).toBe(-1);
    expect(s.tracks).toEqual([]);
    expect(s.chapters).toEqual([]);
    expect(s.currentChapter).toBeNull();
    expect(s.videoParams).toBeNull();
    expect(s.error).toBeNull();
    // V22.0.0 / 1.6.0 additions
    expect(s.shuffle).toBe(false);
  });

  it('exposes the V12 commands object', async () => {
    // The five V12 methods remain on the new commands object —
    // DefaultControls depends on them.
    const { result } = await renderHook(() => usePlayer());
    expect(typeof result.current.commands.play).toBe('function');
    expect(typeof result.current.commands.pause).toBe('function');
    expect(typeof result.current.commands.seek).toBe('function');
    expect(typeof result.current.commands.skipBackward).toBe('function');
    expect(typeof result.current.commands.skipForward).toBe('function');
  });

  it('exposes the V13 expanded commands object', async () => {
    // Spot-check the new commands. (We don't enumerate every method —
    // that would be a redundant duplication of the interface itself.)
    const { result } = await renderHook(() => usePlayer());
    const c = result.current.commands;
    expect(typeof c.togglePlayPause).toBe('function');
    expect(typeof c.stop).toBe('function');
    expect(typeof c.seekBy).toBe('function');
    expect(typeof c.next).toBe('function');
    expect(typeof c.previous).toBe('function');
    expect(typeof c.setVolume).toBe('function');
    expect(typeof c.setMuted).toBe('function');
    expect(typeof c.toggleMute).toBe('function');
    expect(typeof c.setSpeed).toBe('function');
    expect(typeof c.setLoopMode).toBe('function');
    expect(typeof c.loadFile).toBe('function');
    expect(typeof c.loadPlaylist).toBe('function');
    expect(typeof c.playlistRemove).toBe('function');
    expect(typeof c.shuffle).toBe('function');
    expect(typeof c.clear).toBe('function');
    // `stopPlayback` is the FULL teardown (engine + foreground service).
    // It must exist alongside `stop`, which only halts the engine and
    // leaves the session and notification alive. Video's back button
    // needs the full one: `exitPipAndFinish()` finishes the Activity, and
    // the process-global engine would otherwise keep playing behind a
    // closed window.
    expect(typeof c.stopPlayback).toBe('function');
    // The old lane-specific name must NOT survive — a consumer reaching
    // for it would silently get undefined and skip the teardown.
    expect((c as unknown as Record<string, unknown>).stopAudioPlayback).toBeUndefined();
    expect(typeof c.cycleTrack).toBe('function');
    expect(typeof c.setTrack).toBe('function');
    expect(typeof c.enterPip).toBe('function');
    expect(typeof c.exitPip).toBe('function');
    expect(typeof c.exitPipAndFinish).toBe('function');
    expect(typeof c.setKeepScreenOn).toBe('function');
    expect(typeof c.setOrientation).toBe('function');
    expect(typeof c.setImmersive).toBe('function');
    expect(typeof c.setScreenBrightness).toBe('function');
    expect(typeof c.requestNotificationPermission).toBe('function');
    expect(typeof c.openPlayer).toBe('function');
    expect(typeof c.getLaunchParams).toBe('function');
    expect(typeof c.getProperty).toBe('function');
    expect(typeof c.setProperty).toBe('function');
    expect(typeof c.observeProperty).toBe('function');
    expect(typeof c.unobserveProperty).toBe('function');
    expect(typeof c.grantPersistablePermission).toBe('function');
    expect(typeof c.verifyContentUri).toBe('function');
    // V22.0.0 / 1.6.0 additions
    expect(typeof c.getScreenBrightness).toBe('function');
    expect(typeof c.setAudioFilter).toBe('function');
    expect(typeof c.setVideoFilter).toBe('function');
    expect(typeof c.setShuffle).toBe('function');
  });

  it('commands.play delegates to the native bridge', async () => {
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
    // V12 wiring: commands.seek() translates to
    // bridge.seekAbsolute(positionSec) — seconds vs ms.
    const { result } = await renderHook(() => usePlayer());
    await result.current.commands.seek(10000); // 10s in ms
    expect(NativeModules.MpvPlayerModule.seekAbsolute).toHaveBeenCalledWith(10);
  });

  it('commands.seek accepts zero', async () => {
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

  it('commands.seekBy(+ms) calls seekForward with the absolute seconds', async () => {
    const { result } = await renderHook(() => usePlayer());
    await result.current.commands.seekBy(5000); // +5s
    expect(NativeModules.MpvPlayerModule.seekForward).toHaveBeenCalledWith(5);
  });

  it('commands.seekBy(-ms) calls seekBackward with the absolute seconds', async () => {
    const { result } = await renderHook(() => usePlayer());
    await result.current.commands.seekBy(-3000); // -3s
    expect(NativeModules.MpvPlayerModule.seekBackward).toHaveBeenCalledWith(3);
  });

  it('commands.openPlayer reshapes {uri,title,type,startPositionMs} into positional bridge args', async () => {
    const { result } = await renderHook(() => usePlayer());
    await result.current.commands.openPlayer({
      uri: 'file:///song.mp3',
      title: 'Song',
      type: 'audio',
      startPositionMs: 12345,
    });
    expect(NativeModules.MpvPlayerModule.openPlayer).toHaveBeenCalledWith(
      'file:///song.mp3',
      'Song',
      'audio',
      12345,
    );
  });

  it('commands.openPlayer defaults startPositionMs to 0 when omitted', async () => {
    const { result } = await renderHook(() => usePlayer());
    await result.current.commands.openPlayer({
      uri: 'file:///song.mp3',
      title: 'Song',
      type: 'video',
    });
    expect(NativeModules.MpvPlayerModule.openPlayer).toHaveBeenCalledWith(
      'file:///song.mp3',
      'Song',
      'video',
      0,
    );
  });

  // V22.0.0 / 1.6.0 additions — surface-widening for the V19 vertical-swipe
  // chrome (brightness pill) + mpv filter toggle hooks + readback of
  // `playlist-shuffle` via the existing `setProperty` plumbing.
  it('commands.getScreenBrightness delegates to the bridge', async () => {
    const { result } = await renderHook(() => usePlayer());
    const brightness = result.current.commands.getScreenBrightness();
    expect(NativeModules.MpvPlayerModule.getScreenBrightness).toHaveBeenCalledTimes(1);
    // Mock returns 1.0 (the no-op fallback default).
    expect(brightness).toBe(1.0);
  });

  it('commands.setAudioFilter(filter, enabled) forwards both args to the bridge', async () => {
    const { result } = await renderHook(() => usePlayer());
    result.current.commands.setAudioFilter('scaletempo2=max-speed=32.0', true);
    expect(NativeModules.MpvPlayerModule.setAudioFilter).toHaveBeenCalledWith(
      'scaletempo2=max-speed=32.0',
      true,
    );
  });

  it('commands.setVideoFilter(filter, enabled) forwards both args to the bridge', async () => {
    const { result } = await renderHook(() => usePlayer());
    result.current.commands.setVideoFilter('scale=720:trunc(ow/a/2)*2', true);
    expect(NativeModules.MpvPlayerModule.setVideoFilter).toHaveBeenCalledWith(
      'scale=720:trunc(ow/a/2)*2',
      true,
    );
  });

  it('commands.setShuffle(enabled) routes through bridge.setProperty("playlist-shuffle", …)', async () => {
    // `setShuffle` is a thin wrapper over the existing `setProperty`
    // plumbing — the bridge has no dedicated `setShuffle` method.
    //
    // The encoded value is '1' rather than `true`: `playlist-shuffle` is
    // an mpv *integer* option, so a boolean cannot be sent even once
    // stringified ("true" is not a value mpv's int parser accepts).
    const { result } = await renderHook(() => usePlayer());
    result.current.commands.setShuffle(true);
    expect(NativeModules.MpvPlayerModule.setProperty).toHaveBeenCalledWith(
      'playlist-shuffle',
      '1',
    );
  });

  it('returns stable command references across renders', async () => {
    // Spec §Phase 34.5: stable command references let DefaultControls
    // memo its handlers. The V13 commands object is a module-scope
    // singleton, so the reference is identical for every render.
    const { result, rerender } = await renderHook(() => usePlayer());
    const firstCommands = result.current.commands;
    await rerender({});
    expect(result.current.commands).toBe(firstCommands);
  });

  it('returns stable state reference when re-rendered with the same provider state', async () => {
    // Outside a provider, usePlayer returns DEFAULT_STATE every time.
    // The reference should be stable (same object identity) so
    // downstream consumers can memoise on it.
    const { result, rerender } = await renderHook(() => usePlayer());
    const firstState = result.current.state;
    await rerender({});
    expect(result.current.state).toBe(firstState);
  });
});

// ── usePlayer (inside provider) ────────────────────────────────────────────

describe('usePlayer (inside PlayerProvider)', () => {
  let subs: ReturnType<typeof captureSubscribes>;

  beforeEach(() => {
    clearBridgeMocks();
    subs = captureSubscribes();
  });

  afterEach(() => {
    subs.restore();
  });

  it('returns the state from the provider context', async () => {
    // The provider's mount effect hydrates state from the bridge
    // (synchronous getters); the jest mock returns 0/0/'idle'/
    // 100/false/1/'none'/'[]'/null — so the post-hydration state
    // is just DEFAULT_STATE with `title` and `loopMode` re-derived
    // from the bridge.
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <PlayerProvider>{children}</PlayerProvider>
    );
    const { result } = await renderHook(() => usePlayer(), { wrapper });
    // The bridge mock returns '' for getProperty, so title stays at
    // DEFAULT_STATE.title. Position/duration at 0. isPlaying false.
    expect(result.current.state.isPlaying).toBe(false);
    expect(result.current.state.positionMs).toBe(0);
    expect(result.current.state.durationMs).toBe(0);
  });

  it('subscribes to all 22 mpv events on mount', async () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <PlayerProvider>{children}</PlayerProvider>
    );
    await renderHook(() => usePlayer(), { wrapper });
    // Every PlayerEventName should have at least one captured handler.
    const expectedEvents = [
      'onFileLoaded',
      'onPlaybackStateChanged',
      'onPositionChanged',
      'onDurationChanged',
      'onPropertyChanged',
      'onTracksChanged',
      'onChapterChanged',
      'onVideoParamsChanged',
      'onError',
      'onBuffering',
      'onCacheState',
      'onSeekable',
      'onSeeking',
      'onEndFile',
      'onPlaybackRestart',
      'onEndReached',
      'onAudioDeviceChanged',
      'onVolumeChanged',
      'onSpeedChanged',
      'videoReconfig',
      'onPipModeChanged',
      'onPipPlayPause',
      'onPipExpand',
      'onPipClose',
    ];
    for (const event of expectedEvents) {
      expect(subs.handlers.get(event)?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('updates state when an onPlaybackStateChanged event fires', async () => {
    // Mount the provider, then call the onPlaybackStateChanged
    // handler directly. The provider's event subscription should
    // dispatch through applyPlayerEvent and update the state.
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <PlayerProvider>{children}</PlayerProvider>
    );
    const { result } = await renderHook(() => usePlayer(), { wrapper });
    const listeners = subs.handlers.get('onPlaybackStateChanged') ?? [];
    expect(listeners.length).toBeGreaterThan(0);
    // Fire the event with a "playing" payload.
    await act(async () => {
      for (const l of listeners) {
        l({ state: 'playing' });
      }
    });
    expect(result.current.state.isPlaying).toBe(true);
  });

  // ── The mute flag arrives as a STRING ─────────────────────────────────
  //
  // `applyPlayerEvent`'s `mute` case used to be
  // `isMuted: Boolean(value)`. mpv serialises MPV_FORMAT_FLAG to the
  // JSON literals `true` / `false`, which reach JS as the STRINGS
  // `"true"` / `"false"`. Every non-empty string is truthy, so
  // `Boolean("false") === true` and the state was INVERTED on every
  // mute event.
  //
  // Measured on device (emulator-5554, SIMBA W8.3 + lib 1.9.1): native
  // logged `name=mute value=false`, the bridge dispatched `value=false`,
  // and the transport still rendered "Unmute" on an audible player.
  //
  // These tests drive the REAL event path through the provider, so they
  // cover the reducer as well as the wiring.

  it('reads the mute flag string "false" as FALSE, not as truthy', async () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <PlayerProvider>{children}</PlayerProvider>
    );
    const { result } = await renderHook(() => usePlayer(), { wrapper });

    const listeners = subs.handlers.get('onPropertyChanged') ?? [];
    expect(listeners.length).toBeGreaterThan(0);

    await act(async () => {
      for (const l of listeners) {
        l({property: 'mute', value: 'false'});
      }
    });

    // The default is already false, so this is the state that a
    // `Boolean()` coercion would have flipped.
    expect(result.current.state.isMuted).toBe(false);
  });

  it('reads the mute flag string "true" as TRUE', async () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <PlayerProvider>{children}</PlayerProvider>
    );
    const { result } = await renderHook(() => usePlayer(), { wrapper });

    const listeners = subs.handlers.get('onPropertyChanged') ?? [];
    await act(async () => {
      for (const l of listeners) {
        l({property: 'mute', value: 'true'});
      }
    });

    expect(result.current.state.isMuted).toBe(true);
  });

  it('also accepts a real boolean mute flag', async () => {
    // `getMuted()` on the bridge returns an actual boolean while the
    // event payload is a string. Both feed the same field, so both must
    // parse.
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <PlayerProvider>{children}</PlayerProvider>
    );
    const { result } = await renderHook(() => usePlayer(), { wrapper });

    const listeners = subs.handlers.get('onPropertyChanged') ?? [];
    await act(async () => {
      for (const l of listeners) {
        l({property: 'mute', value: true});
      }
    });
    expect(result.current.state.isMuted).toBe(true);

    await act(async () => {
      for (const l of listeners) {
        l({property: 'mute', value: false});
      }
    });
    expect(result.current.state.isMuted).toBe(false);
  });

  it('leaves the mute state alone for an unreadable flag value', async () => {
    // `"null"` is what the bridge returns for an unavailable property
    // and `""` comes from the NOOP bridge. Neither is a boolean, and
    // coercing them would report a state the player is not in — the
    // same rule the `seekable` level seed follows.
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <PlayerProvider>{children}</PlayerProvider>
    );
    const { result } = await renderHook(() => usePlayer(), { wrapper });

    const listeners = subs.handlers.get('onPropertyChanged') ?? [];
    await act(async () => {
      for (const l of listeners) {
        l({property: 'mute', value: 'true'});
      }
    });
    expect(result.current.state.isMuted).toBe(true);

    await act(async () => {
      for (const l of listeners) {
        l({property: 'mute', value: 'null'});
      }
    });
    // Still muted — an unreadable value must not silently unmute.
    expect(result.current.state.isMuted).toBe(true);
  });

  it('updates state when an onError event fires', async () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <PlayerProvider>{children}</PlayerProvider>
    );
    const { result } = await renderHook(() => usePlayer(), { wrapper });
    const listeners = subs.handlers.get('onError') ?? [];
    expect(listeners.length).toBeGreaterThan(0);
    await act(async () => {
      for (const l of listeners) {
        l({ code: 42, recoverable: true, message: 'test error' });
      }
    });
    expect(result.current.state.error).toEqual({
      code: 42,
      recoverable: true,
      message: 'test error',
    });
  });

  it('updates state when an onFileLoaded event fires', async () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <PlayerProvider>{children}</PlayerProvider>
    );
    const { result } = await renderHook(() => usePlayer(), { wrapper });
    const listeners = subs.handlers.get('onFileLoaded') ?? [];
    expect(listeners.length).toBeGreaterThan(0);
    await act(async () => {
      for (const l of listeners) {
        l({
          file: { path: '/song.mp3', title: 'New Title', duration: 120 },
        });
      }
    });
    expect(result.current.state.title).toBe('New Title');
    expect(result.current.state.durationMs).toBe(120000);
    expect(result.current.state.isPlaying).toBe(true);
    expect(result.current.state.positionMs).toBe(0);
  });
});

// ── usePlayerProgress ──────────────────────────────────────────────────────

describe('usePlayerProgress', () => {
  it('returns the documented default progress outside a provider', async () => {
    const { result } = await renderHook(() => usePlayerProgress());
    expect(result.current).toEqual(DEFAULT_PROGRESS);
  });

  it('returns the expected V12 fields at their baseline', async () => {
    const { result } = await renderHook(() => usePlayerProgress());
    expect(result.current.positionMs).toBe(0);
    expect(result.current.durationMs).toBe(0);
  });

  it('returns the V13 expanded fields at their baseline', async () => {
    const { result } = await renderHook(() => usePlayerProgress());
    expect(result.current.isBuffering).toBe(false);
    expect(result.current.isSeeking).toBe(false);
    expect(result.current.seekable).toBe(false);
    expect(result.current.cacheRanges).toEqual([]);
    expect(result.current.cacheFill).toBe(0);
  });

  it('returns the full DEFAULT_PROGRESS shape', async () => {
    // Pin the contract: usePlayerProgress returns all 7 fields, not
    // just 2. The V12 surface is a strict subset.
    const expected: PlayerProgress = {
      positionMs: 0,
      durationMs: 0,
      isBuffering: false,
      isSeeking: false,
      seekable: false,
      cacheRanges: [],
      cacheFill: 0,
    };
    const { result } = await renderHook(() => usePlayerProgress());
    expect(result.current).toEqual(expected);
  });
});

// ── PlayerState default integrity ───────────────────────────────────────────

describe('PlayerState default integrity', () => {
  it('PlayerState has 21 fields in DEFAULT_STATE', async () => {
    // Sanity check: V13 expanded the V12 4-field state to 20 fields.
    // V22.0.0 / 1.6.0 added `shuffle`, bringing it to 21.
    // If a future refactor accidentally drops a field (e.g. by
    // using `Partial<PlayerState>` somewhere), this catches it.
    const keys = Object.keys(DEFAULT_STATE).sort();
    expect(keys).toEqual([
      'album',
      'artist',
      'chapters',
      'currentChapter',
      'currentIndex',
      'durationMs',
      'error',
      'isBuffering',
      'isMuted',
      'isPlaying',
      'isSeeking',
      'loopMode',
      'playlist',
      'positionMs',
      'seekable',
      'shuffle',
      'speed',
      'title',
      'tracks',
      'videoParams',
      'volume',
    ]);
  });
});

// ── setProperty value encoding ─────────────────────────────────────────────

/**
 * `MpvBridgeModule.setProperty(name: String, value: String)` declares both
 * arguments as Kotlin `String`, and React Native's JS→native marshalling
 * *throws* on a mismatch instead of coercing:
 *
 *   Expected argument 1 of method "setProperty" to be a string,
 *   but got a number (24.000000)
 *
 * which surfaces as a red-box `Exception in HostFunction` and unmounts the
 * React tree. These tests pin that every value crossing that boundary has
 * already been encoded to a string by the time it reaches the bridge.
 */
describe('toMpvPropertyString', () => {
  it('passes a string through unchanged', () => {
    expect(toMpvPropertyString('#FFFFFF00')).toBe('#FFFFFF00');
  });

  it('encodes an empty string as-is', () => {
    expect(toMpvPropertyString('')).toBe('');
  });

  it('encodes integers without a decimal point', () => {
    // The reported crash value was `24.000000` — a Double reaching a
    // String parameter. Pin that the encoding drops the fraction.
    expect(toMpvPropertyString(24)).toBe('24');
    expect(toMpvPropertyString(0)).toBe('0');
    expect(toMpvPropertyString(-1)).toBe('-1');
  });

  it('preserves meaningful decimals', () => {
    // mpv float options need the fractional part; blind rounding would
    // silently change the value rather than fix the crash.
    expect(toMpvPropertyString(1.5)).toBe('1.5');
    expect(toMpvPropertyString(0.25)).toBe('0.25');
  });

  it('encodes booleans as mpv textual flags', () => {
    expect(toMpvPropertyString(true)).toBe('true');
    expect(toMpvPropertyString(false)).toBe('false');
  });

  it('maps null and undefined to the empty string, never the word undefined', () => {
    // `String(undefined)` would send the literal text "undefined" to
    // mpv, which is worse than useless — it looks like a real value.
    expect(toMpvPropertyString(null)).toBe('');
    expect(toMpvPropertyString(undefined)).toBe('');
  });

  it('JSON-encodes objects and arrays for structured options', () => {
    // mpv has no other textual form for a `vf`/`af` parameter list.
    expect(toMpvPropertyString({lavfi: 'scale=640:-1'})).toBe(
      '{"lavfi":"scale=640:-1"}',
    );
    expect(toMpvPropertyString([1, 2, 3])).toBe('[1,2,3]');
  });

  it('returns the empty string for a circular structure instead of throwing', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => toMpvPropertyString(circular)).not.toThrow();
    expect(toMpvPropertyString(circular)).toBe('');
  });
});

describe('commands.setProperty encoding', () => {
  beforeEach(() => {
    clearBridgeMocks();
  });

  it('encodes a numeric value before it reaches the bridge', async () => {
    // The exact shape that crashed the caption bridge.
    const { result } = await renderHook(() => usePlayer());
    result.current.commands.setProperty('sub-font-size', 24);
    expect(NativeModules.MpvPlayerModule.setProperty).toHaveBeenCalledWith(
      'sub-font-size',
      '24',
    );
  });

  it('accepts a string value unchanged', async () => {
    const { result } = await renderHook(() => usePlayer());
    result.current.commands.setProperty('sub-color', '#FFFFFFF');
    expect(NativeModules.MpvPlayerModule.setProperty).toHaveBeenCalledWith(
      'sub-color',
      '#FFFFFFF',
    );
  });

  it('never sends a non-string to the bridge, whatever the caller passes', async () => {
    const { result } = await renderHook(() => usePlayer());
    const values: unknown[] = [24, 0, -1, 1.5, true, false, null, undefined, {a: 1}, [1]];
    for (const value of values) {
      result.current.commands.setProperty('sub-pos', value);
    }
    const calls = (NativeModules.MpvPlayerModule.setProperty as jest.Mock)
      .mock.calls;
    expect(calls).toHaveLength(values.length);
    for (const [, sent] of calls) {
      expect(typeof sent).toBe('string');
    }
  });
});

describe('commands that route through setProperty', () => {
  beforeEach(() => {
    clearBridgeMocks();
  });

  it('commands.seekToChapter(index) sends the index as a string', async () => {
    // Regression: this call site passed a raw number and would have
    // thrown inside HostFunction, red-boxing on every chapter jump.
    const { result } = await renderHook(() => usePlayer());
    await result.current.commands.seekToChapter(3);
    expect(NativeModules.MpvPlayerModule.setProperty).toHaveBeenCalledWith(
      'chapter',
      '3',
    );
  });

  it('commands.setShuffle(false) sends 0, because playlist-shuffle is an int option', async () => {
    // The `true` half is pinned in the delegation block above; this
    // covers the other branch, which previously would have sent the
    // boolean `false` straight into a Kotlin String parameter.
    const { result } = await renderHook(() => usePlayer());
    await result.current.commands.setShuffle(false);
    expect(NativeModules.MpvPlayerModule.setProperty).toHaveBeenCalledWith(
      'playlist-shuffle',
      '0',
    );
  });
});

describe('PlayerState.title comes from mpv media-title (v1.9.3)', () => {
  // The other half of the fix. Registering `media-title` only matters if
  // a `media-title` event actually moves `state.title` — and the reason
  // the header said "Simba Player" is that neither half was in place:
  // the property was never registered, so the event never arrived.
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <PlayerProvider>{children}</PlayerProvider>
  );

  let subs: ReturnType<typeof captureSubscribes>;
  beforeEach(() => {
    clearBridgeMocks();
    subs = captureSubscribes();
  });
  afterEach(() => {
    subs.restore();
  });

  it('starts at the placeholder, so a passing test below is meaningful', async () => {
    const { result } = await renderHook(() => usePlayer(), { wrapper });
    expect(result.current.state.title).toBe('Simba Player');
  });

  it('adopts a media-title property change', async () => {
    const { result } = await renderHook(() => usePlayer(), { wrapper });
    const listeners = subs.handlers.get('onPropertyChanged') ?? [];
    expect(listeners.length).toBeGreaterThan(0);

    await act(async () => {
      for (const l of listeners) {
        l({property: 'media-title', value: 'Overrun!'});
      }
    });

    expect(result.current.state.title).toBe('Overrun!');
  });

  it('adopts the title embedded in a metadata property change', async () => {
    const { result } = await renderHook(() => usePlayer(), { wrapper });
    const listeners = subs.handlers.get('onPropertyChanged') ?? [];

    // mpv's `metadata` is a NODE LIST, so it arrives as an array of
    // {key, value} entries — not as a flat object. `parseMetadata`
    // correctly rejects a flat object with `{}`; the first draft of
    // this test sent one and failed, which is the test having been
    // wrong rather than the parser being loose.
    await act(async () => {
      for (const l of listeners) {
        l({
          property: 'metadata',
          value: JSON.stringify([
            {key: 'title', value: 'Overrun!'},
            {key: 'artist', value: 'Monica Strebel'},
          ]),
        });
      }
    });

    expect(result.current.state.title).toBe('Overrun!');
    expect(result.current.state.artist).toBe('Monica Strebel');
  });

  it('never adopts mpv\'s "null" sentinel as the title', async () => {
    // mpv serialises a null string as the four-character literal
    // "null" across the JSON boundary. Assigning it produces a header
    // reading literally `null` — a regression this codebase has already
    // been bitten by once (D-035).
    const { result } = await renderHook(() => usePlayer(), { wrapper });
    const listeners = subs.handlers.get('onPropertyChanged') ?? [];

    await act(async () => {
      for (const l of listeners) {
        l({property: 'media-title', value: 'null'});
      }
    });

    expect(result.current.state.title).toBe('Simba Player');
  });

  it('adopts a real title that arrives after the placeholder was replaced', async () => {
    // Switching items must not leave the previous item's title behind.
    const { result } = await renderHook(() => usePlayer(), { wrapper });
    const listeners = subs.handlers.get('onPropertyChanged') ?? [];

    await act(async () => {
      for (const l of listeners) {
        l({property: 'media-title', value: 'First film'});
      }
    });
    await act(async () => {
      for (const l of listeners) {
        l({property: 'media-title', value: 'Second film'});
      }
    });

    expect(result.current.state.title).toBe('Second film');
  });
});

/**
 * v1.9.3 — the title that was accepted and thrown away.
 *
 * `openPlayer({uri, title})` has always accepted a title, and it has
 * always reached `PlayerActivity`. What never happened was anyone
 * APPLYING it:
 *
 *   - `useLaunchPlayback` destructures only `uri` and `startPositionMs`
 *     out of the launch params, then calls `loadFile(uri)`;
 *   - `onFileLoaded`'s handler reads `file?.title` from a native payload
 *     that contains `requestId` and `resolvedPath` and no `file` key, so
 *     the branch never fired;
 *   - `media-title` and `metadata` were absent from OBSERVED_PROPERTIES,
 *     so mpv's own title could not arrive either.
 *
 * The net effect for every consumer was `PlayerState.title` pinned at the
 * `DEFAULT_STATE` placeholder, and a player header reading "Simba
 * Player" over whatever film was actually playing.
 *
 * The fix applies mpv's own `force-media-title` option BEFORE the load.
 */
describe('commands.loadFile applies the launch title (v1.9.3)', () => {
  beforeEach(() => {
    clearBridgeMocks();
  });

  it('writes force-media-title with the supplied title', async () => {
    const { result } = await renderHook(() => usePlayer());
    await result.current.commands.loadFile('file:///a.mp4', 'Overrun!');
    expect(NativeModules.MpvPlayerModule.setProperty).toHaveBeenCalledWith(
      'force-media-title',
      'Overrun!',
    );
  });

  it('sets the option BEFORE loading, because mpv applies it at load time', async () => {
    // Order is the contract, not an optimisation. `force-media-title`
    // is read when the file is loaded, so setting it afterwards would
    // leave the already-loaded file with mpv's derived title — which
    // for a signed CDN URL is an opaque token, not a movie name.
    const { result } = await renderHook(() => usePlayer());
    await result.current.commands.loadFile('file:///a.mp4', 'Overrun!');

    const order: string[] = [];
    const setProperty = NativeModules
      .MpvPlayerModule.setProperty as jest.Mock;
    const loadFile = NativeModules.MpvPlayerModule.loadFile as jest.Mock;
    setProperty.mockImplementation(() => {
      order.push('setProperty');
    });
    loadFile.mockImplementation(() => {
      order.push('loadFile');
    });

    await result.current.commands.loadFile('file:///b.mp4', 'Second');
    expect(order).toEqual(['setProperty', 'loadFile']);
  });

  it('trims the title — a blank or padded value would render as whitespace', async () => {
    const { result } = await renderHook(() => usePlayer());
    await result.current.commands.loadFile('file:///a.mp4', '  Overrun!  ');
    expect(NativeModules.MpvPlayerModule.setProperty).toHaveBeenCalledWith(
      'force-media-title',
      'Overrun!',
    );
  });

  it('omits the option entirely when no title is supplied', async () => {
    // No title means "let mpv derive one", which is the pre-1.9.3
    // behaviour. Writing `force-media-title` with an empty string would
    // blank the header instead of falling back.
    const { result } = await renderHook(() => usePlayer());
    await result.current.commands.loadFile('file:///a.mp4');
    expect(NativeModules.MpvPlayerModule.setProperty).not.toHaveBeenCalledWith(
      'force-media-title',
      expect.anything(),
    );
    expect(NativeModules.MpvPlayerModule.loadFile).toHaveBeenCalledWith(
      'file:///a.mp4',
    );
  });

  it('still loads the file when the property write is rejected', async () => {
    // A rejected `force-media-title` must not cost the user their video.
    // The video plays; the title falls back to whatever mpv derives.
    const setProperty = NativeModules.MpvPlayerModule
      .setProperty as jest.Mock;
    setProperty.mockImplementationOnce(() => {
      throw new Error('property rejected');
    });

    const { result } = await renderHook(() => usePlayer());
    // `loadFile` is a SYNCHRONOUS command (void), so it throws rather
    // than rejecting — asserting "does not throw" is the contract.
    expect(() =>
      result.current.commands.loadFile('file:///a.mp4', 'Overrun!'),
    ).not.toThrow();
    expect(NativeModules.MpvPlayerModule.loadFile).toHaveBeenCalledWith(
      'file:///a.mp4',
    );
  });
});

// ── V21: single-Activity surface control ────────────────────────────────────

describe('V21 surface control (setVideoBounds family)', () => {
  beforeEach(() => {
    clearBridgeMocks();
  });

  it('exposes the surface commands on the command surface', async () => {
    const { result } = await renderHook(() => usePlayer());
    const c = result.current.commands;
    expect(typeof c.setVideoBounds).toBe('function');
    expect(typeof c.fillVideoBounds).toBe('function');
    expect(typeof c.setSurfaceVisible).toBe('function');
    expect(typeof c.isSurfaceMounted).toBe('function');
  });

  it('forwards the rect verbatim to the bridge', async () => {
    // The whole design rests on these exact numbers reaching native: the
    // surface is placed by mutating its layout bounds, so a rounded,
    // clamped, or reordered argument would put the picture in the wrong
    // rect with no error anywhere.
    const setVideoBounds = NativeModules.MpvPlayerModule
      .setVideoBounds as jest.Mock;
    setVideoBounds.mockResolvedValue(true);

    const { result } = await renderHook(() => usePlayer());
    await act(async () => {
      await result.current.commands.setVideoBounds(12, 34, 56, 78);
    });

    expect(setVideoBounds).toHaveBeenCalledWith(12, 34, 56, 78);
  });

  it('propagates a false result so callers can refuse to present video', async () => {
    // This is the reason these return a Promise<boolean> instead of
    // fire-and-forget: `false` means "there was no surface to move".
    // A caller that cannot see that would render chrome over a video
    // that was never shown - a control that looks live and is not.
    const setVideoBounds = NativeModules.MpvPlayerModule
      .setVideoBounds as jest.Mock;
    setVideoBounds.mockResolvedValue(false);

    const { result } = await renderHook(() => usePlayer());
    let applied: boolean | undefined;
    await act(async () => {
      applied = await result.current.commands.setVideoBounds(0, 0, 10, 10);
    });

    expect(applied).toBe(false);
  });

  it('reports isSurfaceMounted from the bridge rather than assuming true', async () => {
    const isSurfaceMounted = NativeModules.MpvPlayerModule
      .isSurfaceMounted as jest.Mock;
    isSurfaceMounted.mockReturnValue(false);

    const { result } = await renderHook(() => usePlayer());
    expect(result.current.commands.isSurfaceMounted()).toBe(false);

    isSurfaceMounted.mockReturnValue(true);
    expect(result.current.commands.isSurfaceMounted()).toBe(true);
  });

  it('forwards the visibility flag, including the hide direction', async () => {
    const setSurfaceVisible = NativeModules.MpvPlayerModule
      .setSurfaceVisible as jest.Mock;
    setSurfaceVisible.mockResolvedValue(true);

    const { result } = await renderHook(() => usePlayer());
    await act(async () => {
      await result.current.commands.setSurfaceVisible(false);
    });
    expect(setSurfaceVisible).toHaveBeenCalledWith(false);

    setSurfaceVisible.mockClear();
    await act(async () => {
      await result.current.commands.setSurfaceVisible(true);
    });
    expect(setSurfaceVisible).toHaveBeenCalledWith(true);
  });
});

describe('NOOP fallback honesty (V21)', () => {
  const original = NativeModules.MpvPlayerModule;

  afterEach(() => {
    NativeModules.MpvPlayerModule = original;
  });

  it('reports that no surface exists instead of claiming success', async () => {
    // With no native module present, `getMpvPlayerModule()` hands back the
    // NOOP bridge. Every surface mutator must report failure there.
    //
    // If any of these returned success, a consumer would light up
    // mini-player chrome over a surface that was never mounted: a control
    // that looks live and is not, which is exactly the class of bug this
    // module's fallback exists to prevent.
    (NativeModules as { MpvPlayerModule?: unknown }).MpvPlayerModule =
      undefined;

    const bridge = BridgeModule.getMpvPlayerModule();

    expect(bridge.isSurfaceMounted()).toBe(false);
    await expect(bridge.fillVideoBounds()).resolves.toBe(false);
    await expect(bridge.setSurfaceVisible(true)).resolves.toBe(false);
    await expect(bridge.setVideoBounds(0, 0, 10, 10)).resolves.toBe(false);
  });
});
