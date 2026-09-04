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
    expect(typeof c.selectTrack).toBe('function');
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
  it('PlayerState has 20 fields in DEFAULT_STATE', async () => {
    // Sanity check: V13 expanded the V12 4-field state to 20 fields.
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
      'speed',
      'title',
      'tracks',
      'videoParams',
      'volume',
    ]);
  });
});
