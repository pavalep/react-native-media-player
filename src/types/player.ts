import React, { createContext, useContext, useMemo } from 'react';
import {
  getMpvPlayerModule,
  dlog,
  MpvLoopMode,
  MpvTrack,
  MpvChapter,
  MpvVideoParams,
  MpvPlaybackState,
  MpvFileInfo,
} from '../bridge/MpvPlayerModule';

/**
 * V13 Phase 51: expanded `PlayerState`. The V12 surface (4 fields)
 * is preserved; the new fields populate from `subscribePlayerEvent`
 * callbacks dispatched by `PlayerProvider`.
 *
 * Field sources (who writes each field):
 *  - `title`        — `onFileLoaded.file.title`, `onPropertyChanged('media-title')`, hydration
 *  - `artist`       — `onPropertyChanged('metadata')` (parsed), hydration
 *  - `album`        — `onPropertyChanged('metadata')` (parsed), hydration
 *  - `isPlaying`    — `onPlaybackStateChanged`, `onEndFile`, `onPlaybackRestart`
 *  - `positionMs`   — 1Hz `bridge.getPosition()` poll + `onPositionChanged`
 *  - `durationMs`   — `onDurationChanged` + `onFileLoaded.file.duration` + hydration
 *  - `isBuffering`  — `onBuffering`
 *  - `isSeeking`    — `onSeeking`
 *  - `seekable`     — `onSeekable`
 *  - `volume`       — `onVolumeChanged` + `onPropertyChanged('volume')` + hydration
 *  - `isMuted`      — `onPropertyChanged('mute')` + hydration
 *  - `speed`        — `onSpeedChanged` + hydration
 *  - `loopMode`     — hydration from `bridge.getLoopMode()` (no event for it)
 *  - `playlist`     — `onPropertyChanged('playlist')` (parsed) + hydration
 *  - `currentIndex` — `onPropertyChanged('playlist-playing-pos')` + hydration
 *  - `tracks`       — `onTracksChanged` + hydration
 *  - `chapters`     — hydration from `bridge.getChapters()` (no event for the full list)
 *  - `currentChapter` — `onChapterChanged` + hydration
 *  - `videoParams`  — `onVideoParamsChanged` + hydration
 *  - `error`        — `onError`; cleared on the next `onFileLoaded`
 *
 * All fields default to a documented baseline (see `DEFAULT_STATE`).
 * Consumers that need a single source of truth for player state
 * should rely on `usePlayer()` inside a `<PlayerProvider>`; consumers
 * that need to render outside a provider (e.g. a top bar that
 * always exists) can still call `usePlayer()` and get the baseline
 * defaults (no throw, unlike `usePlayerConfig`).
 */
export interface PlayerState {
  // ── V12 surface (preserved) ───────────────────────────────────────────
  /** True when mpv is actively playing (not paused, not stopped). */
  isPlaying: boolean;
  /** Track title (from mpv `media-title` → launch title → "Simba Player"). */
  title: string;
  /** Track artist (from mpv `metadata/by-key/artist`). Empty when untagged. */
  artist: string;
  /** Track album (from mpv `metadata/by-key/album`). Empty when untagged. */
  album: string;

  // ── V13 Phase 51 additions ────────────────────────────────────────────
  /** Current playback position in milliseconds. 0 when no file is loaded. */
  positionMs: number;
  /** Total duration in milliseconds. 0 when unknown (mpv hasn't parsed yet). */
  durationMs: number;
  /** True while mpv is buffering. Drives the center loading spinner. */
  isBuffering: boolean;
  /** True while a seek is in flight. Suppresses redundant seek commands. */
  isSeeking: boolean;
  /** True when the current file is seekable (false for live streams). */
  seekable: boolean;
  /** Playback volume (0..100). mpv-native range. */
  volume: number;
  /** Mute state. Decoupled from volume (volume stays at last value). */
  isMuted: boolean;
  /** Playback speed (1.0 = normal). */
  speed: number;
  /** Loop mode: 'none' | 'file' | 'playlist'. */
  loopMode: MpvLoopMode;
  /** Current playlist entries (filename + title, as returned by mpv). */
  playlist: PlaylistEntry[];
  /** Index into `playlist` of the currently-playing entry. -1 when empty. */
  currentIndex: number;
  /** Available tracks (video / audio / sub) for the current file. */
  tracks: MpvTrack[];
  /** Chapter list for the current file. */
  chapters: MpvChapter[];
  /** Currently-active chapter (or null at file start). */
  currentChapter: MpvChapter | null;
  /** Video stream params (resolution, fps, codec). null for audio-only files. */
  videoParams: MpvVideoParams | null;
  /** Last error reported by mpv. Cleared on the next `onFileLoaded`. */
  error: { code: number; recoverable: boolean; message: string } | null;
}

