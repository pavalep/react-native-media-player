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
  applyForceMediaTitle,
  applyStartPosition,
} from '../bridge/MpvPlayerModule';
import { loadAndPlay } from '../bridge/loadAndPlay';

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
 *  - `positionMs`   — `onPositionChanged` + hydration (the native event
 *                     stream is authoritative; there is no position poll)
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
  /**
   * True while a load is IN FLIGHT: the engine has been asked for a file
   * and has not reported it yet. v1.17.0.
   *
   * This is the "the file is opening" fact, and it belongs to the lib
   * because no consumer can derive it. mpv's core state is "playing"
   * from the moment `loadfile` is called until the file has been
   * parsed, so a phase derived from `isPlaying` can never tell
   * "opening" from "playing" — and the playlist is not populated yet
   * either, so "idle" is just as wrong.
   *
   * Device evidence (2026-10-20): a 9-second load over a throttled link
   * showed NO loading indicator at all, because neither of the two
   * available phases was the truth.
   */
  isLoading: boolean;
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
  /**
   * Last error reported by mpv. Cleared on the next `onFileLoaded`.
   *
   * `code` is the lib's stable NUMERIC code. It is never a string: the
   * native payload used to carry one, so `Number("E_RENDERER_GONE")`
   * was NaN and every failure reached the app with `code: NaN`.
   * `codeName` is the readable string (`E_LOAD_FAILED`, …).
   *
   * `recoverable` means "PLAYBACK CONTINUED". false = the failure ended
   * playback (mpv's END_FILE — the file failed). true = the engine
   * complained but kept playing, so it is a degradation, not a failure.
   * v1.17.0.
   */
  error: { code: number; codeName?: string; recoverable: boolean; message: string } | null;

  /** Whether playlist shuffle is currently enabled. mpv `playlist-shuffle`. */
  shuffle: boolean;
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
 * progress context from the native mpv event stream — position and
 * duration arrive on the property events (4 Hz after native
 * coalescing), and `isBuffering` / `isSeeking` / `seekable` /
 * `cacheRanges` / `cacheFill` each have their own dedicated event —
 * plus a one-shot hydration read at mount.
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
  /**
   * Buffered timeline ranges, in MILLISECONDS, relative to the stream start.
   *
   * The same unit as `positionMs` and `durationMs`, so a consumer never
   * has to know that mpv's own `seekable-ranges` is in seconds — the
   * native bridge converts, because it is the only layer that knows which
   * unit a payload carried.
   *
   * Empty when the source exposes no time-space cache information. A byte
   * offset is NOT a time and is never reported here: a range painted from
   * byte offsets would claim that unbuffered data is buffered.
   */
  cacheRanges: Array<{ start: number; end: number }>;
  /**
   * Cache fill percent (0..100). From the dedicated `onCacheFill`
   * event, which the native bridge feeds from mpv's
   * `cache-buffering-state`.
   *
   * It is a LEVEL, not a stall: a partially filled cache is the
   * normal state during playback. `isBuffering` is owned by
   * `onBuffering` (mpv's `paused-for-cache`), so the two can never
   * contradict each other.
   */
  cacheFill: number;
}

