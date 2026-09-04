/**
 * Jest setup file for `@simba/react-native-media-player`.
 *
 * Runs BEFORE every test file but AFTER the test framework is
 * initialised (setupFilesAfterEnv). Two responsibilities:
 *
 * 1. Install a typed MpvPlayerModule mock on the preset's
 *    `NativeModules` so that every hook/component that delegates to
 *    `NativeModules.MpvPlayerModule.<method>(...)` (Phase 24 wiring)
 *    has a real jest.fn() to assert against. We EXTEND the
 *    `@react-native/jest-preset`'s mock rather than replacing it —
 *    replacing the whole react-native mock would re-introduce the
 *    DevMenu TurboModule lookup error.
 *
 * 2. Silence React Native's noisy `act()` / `Animated:` warnings
 *    that RNTL's `render` calls occasionally trigger. These are
 *    informational, not failures.
 *
 * Phase 34 deliverable.
 */

// Install MpvPlayerModule on NativeModules by mutating the preset's
// already-loaded mock. The preset's setup.js (which runs first in
// setupFiles) registers `jest.mock(
// 'react-native/Libraries/BatchedBridge/NativeModules',
// './mocks/NativeModules')`. That mock exports `default` — a
// pre-populated object with built-in RN modules (AlertManager,
// UIManager, etc.). By the time this file runs, the mock factory
// has been evaluated and the result is cached; mutating
// `default.MpvPlayerModule = ...` adds our module without touching
// the rest of the preset.
const nativeModulesMock = require('react-native/Libraries/BatchedBridge/NativeModules');
const fn = jest.fn;

/**
 * V13 Phase 50: full bridge mock. The previous 17-method mock
 * (Phase 24 + Phase 39) was sufficient for `DefaultControls` but
 * the V13 `resolveBridge()` requires `loadFile` (cheap method
 * independent of `initPlayer()`) to confirm the bridge is wired,
 * so `loadFile` MUST be present or the resolver falls back to
 * the no-op bridge and tests asserting against
 * `NativeModules.MpvPlayerModule.<method>` see zero calls.
 *
 * The mock includes every `@ReactMethod` from the Kotlin side so
 * future test files (V13 Phases 51-58) can rely on the full
 * surface. Methods returning strings return empty-string defaults;
 * methods returning booleans return false; methods returning
 * numbers return 0; methods returning objects return `'{}'`;
 * void methods return undefined.
 */
nativeModulesMock.default.MpvPlayerModule = {
  // Lifecycle
  initPlayer: fn(() => true),
  destroy: fn(() => undefined),
  getNativePtr: fn(() => 0),

  // Playback control
  play: fn(() => Promise.resolve()),
  pause: fn(() => Promise.resolve()),
  stop: fn(() => undefined),
  togglePlayPause: fn(() => undefined),
  seekAbsolute: fn(() => Promise.resolve()),
  seekForward: fn(() => Promise.resolve()),
  seekBackward: fn(() => Promise.resolve()),
  stepFrame: fn(() => undefined),
  screenshot: fn(() => ''),

  // File loading — `loadFile` is required by the V13 Phase 50 resolver
  loadFile: fn(() => Promise.resolve()),
  loadFileWithRequestId: fn(() => Promise.resolve()),
  loadPlaylist: fn(() => Promise.resolve()),
  getFileInfo: fn(() => '{}'),
  getVideoParams: fn(() => '{}'),
  captureThumbnail: fn(() => ''),
  grantPersistablePermission: fn(() => undefined),
  verifyContentUri: fn(() => true),

  // Tracks
  getTracks: fn(() => '[]'),
  selectTrack: fn(() => undefined),
  cycleTrack: fn(() => undefined),
  setTrack: fn(() => undefined),
  setTrackVisibility: fn(() => undefined),

  // Chapters
  getChapters: fn(() => '[]'),
  seekChapter: fn(() => undefined),
  getCurrentChapter: fn(() => '{}'),

  // Volume / audio
  setVolume: fn(() => undefined),
  getVolume: fn(() => 100),
  setMuted: fn(() => undefined),
  getMuted: fn(() => false),
  isMuted: fn(() => false),
  getAudioDevices: fn(() => '[]'),
  setAudioDevice: fn(() => undefined),
  toggleMute: fn(() => undefined),

  // Speed / loop
  setSpeed: fn(() => undefined),
  getSpeed: fn(() => 1),
  setLoopMode: fn(() => undefined),
  getLoopMode: fn(() => 'none'),
  setPlaylistLoop: fn(() => undefined),

  // Properties
  getProperty: fn(() => ''),
  setProperty: fn(() => undefined),
  observeProperty: fn(() => undefined),
  unobserveProperty: fn(() => undefined),

  // Filters
  setVideoFilter: fn(() => undefined),
  setAudioFilter: fn(() => undefined),

  // Playlist
  getPlaylist: fn(() => '[]'),
  playlistNext: fn(() => Promise.resolve()),
  playlistPrev: fn(() => Promise.resolve()),
  playlistRemove: fn(() => undefined),
  playlistShuffle: fn(() => undefined),
  playlistClear: fn(() => undefined),

  // State queries
  getPosition: fn(() => 0),
  getDuration: fn(() => 0),
  getPlaybackState: fn(() => 'idle'),

  // Activity launch
  openPlayer: fn(() => Promise.resolve(true)),
  getLaunchParams: fn(() => null),

  // Configuration
  setConfig: fn(() => Promise.resolve(0)),

  // PiP
  enterPip: fn(() => Promise.resolve()),
  exitPip: fn(() => Promise.resolve()),
  exitPipAndFinish: fn(() => Promise.resolve()),

  // Keep screen on
  setKeepScreenOn: fn(() => undefined),

  // Orientation / immersive
  setOrientation: fn(() => undefined),
  setImmersive: fn(() => undefined),

  // Brightness
  setScreenBrightness: fn(() => undefined),
  getScreenBrightness: fn(() => 1.0),

  // Notification
  requestNotificationPermission: fn(() => Promise.resolve()),
  isNotificationActive: fn(() => false),

  // Debug (Phase 39)
  setDebugLogging: fn(() => undefined),
  dumpObservedProperties: fn(() => 0),

  // Required by NativeEventEmitter (RCTEventEmitter base class)
  addListener: fn(() => undefined),
  removeListeners: fn(() => undefined),
};

// Silence the act() / Animated warnings that RNTL occasionally
// triggers under `render` calls.
const originalError = console.error;
const originalLog = console.log;
beforeAll(() => {
  jest.spyOn(console, 'error').mockImplementation(
    (message: unknown, ...args: unknown[]) => {
      if (
        typeof message === 'string' &&
        (message.includes('not wrapped in act(') ||
          message.includes('useNativeDriver') ||
          message.includes('Animated:'))
      ) {
        return;
      }
      originalError(message as never, ...(args as never[]));
    },
  );
  // Phase 39: silence [SimbaPlayer] dlog output during tests (the
  // dlog helper logs via console.log when verbose logging is on).
  // We suppress it here because the noise makes test output
  // unreadable; the verbose-logging behaviour is verified
  // separately by the dlog-flag-gated assertions.
  jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    if (
      args.length > 0 &&
      typeof args[0] === 'string' &&
      args[0].startsWith('[SimbaPlayer]')
    ) {
      return;
    }
    originalLog(...(args as never[]));
  });
});

afterAll(() => {
  (console.error as jest.Mock).mockRestore?.();
});