/**
 * mpv playlist entry. Mirrors the Kotlin `MpvPlaylistEntry` shape.
 */
export interface PlaylistEntry {
  readonly filename: string;
  readonly title?: string;
  readonly current?: boolean;
}

/**
 * V13 Phase 51: expanded `PlayerProgress`. The V12 surface (2 fields)
 * is preserved; the new fields populate from mpv events.
 *
 * `usePlayerProgress()` is separate from `usePlayer()` so consumers
 * that only need position/duration don't re-render on every
 * `onPropertyChanged('volume')` etc. The provider updates the
 * progress context ONLY on 1Hz ticks + the dedicated event updates
 * (`isBuffering`, `isSeeking`, `seekable`, `cacheRanges`, `cacheFill`).
 */
export interface PlayerProgress {
  // ── V12 surface (preserved) ───────────────────────────────────────────
  /** Current playback position in milliseconds. 0 when no file is loaded. */
  positionMs: number;
  /** Total duration in milliseconds. 0 when unknown (mpv hasn't parsed yet). */
  durationMs: number;

  // ── V13 Phase 51 additions ────────────────────────────────────────────
  /** True while mpv is buffering. */
  isBuffering: boolean;
  /** True while a seek is in flight. */
  isSeeking: boolean;
  /** True when the current file is seekable. */
  seekable: boolean;
  /** Cached byte ranges. Empty for non-network sources. */
  cacheRanges: Array<{ start: number; end: number }>;
  /** Cache fill percent (0..100). 0 for non-network sources. */
  cacheFill: number;
}

/**
 * V13 Phase 51: expanded `PlayerCommands`. The V12 surface (5 methods)
 * is preserved; the new methods map to the additional 73 native bridge
 * methods that consumers use (volume, mute, speed, loop, tracks, PiP,
 * brightness, openPlayer, etc.).
 *
 * All methods resolve the bridge lazily at call time, so a stable
 * command object is built once at module load. The 1Hz-poll progress
 * context and the heavy event-subscription state context are
 * separate from the commands.
 */
export interface PlayerCommands {
  // ── V12 surface (preserved) ───────────────────────────────────────────
  /** Resume playback (or start playback of the current file). */
  play(): void;
  /** Pause playback (mpv remains at the current position). */
  pause(): void;
  /** Seek to an absolute position in milliseconds. */
  seek(positionMs: number): void;
  /** Skip backward by N seconds (clamps at 0). */
  skipBackward(seconds: number): void;
  /** Skip forward by N seconds. */
  skipForward(seconds: number): void;

  // ── V13 Phase 51 additions ────────────────────────────────────────────
  /** Toggle between play and pause. */
  togglePlayPause(): void;
  /** Stop playback entirely. */
  stop(): void;
  /** Relative seek in milliseconds. Negative seeks backward. */
  seekBy(deltaMs: number): void;
  /** Seek to the chapter at `index` (via mpv `setProperty('chapter', index)`). */
  seekToChapter(index: number): void;
  /** Skip to the next playlist entry. */
  next(): void;
  /** Skip to the previous playlist entry. */
  previous(): void;

  // Volume / audio
  /** Set the playback volume (0..100). */
  setVolume(volume: number): void;
  /** Set the muted state. */
  setMuted(muted: boolean): void;
  /** Toggle the muted state. */
  toggleMute(): void;

  // Speed / loop
  /** Set the playback speed (1.0 = normal). */
  setSpeed(speed: number): void;
  /** Set the loop mode (`'none' | 'file' | 'playlist'`). */
  setLoopMode(mode: MpvLoopMode): void;

  // File loading
  /** Load a single media file. */
  loadFile(uri: string): void;
  /** Load a playlist of media files, starting at `startIndex` (default 0). */
  loadPlaylist(uris: string[], startIndex?: number): void;

  // Playlist manipulation
  /** Remove the playlist entry at `index`. */
  playlistRemove(index: number): void;
  /** Shuffle the current playlist. */
  shuffle(): void;
  /** Clear the current playlist. */
  clear(): void;

