import { NativeEventEmitter, NativeModules } from 'react-native';

/**
 * Phase 39 debug-mode flag. `__DEV__` is set by React Native (true for
 * debug builds, false for release). Use this to gate verbose
 * console.log calls so they don't ship to release builds (which
 * Metro strips + which would leak sensitive data on production
 * devices).
 */
declare const __DEV__: boolean | undefined;
const IS_DEV: boolean = typeof __DEV__ === 'boolean' ? __DEV__ : false;

/**
 * Phase 39: debug log helper. Logs only when:
 *  1. The consumer has called `setDebugLogging(true)` via the bridge
 *  2. The build is a debug build (`__DEV__ === true`)
 *  3. `console.debug` exists (it always does in RN, but TS doesn't know)
 *
 * The flag is module-scoped (not a React context) because logs
 * happen outside React's render cycle (from `useEffect` cleanups,
 * bridge callbacks, error handlers, etc.).
 */
let _debugLoggingEnabled = false;

function dlog(...args: unknown[]): void {
  if (!_debugLoggingEnabled || !IS_DEV) return;
  // eslint-disable-next-line no-console
  console.log('[SimbaPlayer]', ...args);
}

// ═══════════════════════════════════════════════════════════════════════════
// Event types (V13 Phase 50c)
// ═══════════════════════════════════════════════════════════════════════════

/** Playback state values emitted on `onPlaybackStateChanged`. */
export type MpvPlaybackState = 'idle' | 'playing' | 'paused' | 'stopped' | 'error';

/** Loop mode values used by `setLoopMode` / `getLoopMode`. */
export type MpvLoopMode = 'none' | 'file' | 'playlist';

/** mpv track metadata. */
export interface MpvTrack {
  readonly id: number;
  readonly type: 'video' | 'audio' | 'sub';
  readonly title?: string;
  readonly lang?: string;
  readonly default: boolean;
  readonly selected: boolean;
  readonly codec?: string;
}

/** mpv chapter metadata. */
export interface MpvChapter {
  readonly id: number;
  readonly title: string;
  readonly startTime: number;
  readonly endTime: number;
}

/** mpv file info (from `getFileInfo`). */
export interface MpvFileInfo {
  readonly path: string;
  readonly title: string;
  readonly duration: number;
}

/** mpv video params (from `getVideoParams`). */
export interface MpvVideoParams {
  readonly videoWidth: number;
  readonly videoHeight: number;
  readonly aspectRatio: number;
  readonly fps: number;
  readonly codec: string;
}

/** mpv audio device. */
export interface MpvAudioDevice {
  readonly name: string;
  readonly description: string;
  readonly isDefault: boolean;
}

/** Launch params shared with `PlayerActivity` via `getLaunchParams`. */
export interface LaunchParams {
  readonly uri: string;
  readonly title: string;
  readonly type: 'video' | 'audio';
  readonly startPositionMs: number;
}

/** All 22 events emitted by the Kotlin bridge. */
export type PlayerEventName =
  | 'onFileLoaded'
  | 'onPlaybackStateChanged'
  | 'onPositionChanged'
  | 'onDurationChanged'
  | 'onPropertyChanged'
  | 'onTracksChanged'
  | 'onChapterChanged'
  | 'onVideoParamsChanged'
  | 'onError'
  | 'onBuffering'
  | 'onCacheState'
  | 'onSeekable'
  | 'onSeeking'
  | 'onEndFile'
  | 'onPlaybackRestart'
  | 'onEndReached'
  | 'onAudioDeviceChanged'
  | 'onVolumeChanged'
  | 'onSpeedChanged'
  | 'videoReconfig'
  | 'onPipModeChanged'
  | 'onPipPlayPause'
  | 'onPipExpand'
  | 'onPipClose';

