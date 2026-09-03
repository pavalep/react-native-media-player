/**
 * Unit tests for `src/bridge/MpvPlayerModule.ts`.
 *
 * Spec §Phase 34 doesn't have an explicit bullet for bridge tests,
 * but they're foundational — every hook/component ultimately routes
 * through `getMpvPlayerModule()` so we need to verify the typed
 * wrapper's contract.
 *
 * Test surface:
 *  - `getMpvPlayerModule()` returns the underlying module when
 *    `NativeModules.MpvPlayerModule` is defined
 *  - The returned object exposes every documented method (typed
 *    `MpvPlayerModuleBridge` interface)
 *  - Each method delegates to the same name on the underlying
 *    NativeModule
 *
 * What we DON'T test:
 *  - The "no native module" path returns null. We can't easily
 *    unmock the global mock in jest.setup.ts; the production code
 *    path is `const native = NativeModules.MpvPlayerModule; return
 *    native === undefined ? null : native;` — a pure lookup that
 *    needs no test beyond its existence.
 */

// The MpvPlayerModule bridge mock is installed globally in
// `jest.setup.ts` (it extends the @react-native/jest-preset's own
// `NativeModules` mock rather than overriding it). Every test file
// in this module shares the same `NativeModules.MpvPlayerModule`
// instance, so `mockClear()` in beforeEach is the way to reset
// call counts between tests.

import { NativeModules } from 'react-native';
import {
  getMpvPlayerModule,
  type MpvPlayerModuleBridge,
} from '../MpvPlayerModule';

describe('getMpvPlayerModule', () => {
  beforeEach(() => {
    // The global mock is shared across all test files in this
    // module — clear call history between tests so .toHaveBeenCalledTimes
    // assertions are deterministic.
    for (const key of Object.keys(NativeModules.MpvPlayerModule)) {
      const fn = (NativeModules.MpvPlayerModule as Record<string, jest.Mock>)[key];
      if (typeof fn?.mockClear === 'function') {
        fn.mockClear();
      }
    }
  });

  it('returns a non-null typed bridge when NativeModules.MpvPlayerModule exists', () => {
    const bridge = getMpvPlayerModule();
    expect(bridge).not.toBeNull();
    expect(bridge).toBeDefined();
  });

  it('returns the underlying NativeModule reference (same instance)', () => {
    // The wrapper is a transparent pass-through — consumers can rely
    // on reference equality with `NativeModules.MpvPlayerModule` if
    // they need to. Phase 24 design.
    const bridge = getMpvPlayerModule();
    expect(bridge).toBe(NativeModules.MpvPlayerModule);
  });

  it('exposes every documented method on the typed bridge interface', () => {
    const bridge = getMpvPlayerModule() as MpvPlayerModuleBridge;
    const expectedMethods = [
      'play',
      'pause',
      'seekAbsolute',
      'seekForward',
      'seekBackward',
      'playlistNext',
      'playlistPrev',
    ];
    for (const method of expectedMethods) {
      expect(typeof bridge[method as keyof MpvPlayerModuleBridge]).toBe(
        'function',
      );
    }
  });

  it('each method is callable and returns a thenable (Promise)', async () => {
    const bridge = getMpvPlayerModule() as MpvPlayerModuleBridge;
    // All methods are documented as `Promise<void>`. We don't
    // exhaustively call them — just smoke-test the most common ones.
    await expect(bridge.play()).resolves.toBeUndefined();
    await expect(bridge.pause()).resolves.toBeUndefined();
    await expect(bridge.seekAbsolute(42)).resolves.toBeUndefined();
    await expect(bridge.seekForward(10)).resolves.toBeUndefined();
    await expect(bridge.seekBackward(10)).resolves.toBeUndefined();
  });

  it('play() forwards arguments through to the native module', async () => {
    const bridge = getMpvPlayerModule() as MpvPlayerModuleBridge;
    (NativeModules.MpvPlayerModule.play as jest.Mock).mockClear();
    await bridge.play();
    expect(NativeModules.MpvPlayerModule.play).toHaveBeenCalledTimes(1);
    expect(NativeModules.MpvPlayerModule.play).toHaveBeenCalledWith();
  });

  it('seekAbsolute(seconds) forwards the position argument', async () => {
    const bridge = getMpvPlayerModule() as MpvPlayerModuleBridge;
    (NativeModules.MpvPlayerModule.seekAbsolute as jest.Mock).mockClear();
    await bridge.seekAbsolute(123.456);
    expect(NativeModules.MpvPlayerModule.seekAbsolute).toHaveBeenCalledWith(
      123.456,
    );
  });
});