  // Tracks
  /** Select a track by ID. */
  selectTrack(trackId: number): void;
  /** Cycle to the next/previous track of the given type. */
  cycleTrack(type: 'video' | 'audio' | 'sub'): void;
  /** Set the active track for a type (trackId < 0 means "no track"). */
  setTrack(type: 'video' | 'audio' | 'sub', trackId: number): void;

  // PiP
  /** Enter Picture-in-Picture mode. */
  enterPip(): void;
  /** Exit PiP by bringing the activity to the front. */
  exitPip(): void;
  /** Exit PiP and finish the activity. */
  exitPipAndFinish(): void;

  // Screen
  /** Toggle `FLAG_KEEP_SCREEN_ON` on the current activity window. */
  setKeepScreenOn(enabled: boolean): void;
  /** Pin the activity to a fixed orientation. */
  setOrientation(mode: 'portrait' | 'landscape' | 'sensor'): void;
  /** Toggle system bars visibility (immersive mode). */
  setImmersive(enabled: boolean): void;
  /** Set the window screen brightness (0..1). */
  setScreenBrightness(value: number): void;

  // Notification
  /** Request the `POST_NOTIFICATIONS` permission on Android 13+. */
  requestNotificationPermission(): void;

  // Activity launch (Phase 52 hooks wrap these for consumer ergonomics)
  /**
   * Hand off to the dedicated `PlayerActivity`. Resolves with `true`
   * on a successful `startActivity`. The new signature is the V13
   * module signature (no `duration` / `source` / `mediaType` — those
   * were V11 Redux-dispatch concerns that V13 drops).
   */
  openPlayer(opts: {
    uri: string;
    title: string;
    type: 'video' | 'audio';
    startPositionMs?: number;
  }): Promise<boolean>;
  /** One-shot accessor for the launch params the most recent `openPlayer` handed to `PlayerActivity`. */
  getLaunchParams(): { uri: string; title: string; type: 'video' | 'audio'; startPositionMs: number } | null;

  // Generic property access (used by audioSettingsService, metadataService)
  /** Get the value of an mpv property as a string. */
  getProperty(name: string): string;
  /** Set the value of an mpv property. Value is stringified before sending. */
  setProperty(name: string, value: unknown): void;
  /** Begin observing an mpv property (emits `onPropertyChanged` events). */
  observeProperty(name: string): void;
  /** Stop observing an mpv property. */
  unobserveProperty(name: string): void;

  // File persistence (used by fileService for content:// URI permissions)
  /** Take a persistable read URI permission for a content:// URI. */
  grantPersistablePermission(uri: string): void;
  /** Returns true when the URI is still readable (content:// or file://). */
  verifyContentUri(uri: string): boolean;
}

/** Combined result from `usePlayer()`. */
export interface UsePlayerResult {
  state: PlayerState;
  commands: PlayerCommands;
}

// ═══════════════════════════════════════════════════════════════════════════
// Context plumbing
// ═══════════════════════════════════════════════════════════════════════════

/**
 * V13 Phase 51: React context for the live player state. `null`
 * means "no provider in scope — fall back to `DEFAULT_STATE`".
 *
 * The provider holds the state in a `useState` (rendered) +
 * `useRef` (read-by-event-handlers) pair; both contexts are exposed
 * for the provider to write, and the public hooks (`usePlayer`,
 * `usePlayerProgress`) read from them with the null-fallback to
 * the default constants.
 *
 * Exported (not module-local) so `<PlayerStateProvider>` in
 * `PlayerProvider.tsx` can wrap children with the context.
 */
export const PlayerStateContext = createContext<PlayerState | null>(null);
export const PlayerProgressContext = createContext<PlayerProgress | null>(null);

// ═══════════════════════════════════════════════════════════════════════════
// Defaults
// ═══════════════════════════════════════════════════════════════════════════

/**
 * V13 Phase 51 default state. The four V12 fields keep their
 * documented baseline (`title: 'Simba Player'`, `artist: ''`,
 * `album: ''`, `isPlaying: false`); the new fields default to
 * their "no media loaded" / "no event received" values.
 *
 * Used by:
 *  - The provider's initial `useState` (the first frame before
 *    hydration runs)
 *  - `usePlayer()` when called outside any `<PlayerProvider>` —
 *    returns the default state instead of throwing
 *  - Tests asserting the documented baseline
 */
