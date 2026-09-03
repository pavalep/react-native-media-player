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
nativeModulesMock.default.MpvPlayerModule = {
  play: fn(() => Promise.resolve()),
  pause: fn(() => Promise.resolve()),
  seekAbsolute: fn(() => Promise.resolve()),
  seekForward: fn(() => Promise.resolve()),
  seekBackward: fn(() => Promise.resolve()),
  playlistNext: fn(() => Promise.resolve()),
  playlistPrev: fn(() => Promise.resolve()),
  setConfig: fn(() => Promise.resolve()),
  openPlayer: fn(() => Promise.resolve()),
  enterPip: fn(() => Promise.resolve()),
  exitPip: fn(() => Promise.resolve()),
  exitPipAndFinish: fn(() => Promise.resolve()),
  requestNotificationPermission: fn(() => Promise.resolve()),
  // Phase 39: debug-mode API
  setDebugLogging: fn(() => undefined),
  dumpObservedProperties: fn(() => 0),
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