/** Typed payload map for each event. */
export interface PlayerEventPayloads {
  onFileLoaded: { requestId?: string; resolvedPath?: string; file?: MpvFileInfo };
  onPlaybackStateChanged: { state: MpvPlaybackState };
  onPositionChanged: { position: number };
  onDurationChanged: { duration: number };
  onPropertyChanged: { property: string; value: unknown };
  onTracksChanged: { tracks: MpvTrack[] };
  onChapterChanged: { chapter: MpvChapter | null };
  onVideoParamsChanged: { params: MpvVideoParams };
  onError: { code: number; recoverable: boolean; message: string; requestId?: string };
  onBuffering: { percent: number; isBuffering?: boolean };
  onCacheState: { ranges: Array<{ start: number; end: number }>; fill: number };
  onSeekable: { seekable: boolean };
  onSeeking: { seeking: boolean };
  onEndFile: { reason: number; error: number; requestId?: string };
  onPlaybackRestart: Record<string, never>;
  onEndReached: Record<string, never>;
  onAudioDeviceChanged: { device: string };
  onVolumeChanged: { volume: number };
  onSpeedChanged: { speed: number };
  videoReconfig: Record<string, never>;
  onPipModeChanged: { isInPip: boolean };
  onPipPlayPause: Record<string, never>;
  onPipExpand: Record<string, never>;
  onPipClose: Record<string, never>;
}