export const DEFAULT_STATE: PlayerState = {
  // V12
  isPlaying: false,
  title: 'Simba Player',
  artist: '',
  album: '',

  // V13
  positionMs: 0,
  durationMs: 0,
  isBuffering: false,
  isSeeking: false,
  seekable: false,
  volume: 100,
  isMuted: false,
  speed: 1,
  loopMode: 'none',
  playlist: [],
  currentIndex: -1,
  tracks: [],
  chapters: [],
  currentChapter: null,
  videoParams: null,
  error: null,
};

/** V13 default progress (2 V12 + 5 V13 fields). */
export const DEFAULT_PROGRESS: PlayerProgress = {
  positionMs: 0,
  durationMs: 0,
  isBuffering: false,
  isSeeking: false,
  seekable: false,
  cacheRanges: [],
  cacheFill: 0,
};

// ═══════════════════════════════════════════════════════════════════════════
// Commands (built once, stable across renders)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * V13 Phase 51: build the full commands object. The bridge is
 * resolved lazily on every invocation, so we can build the
 * commands at module load without forcing a native module to be
 * present (the no-op fallback kicks in for jest / web previews).
 *
 * The returned object is memoized at module scope and reused for
 * every `usePlayer()` call — `expect(result.current.commands).toBe(firstCommands)`
 * holds across re-renders (per the Phase 24 stable-reference contract).
 */