/**
 * V13 Phase 51: expanded `PlayerCommands`. The V12 surface (5 methods)
 * is preserved; the new methods map to the additional 73 native bridge
 * methods that consumers use (volume, mute, speed, loop, tracks, PiP,
 * brightness, openPlayer, etc.).
 *
 * All methods resolve the bridge lazily at call time, so a stable
 * command object is built once at module load. The event-driven
 * progress context and the heavy event-subscription state context
 * are separate from the commands.
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
  /**
   * Stop playback AND tear the foreground service down (notification
   * dismissed, media session released). This is what "close" means.
   */
  stopPlayback(): void;
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
  /**
   * Load a single media file.
   *
   * `title` (v1.9.3) is applied as mpv's `force-media-title` BEFORE the
   * load, so `media-title` — and therefore `PlayerState.title` — carries
   * the real name of the media rather than a URL fragment. Omit it and
   * mpv derives its own title as before.
   *
   * The file starts at the beginning. mpv's `start` option is persistent,
   * so this entry point writes `0` before the load — otherwise the last
   * resume position would be carried into whatever file is loaded next.
   * To start at a position, use the launch path (`useLaunchPlayback`),
   * which owns the resume position.
   */
  loadFile(uri: string, title?: string): void;
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
  /** Cycle to the next/previous track of the given type. */
  cycleTrack(type: 'video' | 'audio' | 'sub'): void;
  /**
   * Set the active track for a type (trackId < 0 means "no track").
   *
   * `selectTrack(trackId)` was REMOVED. It carried no track type, and its
   * native implementation hardcoded mpv's "vid" property, so selecting a
   * subtitle retargeted the VIDEO track. Use `setTrack(type, trackId)`
   * instead — it maps video/audio/sub to vid/aid/sid and handles disabling
   * via a negative id.
   */
  setTrack(type: 'video' | 'audio' | 'sub', trackId: number): void;

  // PiP
  /**
   * Enter Picture-in-Picture mode.
   *
   * `chapterTitle` and `progressPct` are shown in the PiP notification.
   * They are optional HERE, but the native TurboModule method takes two
   * arguments and TurboModule enforces its arity — so the bridge call
   * always passes two, never zero. See `enterPip` in the command
   * implementation below.
   *
   * Returns whether the OS ACCEPTED the request. This is not a nicety: the
   * caller suppresses its fullscreen chrome when PiP is up, so a request
   * that was refused — no activity, PiP not permitted, a bad `PictureInPictureParams`
   * — and went unreported left the app in "PiP" mode with no chrome and no
   * way back. The native `enterPictureInPictureMode` knows the answer, so
   * it is relayed instead of guessed.
   *
   * `false` means PiP did NOT happen. It does not mean the app is in a bad
   * state: the caller keeps its chrome, exactly as before the request.
   */
  enterPip(chapterTitle?: string | null, progressPct?: string | null): boolean;
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

  // Playback launch
  /**
   * Launch the given media. `audio` starts the foreground media service;
   * `video` loads into the consumer's already-mounted surface and
   * resolves `false` when no surface is mounted, rather than starting
   * playback nobody can see.
   *
   * V21 F5: video no longer hands off to a dedicated `PlayerActivity`.
   * The signature is unchanged — the video lane's destination is.
   */
  openPlayer(opts: {
    uri: string;
    title: string;
    type: 'video' | 'audio';
    startPositionMs?: number;
  }): Promise<boolean>;

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

  // ── V22.0.0 / 1.6.0 additions ───────────────────────────────────────────
  /**
   * Get the current `Window.LayoutParams.screenBrightness` (0..1).
   * The window may also pass the value through to the Activity-relative
   * brightness. Returns 1.0 for the no-op fallback bridge.
   *
   * Added because the V19 vertical-swipe chrome needs a readback to
   * render the brightness indicator pill. Previously reachable only via
   * the `getMpvPlayerModule()` escape hatch.
   */
  getScreenBrightness(): number;

  /**
   * V21 — place the video surface at an absolute rect (device pixels).
   *
   * Layout bounds only. Never reparents or remounts the view, so the Surface
   * is not destroyed and mpv does not re-attach — which is what makes an
   * in-app mini player possible without a black flash.
   *
   * Resolves `false` when nothing took effect. Callers must treat `false` as
   * "the surface is not where I asked for it" rather than proceeding as if
   * the video were on screen.
   */
  setVideoBounds(
    x: number,
    y: number,
    width: number,
    height: number,
  ): Promise<boolean>;
  /** Expand the video surface to fill its container. Resolves `false` if it did not. */
  fillVideoBounds(): Promise<boolean>;
  /**
   * Show or hide the video surface. Hidden is the correct state for
   * audio-only playback — mpv keeps running with no render target.
   */
  setSurfaceVisible(visible: boolean): Promise<boolean>;
  /** Whether a video surface is mounted and usable right now. */
  isSurfaceMounted(): boolean;

  /**
   * Toggle an mpv audio filter. Backed by `--af-add` / `--af-remove`.
   * Examples: `setAudioFilter('scaletempo2=max-speed=32.0', true)` enables
   * skip-silence's `scaletempo2` audio filter. Setting `enabled=false`
   * removes the named filter.
   */
  setAudioFilter(filter: string, enabled: boolean): void;

  /**
   * Toggle an mpv video filter. Backed by `--vf-add` / `--vf-remove`.
   * Examples: `setVideoFilter('scale=720:trunc(ow/a/2)*2', true)` caps
   * output height at 720p via a scale filter. Setting `enabled=false`
   * removes the named filter.
   */
  setVideoFilter(filter: string, enabled: boolean): void;

  /**
   * Enable or disable playlist shuffle. Backed by `--playlist-shuffle`.
   * Toggles the same state surfaced in mpv via the boolean
   * `playlist-shuffle` property. State is mirrored on
   * `state.shuffle` via the `onPropertyChanged` event channel.
   */
  setShuffle(enabled: boolean): void;
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
  isLoading: false,
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
  shuffle: false,
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
 * Coerce a JS value into the single string form the native bridge accepts.
 *
 * ## Why this exists
 *
 * `MpvBridgeModule.setProperty(name: String, value: String)` declares both
 * arguments as Kotlin `String`, and React Native's JS→native argument
 * marshalling *throws* rather than coercing: passing a number produces
 *
 *   `Expected argument 1 of method "setProperty" to be a string,
 *    but got a number (24.000000)`
 *
 * which surfaces as a red-box `Exception in HostFunction` and takes the
 * whole React tree down — not as a rejected promise or a no-op.
 *
 * The public `PlayerCommands.setProperty(name, value: unknown)` signature
 * (and its `MpvPlayerModuleBridge.setProperty` docstring) already promise
 * that the value is "stringified before sending", but nothing did the
 * stringifying. So the type said `unknown` and the runtime demanded
 * `string`: every numeric caller crashed, including this module's own
 * `seekToChapter` (`setProperty('chapter', index)`).
 *
 * ## Why coercion belongs here
 *
 * mpv's property API is textual — `mpv_set_property_string` parses the
 * value against the property's declared type — so producing the string is
 * this layer's job, not the caller's. Doing it once, at the single point
 * where the command crosses into the bridge, means:
 *
 *  - no caller has to remember a rule that is invisible in its own code,
 *  - `chapter=3` and `sub-font-size=24` both mean what they look like,
 *  - the documented `unknown` signature is finally honest.
 *
 * `null`/`undefined` become the empty string, which mpv reads as "reset
 * to default" for string-valued properties — the closest analogue of the
 * JS value, and far better than the literal text `"undefined"`.
 * Objects and arrays are JSON-encoded because mpv has no other textual
 * form for a structured option (`vf`/`af` parameter lists).
 */
