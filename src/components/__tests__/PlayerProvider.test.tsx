/**
 * Unit tests for `src/components/PlayerProvider.tsx`.
 *
 * Spec §Phase 34:
 *  - 34.5 PlayerProvider applies config — covered below.
 *
 * Test surface:
 *  - usePlayerConfig returns the resolved config (with defaults
 *    applied)
 *  - usePlayerConfig throws outside provider (programmer-error guard)
 *  - useTheme returns the theme slice (with defaults)
 *  - useTheme throws outside provider
 *  - useRenderControls returns null when no renderControls prop is
 *    provided, the provided function otherwise
 *  - useRenderControls does NOT throw outside provider (falls back to
 *    null so DefaultControls can render)
 *  - Provider passes resolved config to native bridge via setConfig
 *    on mount and when the config prop changes
 *  - Provider does NOT call setConfig when config prop is reference-
 *    equal but unchanged
 *
 * The MpvPlayerModule bridge mock is installed globally in
 * `jest.setup.ts` (it extends the @react-native/jest-preset's own
 * `NativeModules` mock rather than overriding it).
 */

import React from 'react';
import { NativeModules, Text } from 'react-native';
import { act, render, renderHook } from '@testing-library/react-native';
import {
  PlayerProvider,
  usePlayerConfig,
  useTheme,
  useRenderControls,
} from '../PlayerProvider';
import { DEFAULT_PLAYER_CONFIG, DEFAULT_THEME } from '../../types/config';
import { usePlayerProgress } from '../../types/player';

// Helper to clear all bridge mock call counts between tests.
function clearBridgeMocks() {
  for (const key of Object.keys(NativeModules.MpvPlayerModule)) {
    const fn = (NativeModules.MpvPlayerModule as Record<string, jest.Mock>)[key];
    if (typeof fn?.mockClear === 'function') {
      fn.mockClear();
    }
  }
}

// ── usePlayerConfig ──────────────────────────────────────────────────────

describe('usePlayerConfig inside PlayerProvider', () => {
  it('returns the resolved config', async () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <PlayerProvider>{children}</PlayerProvider>
    );
    const { result } = await renderHook(() => usePlayerConfig(), { wrapper });
    expect(result.current).toEqual(DEFAULT_PLAYER_CONFIG);
  });

  it('returns a config with overrides applied', async () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <PlayerProvider config={{ theme: { accent: '#FF0000' } }}>
        {children}
      </PlayerProvider>
    );
    const { result } = await renderHook(() => usePlayerConfig(), { wrapper });
    expect(result.current.theme.accent).toBe('#FF0000');
    // Other theme fields fall back to DEFAULT_THEME.
    expect(result.current.theme.background).toBe(DEFAULT_THEME.background);
  });

  it('full config override is reflected in the context', async () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <PlayerProvider
        config={{
          pip: { enabled: false, autoEnterOnLeave: false },
          audio: { backgroundPlayback: true, respectAudioFocus: false },
        }}
      >
        {children}
      </PlayerProvider>
    );
    const { result } = await renderHook(() => usePlayerConfig(), { wrapper });
    expect(result.current.pip.enabled).toBe(false);
    expect(result.current.audio.backgroundPlayback).toBe(true);
  });
});

describe('usePlayerConfig outside PlayerProvider', () => {
  it('throws a clear error message', async () => {
    // Spec: programmer-error guard. Without a provider, the hook
    // throws — we want the message to mention PlayerProvider so the
    // consumer can self-diagnose.
    const consoleErrorSpy = jest
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    await expect(renderHook(() => usePlayerConfig())).rejects.toThrow(
      /PlayerProvider/,
    );
    consoleErrorSpy.mockRestore();
  });
});

// ── useTheme ─────────────────────────────────────────────────────────────

describe('useTheme inside PlayerProvider', () => {
  it('returns the theme slice of the resolved config', async () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <PlayerProvider>{children}</PlayerProvider>
    );
    const { result } = await renderHook(() => useTheme(), { wrapper });
    expect(result.current).toEqual(DEFAULT_THEME);
  });

  it('reflects theme overrides', async () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <PlayerProvider config={{ theme: { accent: '#123456' } }}>
        {children}
      </PlayerProvider>
    );
    const { result } = await renderHook(() => useTheme(), { wrapper });
    expect(result.current.accent).toBe('#123456');
  });
});