function buildCommands(): PlayerCommands {
  return {
    // V12 surface
    play: () => {
      dlog('commands.play()');
      getMpvPlayerModule().play();
    },
    pause: () => {
      dlog('commands.pause()');
      getMpvPlayerModule().pause();
    },
    seek: (positionMs: number) => {
      dlog('commands.seek(positionMs=', positionMs, ')');
      getMpvPlayerModule().seekAbsolute(positionMs / 1000);
    },
    skipBackward: (seconds: number) => {
      dlog('commands.skipBackward(', seconds, ')');
      getMpvPlayerModule().seekBackward(seconds);
    },
    skipForward: (seconds: number) => {
      dlog('commands.skipForward(', seconds, ')');
      getMpvPlayerModule().seekForward(seconds);
    },

    // V13 additions
    togglePlayPause: () => {
      dlog('commands.togglePlayPause()');
      getMpvPlayerModule().togglePlayPause();
    },
    stop: () => {
      dlog('commands.stop()');
      getMpvPlayerModule().stop();
    },
    seekBy: (deltaMs: number) => {
      dlog('commands.seekBy(', deltaMs, ')');
      const deltaSec = Math.abs(deltaMs / 1000);
      if (deltaMs >= 0) {
        getMpvPlayerModule().seekForward(deltaSec);
      } else {
        getMpvPlayerModule().seekBackward(deltaSec);
      }
    },
    seekToChapter: (index: number) => {
      dlog('commands.seekToChapter(', index, ')');
      // mpv supports `setProperty('chapter', N)` to jump to a specific
      // chapter index. The bridge has `seekChapter(direction)` for
      // next/previous but not direct index access; use the property
      // setter so we get a single round-trip.
      getMpvPlayerModule().setProperty('chapter', index);
    },
    next: () => {
      dlog('commands.next()');
      getMpvPlayerModule().playlistNext();
    },
    previous: () => {
      dlog('commands.previous()');
      getMpvPlayerModule().playlistPrev();
    },

    setVolume: (volume: number) => {
      dlog('commands.setVolume(', volume, ')');
      getMpvPlayerModule().setVolume(volume);
    },
    setMuted: (muted: boolean) => {
      dlog('commands.setMuted(', muted, ')');
      getMpvPlayerModule().setMuted(muted);
    },
    toggleMute: () => {
      dlog('commands.toggleMute()');
      getMpvPlayerModule().toggleMute();
    },

    setSpeed: (speed: number) => {
      dlog('commands.setSpeed(', speed, ')');
      getMpvPlayerModule().setSpeed(speed);
    },
    setLoopMode: (mode: MpvLoopMode) => {
      dlog('commands.setLoopMode(', mode, ')');
      getMpvPlayerModule().setLoopMode(mode);
    },

    loadFile: (uri: string) => {
      dlog('commands.loadFile(', uri, ')');
      getMpvPlayerModule().loadFile(uri);
    },
    loadPlaylist: (uris: string[], startIndex?: number) => {
      dlog('commands.loadPlaylist(len=', uris.length, ', start=', startIndex, ')');
      getMpvPlayerModule().loadPlaylist(uris, startIndex);
    },

    playlistRemove: (index: number) => {
      dlog('commands.playlistRemove(', index, ')');
      getMpvPlayerModule().playlistRemove(index);
    },
    shuffle: () => {
      dlog('commands.shuffle()');
      getMpvPlayerModule().playlistShuffle();
    },
    clear: () => {
      dlog('commands.clear()');
      getMpvPlayerModule().playlistClear();
    },

    selectTrack: (trackId: number) => {
      dlog('commands.selectTrack(', trackId, ')');
      getMpvPlayerModule().selectTrack(trackId);
    },
    cycleTrack: (type: 'video' | 'audio' | 'sub') => {
      dlog('commands.cycleTrack(', type, ')');
      getMpvPlayerModule().cycleTrack(type);
    },
    setTrack: (type: 'video' | 'audio' | 'sub', trackId: number) => {
      dlog('commands.setTrack(', type, ',', trackId, ')');
      getMpvPlayerModule().setTrack(type, trackId);
    },

    enterPip: () => {
      dlog('commands.enterPip()');
      getMpvPlayerModule().enterPip();
    },
    exitPip: () => {
      dlog('commands.exitPip()');
      getMpvPlayerModule().exitPip();
    },
    exitPipAndFinish: () => {
      dlog('commands.exitPipAndFinish()');
      getMpvPlayerModule().exitPipAndFinish();
    },

    setKeepScreenOn: (enabled: boolean) => {
      dlog('commands.setKeepScreenOn(', enabled, ')');
      getMpvPlayerModule().setKeepScreenOn(enabled);
    },
    setOrientation: (mode) => {
      dlog('commands.setOrientation(', mode, ')');
      getMpvPlayerModule().setOrientation(mode);
    },
    setImmersive: (enabled: boolean) => {
      dlog('commands.setImmersive(', enabled, ')');
      getMpvPlayerModule().setImmersive(enabled);
    },
    setScreenBrightness: (value: number) => {
      dlog('commands.setScreenBrightness(', value, ')');
      getMpvPlayerModule().setScreenBrightness(value);
    },

    requestNotificationPermission: () => {
      dlog('commands.requestNotificationPermission()');
      getMpvPlayerModule().requestNotificationPermission();
    },

    openPlayer: async (opts) => {
      dlog('commands.openPlayer(', opts, ')');
      return getMpvPlayerModule().openPlayer(
        opts.uri,
        opts.title,
        opts.type,
        opts.startPositionMs ?? 0,
      );
    },
    getLaunchParams: () => {
      dlog('commands.getLaunchParams()');
      return getMpvPlayerModule().getLaunchParams();
    },

    getProperty: (name: string) => {
      dlog('commands.getProperty(', name, ')');
      return getMpvPlayerModule().getProperty(name);
    },
    setProperty: (name: string, value: unknown) => {
      dlog('commands.setProperty(', name, ',', value, ')');
      getMpvPlayerModule().setProperty(name, value);
    },
    observeProperty: (name: string) => {
      dlog('commands.observeProperty(', name, ')');
      getMpvPlayerModule().observeProperty(name);
    },
    unobserveProperty: (name: string) => {
      dlog('commands.unobserveProperty(', name, ')');
      getMpvPlayerModule().unobserveProperty(name);
    },

    grantPersistablePermission: (uri: string) => {
      dlog('commands.grantPersistablePermission(', uri, ')');
      getMpvPlayerModule().grantPersistablePermission(uri);
    },
    verifyContentUri: (uri: string) => {
      dlog('commands.verifyContentUri(', uri, ')');
      return getMpvPlayerModule().verifyContentUri(uri);
    },
  };
}

/** Module-scope singleton: built once, shared by every `usePlayer()` call. */
const BUILT_COMMANDS: PlayerCommands = buildCommands();

// ═══════════════════════════════════════════════════════════════════════════
// Public hooks
// ═══════════════════════════════════════════════════════════════════════════

/**
 * V13 Phase 51: hook returning the player's current state + commands.
 *
 * When called inside a `<PlayerProvider>`, the `state` object is
 * driven by mpv events (via `subscribePlayerEvent`) and the 1Hz
 * position/duration poll. Outside a provider, `state` is
 * `DEFAULT_STATE` (no throw — see Phase 24 design notes: this
 * hook is non-throwing so DefaultControls can render in any
 * environment, including web previews and tests).
 *
 * The `commands` object is a module-singleton: the same reference
 * is returned for every `usePlayer()` call, so `useMemo`-wrapped
 * consumers don't re-create handlers on every render.
 *
 * @example
 * ```tsx
 * function MyControls() {
 *   const { state, commands } = usePlayer();
 *   return (
 *     <Pressable onPress={state.isPlaying ? commands.pause : commands.play}>
 *       <Text>{state.isPlaying ? 'Pause' : 'Play'} {state.title}</Text>
 *     </Pressable>
 *   );
 * }
 * ```
 */