export function toMpvPropertyString(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    // Circular / non-serialisable. mpv has no representation for it, so
    // send empty rather than crash the caller.
    return '';
  }
}

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
    /**
     * The full teardown: engine + foreground service. Distinct from
     * `stop()`, which only halts the engine and leaves the session and
     * notification alive — correct for "pause the media, keep the
     * transport available", wrong for "close the player".
     */
    stopPlayback: () => {
      dlog('commands.stopPlayback()');
      getMpvPlayerModule().stopPlayback();
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
      getMpvPlayerModule().setProperty('chapter', String(index));
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

    loadFile: (uri: string, title?: string) => {
      // v1.9.3 — the launch TITLE is applied here, and this is the fix
      // for a long-standing defect: `openPlayer({uri, title})` accepted a
      // title and handed it to `PlayerActivity`, and then NOTHING ever
      // applied it. `onFileLoaded`'s handler reads `file?.title` from a
      // native payload that has no `file` key, and `media-title` was
      // missing from OBSERVED_PROPERTIES — so `PlayerState.title` stayed
      // pinned at the `DEFAULT_STATE` placeholder and every consumer
      // rendered "Simba Player" no matter what was playing.
      //
      // `force-media-title` is mpv's own option for exactly this. The
      // set-then-load ordering is the contract — see the helper.
      applyForceMediaTitle(getMpvPlayerModule(), title);
      // This entry point has no start position, so the file starts at the
      // beginning — and mpv's `start` option is persistent, so it MUST be
      // written here too. Leaving it would carry the last resume position
      // into whatever file is loaded next.
      applyStartPosition(getMpvPlayerModule(), 0);
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

    cycleTrack: (type: 'video' | 'audio' | 'sub') => {
      dlog('commands.cycleTrack(', type, ')');
      getMpvPlayerModule().cycleTrack(type);
    },
    setTrack: (type: 'video' | 'audio' | 'sub', trackId: number) => {
      dlog('commands.setTrack(', type, ',', trackId, ')');
      getMpvPlayerModule().setTrack(type, trackId);
    },

    enterPip: (chapterTitle, progressPct) => {
      dlog('commands.enterPip(', chapterTitle, ',', progressPct, ')');
      // The native method has arity 2 and TurboModule ENFORCES it, so
      // this call must always pass two arguments. Passing zero threw:
      //
      //   Exception in HostFunction: TurboModule method "enterPip"
      //   called with 0 arguments (expected argument count: 2)
      //
      // The Kotlin side is nullable, so `null` is the right "not
      // supplied" value — the native falls back to a title and a
      // progress string of its own.
      //
      // The result is the OS's own answer to "did PiP happen?". It used
      // to be dropped, which meant a REFUSED request (no activity, PiP
      // not permitted, a bad PictureInPictureParams) was indistinguishable
      // from a successful one — and a caller that suppresses its chrome
      // on the strength of a successful request was then stuck with no
      // chrome and no way back. Relaying the answer is the whole fix.
      return getMpvPlayerModule().enterPip(
        chapterTitle ?? null,
        progressPct ?? null,
      );
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
      const bridge = getMpvPlayerModule();
      const startPositionMs = opts.startPositionMs ?? 0;

      if (opts.type === 'audio') {
        return bridge.startAudioPlayback({
          uri: opts.uri,
          title: opts.title,
          startPositionMs,
          autoPlay: true,
        });
      }

      // Video: refuse when there is no surface rather than loading into
      // nothing. See `usePlayerActivity.openPlayer` for why.
      if (!bridge.isSurfaceMounted()) {
        return false;
      }
      loadAndPlay(bridge, {uri: opts.uri, title: opts.title, startPositionMs});
      return true;
    },

    getProperty: (name: string) => {
      dlog('commands.getProperty(', name, ')');
      return getMpvPlayerModule().getProperty(name);
    },
    setProperty: (name: string, value: unknown) => {
      const encoded = toMpvPropertyString(value);
      dlog('commands.setProperty(', name, ',', encoded, ')');
      getMpvPlayerModule().setProperty(name, encoded);
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

    // V22.0.0 / 1.6.0 additions
    getScreenBrightness: () => {
      dlog('commands.getScreenBrightness()');
      return getMpvPlayerModule().getScreenBrightness();
    },
    // V21 single-Activity surface control
    setVideoBounds: (x, y, width, height) => {
      dlog('commands.setVideoBounds(', x, y, width, height, ')');
      return getMpvPlayerModule().setVideoBounds(x, y, width, height);
    },
    fillVideoBounds: () => {
      dlog('commands.fillVideoBounds()');
      return getMpvPlayerModule().fillVideoBounds();
    },
    setSurfaceVisible: (visible) => {
      dlog('commands.setSurfaceVisible(', visible, ')');
      return getMpvPlayerModule().setSurfaceVisible(visible);
    },
    isSurfaceMounted: () => {
      dlog('commands.isSurfaceMounted()');
      return getMpvPlayerModule().isSurfaceMounted();
    },
    setAudioFilter: (filter: string, enabled: boolean) => {
      dlog('commands.setAudioFilter(', filter, ',', enabled, ')');
      getMpvPlayerModule().setAudioFilter(filter, enabled);
    },
    setVideoFilter: (filter: string, enabled: boolean) => {
      dlog('commands.setVideoFilter(', filter, ',', enabled, ')');
      getMpvPlayerModule().setVideoFilter(filter, enabled);
    },
    setShuffle: (enabled: boolean) => {
      dlog('commands.setShuffle(', enabled, ')');
      // `playlist-shuffle` is an mpv *integer* option, so the boolean is
      // encoded as 1/0 rather than as a textual flag — "yes"/"true" is
      // not a value mpv's int parser accepts for this property.
      getMpvPlayerModule().setProperty(
        'playlist-shuffle',
        enabled ? '1' : '0',
      );
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
 * driven by mpv events (via `subscribePlayerEvent`) plus a one-shot
 * hydration read at mount. Outside a provider, `state` is
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
 *  - the native mpv event stream (position, duration, volume, …)
 *  - `onBuffering` / `onSeeking` / `onSeekable` / `onCacheState` /
 *    `onCacheFill` events
 *  - a one-shot hydration read at mount
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
  try {
    const shuffleStr = bridge.getProperty('playlist-shuffle');
    state.shuffle = shuffleStr === 'yes' || shuffleStr === 'true';
  } catch {
    // ignore
  }

  // Title + artist + album (via media-title + metadata property)
  try {
    const title = bridge.getProperty('media-title');
    // V22.0.0 / 1.5.8 (D-035 fix #2): mpv returns the JSON literal
    // `null` (which crosses the JS bridge as the four-character
    // string `"null"`) when no media is loaded. The previous
    // `if (title)` truthiness check happily overwrote our
    // 'Simba Player' default with `"null"`, surfacing as a
    // header reading literally `null` (D-035 user regression).
    // Filter the mpv sentinel out before assigning.
    if (title && title !== 'null') {
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
 * volume, tracks, etc.) and `progress` carries the fast-moving
 * fields (position, duration, isBuffering, isSeeking, seekable,
 * cacheRanges, cacheFill). The two are kept separate so consumers
 * that only render a scrubber (using `usePlayerProgress`) don't
 * re-render on every volume/track change.
 *
 * For events that only touch one of the two, the other is returned
 * unchanged. For events that touch both, both are updated. This is
 * the canonical V13 "split-context" pattern.
 */
/**
 * Parse an mpv FLAG value into a boolean, or `null` when it is not one.
 *
 * mpv serialises `MPV_FORMAT_FLAG` to the JSON literals `true` /
 * `false`, which reach JS as the STRINGS `"true"` / `"false"`.
 * `Boolean("false")` is `true`, so any flag read with `Boolean()` is
 * silently inverted — the `mute` case did exactly that and shipped a
 * mute control that reported the opposite of reality.
 *
 * A real boolean is accepted too, because `getMuted()` on the bridge
 * returns an actual `boolean` while the event payload is a string, and
 * the two feed the same field.
 *
 * Anything else — `"null"` for an unavailable property, `""` from the
 * NOOP bridge, `undefined` — is not a value. The caller leaves the
 * field unchanged rather than coercing it, because guessing here would
 * report a state the player is not in.
 */
function parseMpvFlag(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}

/** Apply a `mute` flag event, leaving the field alone if unreadable. */
function applyMuteFlag(state: PlayerState, value: unknown): PlayerState {
  const isMuted = parseMpvFlag(value);
  if (isMuted === null || isMuted === state.isMuted) return state;
  return { ...state, isMuted };
}

export function applyPlayerEvent(
  state: PlayerState,
  progress: PlayerProgress,
  event: string,
  payload: unknown,
): { state: PlayerState; progress: PlayerProgress } {
  const p = (payload ?? {}) as Record<string, unknown>;

  switch (event) {
    case 'onLoadRequested': {
      // The engine has been asked for a file and has not reported it
      // yet: the file is OPENING. This is the window a loading
      // indicator belongs to, and it is the reason `isLoading` exists —
      // see `PlayerState.isLoading`.
      return { state: { ...state, isLoading: true }, progress };
    }
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
          // The file has arrived, so the load is no longer in flight.
          isLoading: false,
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
        case 'media-title': {
          // v1.9.3 — this adopted ANY value, including mpv's "no title"
          // sentinel.
          //
          // A null string crosses the JSON boundary as the FOUR-CHARACTER
          // LITERAL "null", so `String(value ?? '')` produced a player
          // header reading `null` — the same regression D-035 already
          // fixed on the `onFileLoaded` path, which filters it there. The
          // property path never got the same guard, so registering
          // `media-title` (1.9.3) would have traded one wrong title for
          // another.
          //
          // The rule is the same on both paths: an unrecognised title
          // leaves the field alone rather than replacing a good one.
          const title = String(value ?? '');
          if (!title || title === 'null') break;
          return { state: { ...state, title }, progress };
        }
        case 'volume':
          return { state: { ...state, volume: Number(value) }, progress };
        case 'mute':
          // A FLAG property arrives as the JSON literal `"true"` /
          // `"false"` — a STRING, not a boolean. `Boolean("false")` is
          // `true`, because every non-empty string is truthy, so the
          // obvious one-liner INVERTED the state: every mute event
          // reported the opposite of what mpv said.
          //
          // Measured on device (emulator-5554, SIMBA W8.3 + lib 1.9.1):
          // native logged `name=mute value=false` and the bridge
          // dispatched `value=false`, yet the app's transport rendered
          // "Unmute" while the player was audible. The mute control read
          // as permanently inverted.
          //
          // Parsed explicitly, and anything unrecognised leaves the
          // field alone rather than guessing — the same rule the
          // `seekable` level seed and `hydratePlayerState` follow.
          return { state: applyMuteFlag(state, value), progress };
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
        case 'playlist-shuffle':
          return {
            state: { ...state, shuffle: value === 'yes' || value === true },
            progress,
          };
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
    case 'onError': {
      // The native payload carries a NUMERIC `code` (the lib's stable
      // integer contract) and a string `codeName`.
      //
      // It used to carry a STRING `code`, so `Number("E_RENDERER_GONE")`
      // was NaN and every failure reached the app with `code: NaN` and
      // `numeric=0`. A non-finite value now degrades to 0 rather than
      // poisoning the contract.
      const rawCode = Number(p.code);
      const code = Number.isFinite(rawCode) ? rawCode : 0;
      const recoverable = Boolean(p.recoverable ?? false);
      const error = {
        code,
        codeName: p.codeName != null ? String(p.codeName) : undefined,
        recoverable,
        message: String(p.message ?? ''),
      };
      // A NON-terminal failure must not mask a terminal one.
      //
      // mpv can report a fatal-level LOG line (a subsystem complaint,
      // playback continued) AFTER the file has already failed, and the
      // last error to arrive is not necessarily the one that ended
      // playback. A terminal error stays until the next `onFileLoaded`
      // clears it — except for a newer TERMINAL error, which wins, so a
      // retry that fails again reports the new failure and not the
      // previous one.
      const keepTerminal =
        recoverable && state.error != null && !state.error.recoverable;
      return {
        state: {
          ...state,
          error: keepTerminal ? state.error : error,
        },
        progress,
      };
    }
    case 'onBuffering': {
      // The STALL signal, and the only thing that may set `isBuffering`.
      //
      // It comes from mpv's `paused-for-cache`, which is true exactly while
      // playback is paused because the cache underran. The payload carries
      // no percentage: the property does not know the fill, and the old
      // code invented one (0 when stalled, 100 when not) which overwrote
      // the real fill with a fabricated number.
      //
      // The percent-based inference is gone with the percent. A partially
      // filled cache is the NORMAL state during playback, so
      // "percent < 100" is true for most of a stream's life — reading it
      // as "buffering" latched the spinner on during healthy playback.
      const isBuffering = Boolean(p.isBuffering);
      return {
        state: { ...state, isBuffering },
        progress: { ...progress, isBuffering },
      };
    }
    case 'onCacheFill': {
      // The cache FILL LEVEL — a percentage, not a stall. It comes from
      // mpv's `cache-buffering-state`, which changes continuously as the
      // cache refills, so it is a level and nothing else.
      //
      // It owns `cacheFill` and nothing else. `isBuffering` belongs to
      // `onBuffering`, and `cacheRanges` belongs to `onCacheState`. One
      // fact, one owner — the old code had two properties writing one
      // field with contradictory rules, and they disagreed.
      const percent = Number(p.percent ?? 0);
      return {
        state,
        progress: {
          ...progress,
          cacheFill: Number.isFinite(percent) ? percent : 0,
        },
      };
    }
    case 'onCacheState': {
      // The buffered TIMELINE ranges, in MILLISECONDS.
      //
      // They come from mpv's `demuxer-cache-state.seekable-ranges`, which is
      // in seconds; the native bridge converts to milliseconds because it
      // is the only layer that knows which unit the payload carried. The
      // consumer receives one unit — the same one `positionMs` and
      // `durationMs` use — and never has to guess.
      //
      // A payload that carries no `ranges` at all leaves the previous value
      // alone. A payload that carries an EMPTY array is authoritative and
      // clears: that is mpv saying the cache is empty, which is different
      // from saying nothing.
      const ranges = p.ranges as
        | Array<{ start: number; end: number }>
        | undefined;
      return {
        state,
        progress: {
          ...progress,
          cacheRanges: Array.isArray(ranges) ? ranges : progress.cacheRanges,
        },
      };
    }
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
      // The file is over (ended, or failed). No load is in flight.
      return { state: { ...state, isPlaying: false, isLoading: false }, progress };
    case 'onPlaybackRestart':
      // mpv fires this when playback (re)starts — including right after a
      // seek. The POSITION belongs to `time-pos` and to nothing else: a new
      // file resets it in the `onFileLoaded` branch above. Zeroing it here
      // restarted the transport bar's clock at 0:00 while the video sat at
      // the position the user had just seeked to (or resumed to).
      return {
        state: { ...state, isPlaying: true },
        progress,
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