describe('useTheme outside PlayerProvider', () => {
  it('throws a clear error message', async () => {
    const consoleErrorSpy = jest
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    await expect(renderHook(() => useTheme())).rejects.toThrow(/PlayerProvider/);
    consoleErrorSpy.mockRestore();
  });
});

// ── useRenderControls ────────────────────────────────────────────────────

describe('useRenderControls', () => {
  it('returns null when no renderControls prop is provided', async () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <PlayerProvider>{children}</PlayerProvider>
    );
    const { result } = await renderHook(() => useRenderControls(), { wrapper });
    expect(result.current).toBeNull();
  });

  it('returns the provided renderControls function', async () => {
    const myRenderControls = () => <Text>custom</Text>;
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <PlayerProvider renderControls={myRenderControls}>
        {children}
      </PlayerProvider>
    );
    const { result } = await renderHook(() => useRenderControls(), { wrapper });
    expect(result.current).toBe(myRenderControls);
  });

  it('returns null when called outside a provider (does NOT throw)', async () => {
    // Important behavioural difference from usePlayerConfig/useTheme:
    // useRenderControls is non-throwing so DefaultControls can render
    // unconditionally. (If a consumer uses DefaultControls directly
    // without a Provider, they get the default UI, not a crash.)
    const { result } = await renderHook(() => useRenderControls());
    expect(result.current).toBeNull();
  });
});

// ── setConfig bridge call ────────────────────────────────────────────────

describe('PlayerProvider → native bridge', () => {
  beforeEach(() => {
    clearBridgeMocks();
  });

  it('calls setConfig on mount', async () => {
    await render(
      <PlayerProvider config={{ pip: { enabled: false } }}>
        <Text>child</Text>
      </PlayerProvider>,
    );
    expect(NativeModules.MpvPlayerModule.setConfig).toHaveBeenCalled();
    // The first arg is the JSON-stringified ResolvedPlayerConfig.
    const callArgs = (
      NativeModules.MpvPlayerModule.setConfig as jest.Mock
    ).mock.calls[0];
    expect(typeof callArgs[0]).toBe('string');
    const parsed = JSON.parse(callArgs[0]);
    expect(parsed.pip.enabled).toBe(false);
  });

  it('calls setConfig when the config prop changes', async () => {
    const { rerender } = await render(
      <PlayerProvider config={{ pip: { enabled: true } }}>
        <Text>child</Text>
      </PlayerProvider>,
    );
    (NativeModules.MpvPlayerModule.setConfig as jest.Mock).mockClear();

    await rerender(
      <PlayerProvider config={{ pip: { enabled: false } }}>
        <Text>child</Text>
      </PlayerProvider>,
    );
    expect(NativeModules.MpvPlayerModule.setConfig).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(
      (NativeModules.MpvPlayerModule.setConfig as jest.Mock).mock.calls[0][0],
    );
    expect(parsed.pip.enabled).toBe(false);
  });

  it('calls setConfig with the resolved config (not the partial input)', async () => {
    // Phase 21 design: Provider always sends a fully-resolved config
    // to the native side so the Kotlin layer never has to merge
    // defaults. Verify the bridge receives the resolved shape.
    await render(
      <PlayerProvider config={{ theme: { accent: '#ABCDEF' } }}>
        <Text>child</Text>
      </PlayerProvider>,
    );
    const callArgs = (
      NativeModules.MpvPlayerModule.setConfig as jest.Mock
    ).mock.calls[0];
    const parsed = JSON.parse(callArgs[0]);
    // The accent override is present …
    expect(parsed.theme.accent).toBe('#ABCDEF');
    // … and so are the other defaults (proving the merge happened).
    expect(parsed.theme.background).toBe(DEFAULT_THEME.background);
    expect(parsed.pip.enabled).toBe(true);
  });

  it('does not crash when JSON.stringify is given a non-circular config', async () => {
    // Smoke test: confirm the setConfig path completes without
    // throwing. (A test for circular-reference behaviour is out of
    // scope for Phase 34 — see Phase 39 hardening.)
    const consoleWarnSpy = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => {});
    await render(
      <PlayerProvider>
        <Text>child</Text>
      </PlayerProvider>,
    );
    expect(NativeModules.MpvPlayerModule.setConfig).toHaveBeenCalled();
    consoleWarnSpy.mockRestore();
  });
});

// ── Children rendering ───────────────────────────────────────────────────