// ═══════════════════════════════════════════════════════════════════════════
// Bridge surface (V13 Phase 50a — 78 methods)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Typed shape of the `MpvPlayerModule` native bridge as exposed by
 * `MpvBridgeModule.kt`. V13 Phase 50 expands the Phase 24 entry point
 * (9 methods) to the full 78-method surface so consumers never need to
 * reach into `NativeModules.MpvPlayerModule` directly.
 *
 * Method categories follow the Kotlin declaration order:
 *  - Lifecycle (init/destroy/getNativePtr)
 *  - Playback control (play/pause/seek/etc.)
 *  - File loading (loadFile/loadPlaylist/grantPermission/verifyUri)
 *  - Tracks + chapters
 *  - Volume + audio
 *  - Speed + loop
 *  - Property observe + get/set
 *  - Filters + playlist
 *  - State queries
 *  - Activity launch (openPlayer/getLaunchParams)
 *  - Configuration (setConfig)
 *  - PiP + screen
 *  - Orientation + immersive
 *  - Brightness
 *  - Notification
 *  - Debug
 *
 * Event subscription (`subscribePlayerEvent` / `removeAllListeners`)
 * is NOT a method on this bridge because the native module doesn't
 * expose those names directly — it has `addListener` /
 * `removeListeners` (required by React Native's `NativeEventEmitter`)
 * and the events are emitted via `RCTDeviceEventEmitter`. The module
 * wraps the emitter + adds typed event payloads; see the free
 * functions below.
 */
export interface MpvPlayerModuleBridge {
  // ── Lifecycle ──────────────────────────────────────────────────────────
  /** Initialize the mpv engine. Idempotent. Returns true on success. */
  initPlayer(): boolean;
  /** Tear down the mpv engine. */
  destroy(): void;
  /** Native pointer to the active mpv instance (used by `MpvRenderView`). */
  getNativePtr(): number;

  // ── Playback control ───────────────────────────────────────────────────
  /** Resume playback. */
  play(): void;
  /** Pause playback (mpv retains current position). */
  pause(): void;
  /** Stop playback entirely. */
  stop(): void;
  /** Toggle between play and pause. */
  togglePlayPause(): void;
  /** Seek to an absolute position in seconds. */
  seekAbsolute(positionSeconds: number): void;
  /** Skip forward N seconds. */
  seekForward(seconds: number): void;
  /** Skip backward N seconds. */
  seekBackward(seconds: number): void;
  /** Step one frame; direction 1 = forward, -1 = backward. */
  stepFrame(direction: 1 | -1): void;
  /** Capture a screenshot; returns the file path. */
  screenshot(): string;

  // ── File loading ───────────────────────────────────────────────────────
  /** Load a media file by path / URI. */
  loadFile(path: string): void;
  /** Load a media file with an attached request ID for traceability. */
  loadFileWithRequestId(path: string, requestId: string): void;
  /** Load a playlist of paths, starting at `startIndex` (default 0). */
  loadPlaylist(paths: string[], startIndex?: number): void;
  /** Get the currently-loaded file info as a JSON string. */
  getFileInfo(): string;
  /** Get the currently-loaded video params as a JSON string. */
  getVideoParams(): string;
  /** Capture a thumbnail screenshot for the given URI; returns the file path. */
  captureThumbnail(uri: string): string;
  /** Take a persistable read URI permission for a content:// URI. */
  grantPersistablePermission(uri: string): void;
  /** Returns true when the URI is still readable (content:// or file://). */
  verifyContentUri(uri: string): boolean;

  // ── Tracks ─────────────────────────────────────────────────────────────
  /** Get the mpv track list as a JSON string. */
  getTracks(): string;
  /** Select the track by ID. */
  selectTrack(trackId: number): void;
  /** Cycle to the next/previous track of the given type. */
  cycleTrack(type: 'video' | 'audio' | 'sub'): void;
  /** Set the active track for a type (trackId < 0 means "no"). */
  setTrack(type: 'video' | 'audio' | 'sub', trackId: number): void;
  /** No-op; mpv manages visibility automatically. */
  setTrackVisibility(trackType: string, visible: boolean): void;

  // ── Chapters ───────────────────────────────────────────────────────────
  /** Get the chapter list as a JSON string. */
  getChapters(): string;
  /** Seek to the next (1) or previous (-1) chapter. */
  seekChapter(direction: 1 | -1): void;
  /** Get the current chapter as a JSON string. */
  getCurrentChapter(): string;

  // ── Volume / audio ─────────────────────────────────────────────────────
  /** Set the playback volume (0..100). */
  setVolume(volume: number): void;
  /** Get the current playback volume. */
  getVolume(): number;
  /** Set the muted state. */
  setMuted(muted: boolean): void;
  /** Get the muted state. */
  getMuted(): boolean;
  /** Alias for `getMuted`. */
  isMuted(): boolean;
  /** Get the list of mpv audio devices as a JSON string. */
  getAudioDevices(): string;
  /** Switch to the given mpv audio device. */
  setAudioDevice(deviceName: string): void;
  /** Toggle the muted state. */
  toggleMute(): void;

  // ── Playback speed ─────────────────────────────────────────────────────
  /** Set the playback speed (1.0 = normal). */
  setSpeed(speed: number): void;
  /** Get the current playback speed. */
  getSpeed(): number;

  // ── Loop / repeat ──────────────────────────────────────────────────────
  /** Set the loop mode (`'none' | 'file' | 'playlist'`). */
  setLoopMode(mode: MpvLoopMode): void;
  /** Get the current loop mode. */
  getLoopMode(): MpvLoopMode;
  /** Toggle playlist loop on/off. */
  setPlaylistLoop(loop: boolean): void;

  // ── Properties (generic get/set for any mpv property) ─────────────────
  /** Get the value of an mpv property as a string. */
  getProperty(name: string): string;
  /** Set the value of an mpv property. Value is stringified before sending. */
  setProperty(name: string, value: unknown): void;
  /** Begin observing an mpv property (emits `onPropertyChanged` events). */
  observeProperty(name: string): void;
  /** Stop observing an mpv property. */
  unobserveProperty(name: string): void;

  // ── Video / audio filters ──────────────────────────────────────────────
  /** Toggle a video filter (`filter` is an mpv `vf` string). */
  setVideoFilter(filter: string, enabled: boolean): void;
  /** Toggle an audio filter (`filter` is an mpv `af` string). */
  setAudioFilter(filter: string, enabled: boolean): void;

  // ── Playlist ───────────────────────────────────────────────────────────
  /** Get the current playlist as a JSON string. */
  getPlaylist(): string;
  /** Skip to the next entry in the playlist. */
  playlistNext(): void;
  /** Skip to the previous entry in the playlist. */
  playlistPrev(): void;
  /** Remove the entry at `index` from the playlist. */
  playlistRemove(index: number): void;
  /** Shuffle the current playlist. */
  playlistShuffle(): void;
  /** Clear the current playlist. */
  playlistClear(): void;

  // ── State queries ──────────────────────────────────────────────────────
  /** Get the current playback position in seconds. */
  getPosition(): number;
  /** Get the duration of the current file in seconds. */
  getDuration(): number;
  /** Get the current playback state. */
  getPlaybackState(): MpvPlaybackState;

  // ── Activity launch (V12 Phase 3 / V13 Phase 52) ───────────────────────
  /**
   * Hand off to the dedicated `PlayerActivity`. Returns true on
   * successful `startActivity`. Rejects with `E_INVALID_TYPE`,
   * `E_NO_ACTIVITY`, `E_ACTIVITY_NOT_FOUND`, `E_SECURITY`, or
   * `E_OPEN_PLAYER_FAILED`.
   */
  openPlayer(
    uri: string,
    title: string | null,
    type: 'video' | 'audio',
    startPositionMs: number,
  ): Promise<boolean>;
  /**
   * One-shot accessor for the launch params the most recent
   * `openPlayer` call handed to `PlayerActivity`. Returns `null`
   * when called from MainActivity or after the first read has
   * already consumed the value.
   */
  getLaunchParams(): LaunchParams | null;

  // ── Configuration (V12 Phase 21) ───────────────────────────────────────
  /**
   * Push the latest PlayerConfig JSON to the native side. Resolves
   * with the count of top-level keys parsed.
   */
  setConfig(configJson: string): Promise<number>;

  // ── Picture-in-Picture ─────────────────────────────────────────────────
  /** Enter PiP mode; optional chapter title + progress percent for notification. */
  enterPip(chapterTitle?: string, progressPct?: string): void;
  /** Exit PiP by bringing the activity to the front. */
  exitPip(): void;
  /** Exit PiP and finish the activity. */
  exitPipAndFinish(): void;

  // ── Keep screen on (V12 W2.12) ──────────────────────────────────────────
  /** Toggle `FLAG_KEEP_SCREEN_ON` on the current activity window. */
  setKeepScreenOn(enabled: boolean): void;

  // ── Orientation / immersive (v11 T8.1) ─────────────────────────────────
  /**
   * Pin the activity to a fixed orientation. `'portrait'`,
   * `'landscape'`, or `'sensor'` for free rotation. Feature-detected
   * by the consumer (older builds omit this).
   */
  setOrientation(mode: 'portrait' | 'landscape' | 'sensor'): void;
  /** Toggle system bars visibility (immersive mode). Feature-detected. */
  setImmersive(enabled: boolean): void;

  // ── Screen brightness ──────────────────────────────────────────────────
  /** Set the window screen brightness (0..1). */
  setScreenBrightness(value: number): void;
  /** Get the current window screen brightness (0..1). Returns 1.0 for default. */
  getScreenBrightness(): number;

  // ── Notification permission ────────────────────────────────────────────
  /**
   * Request the `POST_NOTIFICATIONS` permission on Android 13+.
   * No-op on lower APIs. Uses the standard `PermissionsAndroid` flow.
   */
  requestNotificationPermission(): void;
  /** Returns true when the `MediaPlaybackService` foreground notification is active. */
  isNotificationActive(): boolean;

  // ── Debug (V12 Phase 39) ───────────────────────────────────────────────
  /** Toggle verbose native logging (`msg-level=all`). */
  setDebugLogging(enabled: boolean): void;
  /** Dump all observed mpv properties to logcat. Returns the count. */
  dumpObservedProperties(): number;
}

// ═══════════════════════════════════════════════════════════════════════════
// No-op fallback (V13 Phase 50b)
// ═══════════════════════════════════════════════════════════════════════════

const NOOP_BRIDGE: MpvPlayerModuleBridge = {
  // Lifecycle
  initPlayer: () => false,
  destroy: () => {},
  getNativePtr: () => 0,

  // Playback control
  play: () => {},
  pause: () => {},
  stop: () => {},
  togglePlayPause: () => {},
  seekAbsolute: (_positionSeconds: number) => {
    void _positionSeconds;
  },
  seekForward: (_seconds: number) => {
    void _seconds;
  },
  seekBackward: (_seconds: number) => {
    void _seconds;
  },
  stepFrame: (_direction: 1 | -1) => {
    void _direction;
  },
  screenshot: () => '',

  // File loading
  loadFile: (_path: string) => {
    void _path;
  },
  loadFileWithRequestId: (_path: string, _requestId: string) => {
    void _path;
    void _requestId;
  },
  loadPlaylist: (_paths: string[], _startIndex?: number) => {
    void _paths;
    void _startIndex;
  },
  getFileInfo: () => '{}',
  getVideoParams: () => '{}',
  captureThumbnail: (_uri: string) => {
    void _uri;
    return '';
  },
  grantPersistablePermission: (_uri: string) => {
    void _uri;
  },
  verifyContentUri: (_uri: string) => {
    void _uri;
    return true;
  },

  // Tracks
  getTracks: () => '[]',
  selectTrack: (_trackId: number) => {
    void _trackId;
  },
  cycleTrack: (_type: 'video' | 'audio' | 'sub') => {
    void _type;
  },
  setTrack: (_type: 'video' | 'audio' | 'sub', _trackId: number) => {
    void _type;
    void _trackId;
  },
  setTrackVisibility: (_trackType: string, _visible: boolean) => {
    void _trackType;
    void _visible;
  },

  // Chapters
  getChapters: () => '[]',
  seekChapter: (_direction: 1 | -1) => {
    void _direction;
  },
  getCurrentChapter: () => '{}',

  // Volume / audio
  setVolume: (_volume: number) => {
    void _volume;
  },
  getVolume: () => 100,
  setMuted: (_muted: boolean) => {
    void _muted;
  },
  getMuted: () => false,
  isMuted: () => false,
  getAudioDevices: () => '[]',
  setAudioDevice: (_deviceName: string) => {
    void _deviceName;
  },
  toggleMute: () => {},

  // Speed / loop
  setSpeed: (_speed: number) => {
    void _speed;
  },
  getSpeed: () => 1,
  setLoopMode: (_mode: MpvLoopMode) => {
    void _mode;
  },
  getLoopMode: () => 'none',
  setPlaylistLoop: (_loop: boolean) => {
    void _loop;
  },

  // Properties
  getProperty: (_name: string) => {
    void _name;
    return '';
  },
  setProperty: (_name: string, _value: unknown) => {
    void _name;
    void _value;
  },
  observeProperty: (_name: string) => {
    void _name;
  },
  unobserveProperty: (_name: string) => {
    void _name;
  },

  // Filters
  setVideoFilter: (_filter: string, _enabled: boolean) => {
    void _filter;
    void _enabled;
  },
  setAudioFilter: (_filter: string, _enabled: boolean) => {
    void _filter;
    void _enabled;
  },

  // Playlist
  getPlaylist: () => '[]',
  playlistNext: () => {},
  playlistPrev: () => {},
  playlistRemove: (_index: number) => {
    void _index;
  },
  playlistShuffle: () => {},
  playlistClear: () => {},

  // State queries
  getPosition: () => 0,
  getDuration: () => 0,
  getPlaybackState: () => 'idle',

  // Activity launch
  openPlayer: (_uri: string, _title: string | null, _type: 'video' | 'audio', _startPositionMs: number) => {
    void _uri;
    void _title;
    void _type;
    void _startPositionMs;
    return Promise.resolve(false);
  },
  getLaunchParams: () => null,

  // Config
  setConfig: (_configJson: string) => {
    void _configJson;
    return Promise.resolve(0);
  },

  // PiP
  enterPip: (_chapterTitle?: string, _progressPct?: string) => {
    void _chapterTitle;
    void _progressPct;
  },
  exitPip: () => {},
  exitPipAndFinish: () => {},

  // Keep screen on
  setKeepScreenOn: (_enabled: boolean) => {
    void _enabled;
  },

  // Orientation / immersive
  setOrientation: (_mode: 'portrait' | 'landscape' | 'sensor') => {
    void _mode;
  },
  setImmersive: (_enabled: boolean) => {
    void _enabled;
  },

  // Brightness
  setScreenBrightness: (_value: number) => {
    void _value;
  },
  getScreenBrightness: () => 1.0,

  // Notification
  requestNotificationPermission: () => {},
  isNotificationActive: () => false,

  // Debug
  setDebugLogging: (_enabled: boolean) => {
    void _enabled;
  },
  dumpObservedProperties: () => 0,
};

// ═══════════════════════════════════════════════════════════════════════════
// Resolution + singleton
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Cached `NativeEventEmitter` instance, lazily created once we know
 * the native module is wired. Laziness avoids the warning React
 * Native emits when you construct an emitter against an absent
 * module.
 */
let _emitter: NativeEventEmitter | null = null;

/**
 * Resolve the typed bridge module lazily. Returns `null` (caller
 * falls back to no-op bridge) when:
 *  - `NativeModules.MpvPlayerModule` is absent (web / Storybook /
 *    unit tests without the native module installed),
 *  - the module is present but missing the core methods (Phase 50
 *    stub in jest tests).
 *
 * We deliberately swallow errors here and return null — a missing
 * bridge is a routine state during development (running jest with
 * the module installed but the native side not yet wired). Logging
 * once per call would spam the console.
 *
 * V13 Phase 50: the bridge-presence check now also requires
 * `loadFile` (the cheapest method that doesn't depend on
 * `initPlayer()` having been called) — older V12 stubs only had
 * the 9 methods DefaultControls needed.
 */
function resolveBridge(): MpvPlayerModuleBridge | null {
  const mod = (NativeModules as Record<string, unknown>).MpvPlayerModule;
  if (mod == null || typeof mod !== 'object') return null;
  const m = mod as Partial<MpvPlayerModuleBridge>;
  if (
    typeof m.play !== 'function' ||
    typeof m.pause !== 'function' ||
    typeof m.seekAbsolute !== 'function' ||
    typeof m.loadFile !== 'function'
  ) {
    return null;
  }
  return mod as MpvPlayerModuleBridge;
}

/**
 * Resolve the event emitter lazily. Returns `null` when the bridge
 * is absent (so `subscribePlayerEvent` becomes a no-op).
 */
function resolveEmitter(): NativeEventEmitter | null {
  if (_emitter !== null) return _emitter;
  const mod = (NativeModules as Record<string, unknown>).MpvPlayerModule;
  if (mod == null || typeof mod !== 'object') return null;
  _emitter = new NativeEventEmitter(mod as any);
  return _emitter;
}

// ═══════════════════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Phase 39: enable verbose logging from the TypeScript layer.
 * Sets the module-scoped flag that the internal `dlog` helper
 * checks. Calls into the native bridge to set `msg-level=all` on
 * mpv so all log messages (including debug/trace) are forwarded.
 *
 * Returns the effective flag after the call (so callers can confirm).
 * Side effect: subsequent calls to any bridge method will log
 * their arguments + return values to `console.log` with the
 * `[SimbaPlayer]` prefix.
 *
 * This function is safe to call multiple times — the flag is
 * idempotent. Calling with `false` resets the module-scoped
 * flag AND the native flag.
 */
export function setDebugLogging(enabled: boolean): boolean {
  _debugLoggingEnabled = enabled;
  const bridge = getMpvPlayerModule();
  try {
    bridge.setDebugLogging(enabled);
  } catch (e) {
    dlog('setDebugLogging: bridge threw', e);
  }
  return _debugLoggingEnabled;
}

/**
 * Phase 39: dump all observed mpv properties to logcat. Returns
 * the property count (for test verification). No-op fallback in
 * jest returns 0.
 */
export function dumpObservedProperties(): number {
  const bridge = getMpvPlayerModule();
  try {
    return bridge.dumpObservedProperties();
  } catch (e) {
    dlog('dumpObservedProperties: bridge threw', e);
    return 0;
  }
}

/** Phase 39: expose `dlog` so other modules can use the same gate. */
export { dlog };

/**
 * V13 Phase 50: live bridge (or no-op fallback). Consumers should
 * always import this getter rather than reach into `NativeModules`
 * directly — the no-op fallback is what keeps `DefaultControls`
 * and consumer code renderable in jest tests + Storybook + web
 * previews.
 */
export function getMpvPlayerModule(): MpvPlayerModuleBridge {
  const live = resolveBridge();
  const bridge = live ?? NOOP_BRIDGE;
  dlog('getMpvPlayerModule: resolved', live ? 'live bridge' : 'no-op fallback');
  return bridge;
}

/**
 * V13 Phase 50c: subscribe to a native event. Returns an
 * unsubscribe function that callers should invoke from
 * `useEffect` cleanup. When the bridge is absent (jest, web
 * preview), returns a no-op unsubscribe so cleanup is safe.
 */
export function subscribePlayerEvent<E extends PlayerEventName>(
  event: E,
  handler: (payload: PlayerEventPayloads[E]) => void,
): () => void {
  const emitter = resolveEmitter();
  if (emitter === null) {
    dlog('subscribePlayerEvent: no emitter for', event);
    return () => {
      // no-op unsubscribe (bridge absent)
    };
  }
  dlog('subscribePlayerEvent: subscribing to', event);
  const subscription = emitter.addListener(event, handler);
  return () => {
    dlog('subscribePlayerEvent: unsubscribing from', event);
    subscription.remove();
  };
}

/**
 * V13 Phase 50c: remove all listeners for a single event, or
 * every event when no argument is passed. Mirrors the consumer's
 * old `MpvPlayer.removeAllListeners(event?)` API.
 */
export function removeAllListeners(event?: PlayerEventName): void {
  const emitter = resolveEmitter();
  if (emitter === null) return;
  dlog('removeAllListeners: event=', event ?? '(all)');
  // RN's NativeEventEmitter.removeAllListeners requires an event name;
  // there is no no-arg overload. When called without an argument we
  // iterate every known event and remove each one.
  if (event === undefined) {
    for (const name of ALL_PLAYER_EVENTS) {
      emitter.removeAllListeners(name);
    }
  } else {
    emitter.removeAllListeners(event);
  }
}

/** All 22 player event names — used by `removeAllListeners()` to iterate when no event is specified. */
const ALL_PLAYER_EVENTS: readonly PlayerEventName[] = [
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