export function usePlayer(): UsePlayerResult {
  const state = useContext(PlayerStateContext);
  return useMemo<UsePlayerResult>(
    () => ({
      state: state ?? DEFAULT_STATE,
      commands: BUILT_COMMANDS,
    }),
    [state],
  );
}

/**
 * V13 Phase 51: hook returning position + duration + a few related
 * progress fields. Separate from `usePlayer()` so consumers that
 * only render a scrubber / time labels don't re-render on every
 * volume / track / chapter change.
 *
 * The provider updates the progress context only on:
 *  - 1Hz `bridge.getPosition()` / `getDuration()` ticks
 *  - `onBuffering` / `onSeeking` / `onSeekable` / `onCacheState`
 *    events
 *
 * Outside a provider, returns `DEFAULT_PROGRESS` (`0/0` + falsy
 * progress fields).
 */
export function usePlayerProgress(): PlayerProgress {
  const progress = useContext(PlayerProgressContext);
  return progress ?? DEFAULT_PROGRESS;
}

// ═══════════════════════════════════════════════════════════════════════════
// Internal: state hydrate + event dispatch (used by PlayerProvider)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Internal: hydrate `PlayerState` from synchronous bridge getters.
 * Called once on `<PlayerProvider>` mount to seed the state before
 * any mpv events have had a chance to fire.
 *
 * Each getter is wrapped in its own try/catch — a partially-wired
 * bridge (jest, web preview) should not throw out of hydration.
 * On the no-op fallback bridge, every getter returns its
 * documented zero value, so the resulting state equals
 * `DEFAULT_STATE`.
 */
export function hydratePlayerState(
  bridge: ReturnType<typeof getMpvPlayerModule>,
): PlayerState {
  const state: PlayerState = { ...DEFAULT_STATE };

  // Position + duration + playback state
  try {
    const pos = bridge.getPosition();
    if (Number.isFinite(pos) && pos >= 0) {
      state.positionMs = Math.round(pos * 1000);
    }
  } catch {
    // bridge not fully wired; leave default
  }
  try {
    const dur = bridge.getDuration();
    if (Number.isFinite(dur) && dur >= 0) {
      state.durationMs = Math.round(dur * 1000);
    }
  } catch {
    // ignore
  }
  try {
    const ps: MpvPlaybackState = bridge.getPlaybackState();
    state.isPlaying = ps === 'playing';
  } catch {
    // ignore
  }

  // Volume / mute / speed / loop
  try {
    state.volume = bridge.getVolume();
  } catch {
    // ignore
  }
  try {
    state.isMuted = bridge.getMuted();
  } catch {
    // ignore
  }
  try {
    state.speed = bridge.getSpeed();
  } catch {
    // ignore
  }
  try {
    state.loopMode = bridge.getLoopMode();
  } catch {
    // ignore
  }

  // Title + artist + album (via media-title + metadata property)
  try {
    const title = bridge.getProperty('media-title');
    if (title) {
      state.title = title;
    }
  } catch {
    // ignore
  }
  try {
    const metadataJson = bridge.getProperty('metadata');
    const meta = parseMetadata(metadataJson);
    if (meta.title && state.title === 'Simba Player') {
      state.title = meta.title;
    }
    if (meta.artist) {
      state.artist = meta.artist;
    }
    if (meta.album) {
      state.album = meta.album;
    }
  } catch {
    // ignore
  }

  // Playlist + current index
  try {
    const playlistJson = bridge.getPlaylist();
    const parsed = JSON.parse(playlistJson);
    if (Array.isArray(parsed)) {
      state.playlist = parsed as PlaylistEntry[];
    }
  } catch {
    // ignore
  }
  try {
    const pos = Number(bridge.getProperty('playlist-playing-pos'));
    if (Number.isFinite(pos) && pos >= 0) {
      state.currentIndex = pos;
    }
  } catch {
    // ignore
  }

  // Tracks
  try {
    const tracksJson = bridge.getTracks();
    const parsed = JSON.parse(tracksJson);
    if (Array.isArray(parsed)) {
      state.tracks = parsed as MpvTrack[];
    }
  } catch {
    // ignore
  }

  // Chapters + current chapter
  try {
    const chaptersJson = bridge.getChapters();
    const parsed = JSON.parse(chaptersJson);
    if (Array.isArray(parsed)) {
      state.chapters = parsed as MpvChapter[];
    }
  } catch {
    // ignore
  }
  try {
    const chapterJson = bridge.getCurrentChapter();
    if (chapterJson && chapterJson !== '{}') {
      const parsed = JSON.parse(chapterJson);
      state.currentChapter = parsed as MpvChapter;
    }
  } catch {
    // ignore
  }

  // Video params
  try {
    const vpJson = bridge.getVideoParams();
    if (vpJson && vpJson !== '{}') {
      const parsed = JSON.parse(vpJson);
      state.videoParams = parsed as MpvVideoParams;
    }
  } catch {
    // ignore
  }

  return state;
}