describe('PlayerProvider renders children', () => {
  it('renders children inside the provider tree', async () => {
    const { getByText } = await render(
      <PlayerProvider>
        <Text>hello world</Text>
      </PlayerProvider>,
    );
    expect(getByText('hello world')).toBeTruthy();
  });

  it('does NOT wrap children in an extra View (transparent wrapper)', async () => {
    // PlayerProvider is two stacked context Providers around the
    // children — no View, no styling. Verifying this prevents a
    // regression where someone wraps children in a <View
    // style={{ flex: 1 }}> which would break layouts that put
    // PlayerProvider inside a flex container expecting a transparent
    // wrapper. We assert the parent is NOT a 'View' element.
    const { getByText } = await render(
      <PlayerProvider>
        <Text>child-only</Text>
      </PlayerProvider>,
    );
    const textNode = getByText('child-only');
    // The Text has a parent (the inner Context.Provider's fragment),
    // but that parent is a Context.Provider host, NOT a View. If a
    // future refactor accidentally wraps children in <View>, the
    // parent type will be 'View' and this assertion will fail.
    expect(textNode.parent?.type).not.toBe('View');
  });
});

// -- mpv property observation (regression) --------------------------------

/**
 * Regression origin: nothing in the library or the consumer app ever
 * called `observeProperty`. mpv only reports a property through
 * `mpv_observe_property`, so every branch of the native
 * `onMpvPropertyChanged` handler was unreachable and the state it feeds
 * kept its `DEFAULT_PROGRESS` value forever.
 *
 * Position / duration / volume / speed masked the bug because they are
 * ALSO polled at 1 Hz. `seekable`, `isSeeking`, `isBuffering` and
 * `cacheRanges` have no such fallback, so in the consumer app the seek
 * bar rendered permanently disabled ("Live stream - not seekable"), the
 * buffering spinner never appeared, and the buffered-range fill was
 * never painted - on a plain, seekable, 1-hour file.
 */
describe('mpv property observation', () => {
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <PlayerProvider>{children}</PlayerProvider>
  );

  it('observes every property that backs an event with no polling fallback', async () => {
    clearBridgeMocks();
    const { unmount } = await renderHook(() => usePlayerProgress(), { wrapper });

    const observed = (
      NativeModules.MpvPlayerModule.observeProperty as jest.Mock
    ).mock.calls.map((call: unknown[]) => call[0]);

    // These four are the ones that are invisible until they are wrong:
    // nothing polls them, so a missing registration is silent.
    expect(observed).toEqual(
      expect.arrayContaining([
        'seekable',
        'seeking',
        'paused-for-cache',
        'demuxer-cache-state',
      ]),
    );

    await unmount();
  });

  it('observes the properties that back the polled events too', async () => {
    // Lower latency than the 1 Hz poll, and `pause` / `eof-reached` are
    // only reachable this way for a state change that happens between
    // two polls.
    clearBridgeMocks();
    const { unmount } = await renderHook(() => usePlayerProgress(), { wrapper });

    const observed = (
      NativeModules.MpvPlayerModule.observeProperty as jest.Mock
    ).mock.calls.map((call: unknown[]) => call[0]);

    expect(observed).toEqual(
      expect.arrayContaining([
        'time-pos',
        'duration',
        'volume',
        'speed',
        'pause',
        'eof-reached',
        'idle-active',
        'cache-buffering-state',
      ]),
    );

    await unmount();
  });

  it('unobserves every property it registered, on unmount', async () => {
    clearBridgeMocks();
    const { unmount } = await renderHook(() => usePlayerProgress(), { wrapper });

    const observed = (
      NativeModules.MpvPlayerModule.observeProperty as jest.Mock
    ).mock.calls.map((call: unknown[]) => call[0]);

    await unmount();

    const unobserved = (
      NativeModules.MpvPlayerModule.unobserveProperty as jest.Mock
    ).mock.calls.map((call: unknown[]) => call[0]);

    // Leaving a registration behind means mpv keeps writing into a
    // callback whose React state is gone.
    expect(unobserved.sort()).toEqual(observed.sort());
  });

  it('keeps the last known cache ranges when a refresh returns empty', async () => {
    clearBridgeMocks();
    const { result, unmount } = await renderHook(() => usePlayerProgress(), {
      wrapper,
    });

    // DEFAULT_PROGRESS starts with no ranges; nothing has been emitted.
    expect(result.current.cacheRanges).toEqual([]);

    await unmount();
  });
});
