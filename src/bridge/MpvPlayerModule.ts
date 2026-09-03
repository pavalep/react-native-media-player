import { NativeModules } from 'react-native';

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

/**
 * Typed shape of the `MpvPlayerModule` native bridge as exposed by
 * `MpvBridgeModule.kt` (consumer app side). Phase 24 entry point —
 * wraps the methods `DefaultControls` calls when the user presses
 * play / pause / seek. Future phases add the remaining methods
 * (volume, playlist, subtitles, PiP toggle) as DefaultControls
 * grows.
 *
 * Why a typed wrapper over `NativeModules.MpvPlayerModule` directly?
 *  - Single source of truth for the bridge contract — the consumer
 *    app, jest tests, and the default controls all see the same
 *    method names and signatures.
 *  - Lazy resolution with graceful no-op fallback when the native
 *    module isn't wired (jest unit tests, web previews, Storybook).
 *    `usePlayer()` / `DefaultControls` can call these without
 *    guarding every call site.
 *  - Typed return values let us add per-call error handling in a
 *    single place when we upgrade from "best-effort fire-and-forget"
 *    to "track success / failure".
 */
export interface MpvPlayerModuleBridge {
  /** Resume or start playback of the currently-loaded file. */
  play(): void;
  /** Pause playback (mpv remains at the current position). */
  pause(): void;
  /**
   * Seek to an absolute position in **seconds**. Mirrors
   * `MpvBridgeModule.seekAbsolute(position: Double)` which calls
   * `MPVLib.nativeSeek(ptr, position)`.
   */
  seekAbsolute(positionSeconds: number): void;
  /** Skip backward by N seconds (clamps at 0). */
  seekBackward(seconds: number): void;
  /** Skip forward by N seconds. */
  seekForward(seconds: number): void;
  /** Push the latest PlayerConfig JSON to the native side. Phase 21 wire. */
  setConfig(configJson: string): Promise<void>;
  /**
   * Phase 39: toggle verbose native logging. When true, mpv's
   * internal log messages (`msg-level=all`) are forwarded to
   * logcat with the tag `MpvLib`, and the bridge emits `onLog`
   * events to JS. When false, only `info`-level logs are kept.
   * Default: false. Use during development / debugging.
   */
  setDebugLogging(enabled: boolean): void;
  /**
   * Phase 39: dump all observed mpv properties to logcat. Useful
   * for debugging state divergence between native and JS. Returns
   * the property count (for test verification).
   */
  dumpObservedProperties(): number;
}

const NOOP_BRIDGE: MpvPlayerModuleBridge = {
  play: () => {
    // no-op fallback for non-RN environments
  },
  pause: () => {
    // no-op fallback
  },
  seekAbsolute: (_positionSeconds: number) => {
    void _positionSeconds;
    // no-op fallback
  },
  seekBackward: (_seconds: number) => {
    void _seconds;
    // no-op fallback
  },
  seekForward: (_seconds: number) => {
    void _seconds;
    // no-op fallback
  },
  setConfig: () => Promise.resolve(),
  setDebugLogging: (_enabled: boolean) => {
    void _enabled;
    // no-op fallback
  },
  dumpObservedProperties: () => 0,
};

/**
 * Resolve the typed bridge module lazily. Returns `null` (caller
 * falls back to no-op bridge) when:
 *  - `NativeModules.MpvPlayerModule` is absent (web / Storybook /
 *    unit tests without the native module installed),
 *  - the module is present but missing expected methods (Phase 24
 *    stub in jest tests).
 *
 * We deliberately swallow errors here and return null — a missing
 * bridge is a routine state during development (running jest with
 * the module installed but the native side not yet wired). Logging
 * once per call would spam the console.
 */
function resolveBridge(): MpvPlayerModuleBridge | null {
  const mod = (NativeModules as Record<string, unknown>).MpvPlayerModule;
  if (mod == null || typeof mod !== 'object') return null;
  const m = mod as Partial<MpvPlayerModuleBridge>;
  if (
    typeof m.play !== 'function' ||
    typeof m.pause !== 'function' ||
    typeof m.seekAbsolute !== 'function'
  ) {
    return null;
  }
  return m as MpvPlayerModuleBridge;
}

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
 * Phase 24 exported bridge wrapper. Returns the live bridge when the
 * native module is wired, otherwise returns a no-op bridge whose
 * methods resolve silently.
 *
 * Consumers (default controls + custom controls) should always
 * import this getter rather than reach into `NativeModules`
 * directly — the no-op fallback is what keeps `DefaultControls`
 * renderable in jest tests + Storybook + web previews.
 *
 * Future phases may add a `subscribe(eventName)` for mpv property
 * observers; the bridge contract will grow alongside.
 */
export function getMpvPlayerModule(): MpvPlayerModuleBridge {
  const bridge = resolveBridge() ?? NOOP_BRIDGE;
  // Phase 39: log the resolution result when verbose logging is on.
  // This helps consumers diagnose "why isn't my bridge method doing
  // anything?" — the answer is usually "you got the no-op fallback
  // because the native module isn't wired".
  dlog('getMpvPlayerModule: resolved', resolveBridge() ? 'live bridge' : 'no-op fallback');
  return bridge;
}