/**
 * Internal: parse an mpv `metadata` property value (a JSON array of
 * `{key, value}` entries) into a flat `{title, artist, album}`
 * object. Unknown keys are ignored. Returns an empty object for
 * any input that fails to parse.
 */
export function parseMetadata(
  metadataJson: string,
): { title?: string; artist?: string; album?: string } {
  if (!metadataJson) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(metadataJson);
  } catch {
    return {};
  }
  if (!Array.isArray(parsed)) return {};
  const result: { title?: string; artist?: string; album?: string } = {};
  for (const entry of parsed) {
    if (entry == null || typeof entry !== 'object') continue;
    const key = (entry as { key?: unknown }).key;
    const value = (entry as { value?: unknown }).value;
    if (typeof key !== 'string' || value == null) continue;
    const str = String(value);
    switch (key) {
      case 'title':
        result.title = str;
        break;
      case 'artist':
        result.artist = str;
        break;
      case 'album':
        result.album = str;
        break;
    }
  }
  return result;
}

/**
 * Internal: apply a single mpv event to a `(state, progress)` pair
 * and return the next pair. Pure function — no React, no bridge calls.
 *
 * `state` carries the "static-ish" player state (title, isPlaying,
 * volume, tracks, etc.) and `progress` carries the "1Hz-pollable"
 * fields (position, duration, isBuffering, isSeeking, seekable,
 * cacheRanges, cacheFill). The two are kept separate so consumers
 * that only render a scrubber (using `usePlayerProgress`) don't
 * re-render on every volume/track change.
 *
 * For events that only touch one of the two, the other is returned
 * unchanged. For events that touch both, both are updated. This is
 * the canonical V13 "split-context" pattern.
 */
export function applyPlayerEvent(
  state: PlayerState,
  progress: PlayerProgress,
  event: string,
  payload: unknown,
): { state: PlayerState; progress: PlayerProgress } {
  const p = (payload ?? {}) as Record<string, unknown>;

  switch (event) {
    case 'onFileLoaded': {
      const file = (p.file ?? undefined) as MpvFileInfo | undefined;
      return {
        state: {
          ...state,
          title: file?.title ?? state.title,
          durationMs: file?.duration
            ? Math.round(file.duration * 1000)
            : state.durationMs,
          isPlaying: true,
          positionMs: 0,
          error: null, // clear any prior error
        },
        progress: {
          ...progress,
          positionMs: 0,
          durationMs: file?.duration
            ? Math.round(file.duration * 1000)
            : progress.durationMs,
        },
      };
    }
    case 'onPlaybackStateChanged':
      return { state: { ...state, isPlaying: (p.state as MpvPlaybackState) === 'playing' }, progress };
    case 'onPositionChanged': {
      const positionMs = Math.round(((p.position as number) ?? 0) * 1000);
      return {
        state: { ...state, positionMs },
        progress: { ...progress, positionMs },
      };
    }
    case 'onDurationChanged': {
      const durationMs = Math.round(((p.duration as number) ?? 0) * 1000);
      return {
        state: { ...state, durationMs },
        progress: { ...progress, durationMs },
      };
    }
    case 'onPropertyChanged': {
      const property = String(p.property ?? '');
      const value = p.value;
      switch (property) {
        case 'media-title':
          return { state: { ...state, title: String(value ?? '') }, progress };
        case 'volume':
          return { state: { ...state, volume: Number(value) }, progress };
        case 'mute':
          return { state: { ...state, isMuted: Boolean(value) }, progress };
        case 'speed':
          return { state: { ...state, speed: Number(value) }, progress };
        case 'loop-file':
          // mpv's loop-file is a boolean; the unified loopMode combines
          // it with loop-playlist. We only mutate when this property
          // turns ON — turning OFF defers to loop-playlist (if it's
          // also off, the next hydration will reset to 'none').
          if (value) return { state: { ...state, loopMode: 'file' }, progress };
          return { state, progress };
        case 'loop-playlist':
          if (value) return { state: { ...state, loopMode: 'playlist' }, progress };
          return { state, progress };
        case 'metadata': {
          const meta = parseMetadata(String(value ?? ''));
          return {
            state: {
              ...state,
              ...(meta.title ? { title: meta.title } : {}),
              ...(meta.artist ? { artist: meta.artist } : {}),
              ...(meta.album ? { album: meta.album } : {}),
            },
            progress,
          };
        }
        case 'playlist': {
          try {
            const parsed = JSON.parse(String(value ?? '[]'));
            if (Array.isArray(parsed)) {
              return { state: { ...state, playlist: parsed as PlaylistEntry[] }, progress };
            }
          } catch {
            // ignore — bad payload
          }
          return { state, progress };
        }
        case 'playlist-playing-pos':
          return { state: { ...state, currentIndex: Number(value) }, progress };
        default:
          return { state, progress };
      }
    }
    case 'onTracksChanged':
      return { state: { ...state, tracks: (p.tracks as MpvTrack[]) ?? [] }, progress };
    case 'onChapterChanged':
      return { state: { ...state, currentChapter: (p.chapter as MpvChapter | null) ?? null }, progress };
    case 'onVideoParamsChanged':
      return { state: { ...state, videoParams: (p.params as MpvVideoParams) ?? null }, progress };
    case 'onError':
      return {
        state: {
          ...state,
          error: {
            code: Number(p.code ?? 0),
            recoverable: Boolean(p.recoverable ?? false),
            message: String(p.message ?? ''),
          },
        },
        progress,
      };
    case 'onBuffering': {
      // `isBuffering` is the more useful consumer signal than `percent`;
      // honor the explicit flag if present, otherwise treat any
      // non-zero percent as buffering.
      const isBuffering =
        typeof p.isBuffering === 'boolean'
          ? p.isBuffering
          : ((p.percent as number) > 0 && (p.percent as number) < 100);
      return {
        state: { ...state, isBuffering },
        progress: { ...progress, isBuffering },
      };
    }
    case 'onCacheState':
      // Cache state is progress-only — no state field, just progress
      // updates for consumers that render a cache indicator.
      return {
        state,
        progress: {
          ...progress,
          cacheRanges: (p.ranges as Array<{ start: number; end: number }>) ?? [],
          cacheFill: Number(p.fill ?? 0),
        },
      };
    case 'onSeekable':
      return {
        state: { ...state, seekable: Boolean(p.seekable) },
        progress: { ...progress, seekable: Boolean(p.seekable) },
      };
    case 'onSeeking':
      return {
        state: { ...state, isSeeking: Boolean(p.seeking) },
        progress: { ...progress, isSeeking: Boolean(p.seeking) },
      };
    case 'onEndFile':
      return { state: { ...state, isPlaying: false }, progress };
    case 'onPlaybackRestart':
      return {
        state: { ...state, isPlaying: true, positionMs: 0 },
        progress: { ...progress, positionMs: 0 },
      };
    case 'onEndReached':
      return { state: { ...state, isPlaying: false }, progress };
    case 'onAudioDeviceChanged':
    case 'onVolumeChanged':
      return {
        state: { ...state, volume: Number(p.volume ?? state.volume) },
        progress,
      };
    case 'onSpeedChanged':
      return {
        state: { ...state, speed: Number(p.speed ?? state.speed) },
        progress,
      };
    case 'videoReconfig':
    case 'onPipModeChanged':
    case 'onPipPlayPause':
    case 'onPipExpand':
    case 'onPipClose':
      // No state-field mapping for these in the V13 surface (PiP state
      // is owned by the activity; reconfig signals a video-parameter
      // change that's already covered by onVideoParamsChanged).
      return { state, progress };
    default:
      return { state, progress };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Internal: context providers
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The state + progress contexts are exported here so the
 * `<PlayerStateProvider>` component (in `PlayerProvider.tsx`)
 * can import them. The component itself is a JSX component, so
 * it has to live in a `.tsx` file — we keep the contexts in
 * this `.ts` file so non-JSX consumers (DefaultControls,
 * `usePlayer`, etc.) can import them without forcing the JSX
 * transform on the whole module.
 */
