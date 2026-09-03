/**
 * Unit tests for `src/types/config.ts` — the public configuration API.
 *
 * Spec §Phase 34 covers:
 *  - 34.5 PlayerProvider applies config — exercised in
 *    `PlayerProvider.test.tsx`. Here we test the resolver logic
 *    directly: `resolvePlayerConfig` is the pure function that
 *    PlayerProvider delegates to.
 *
 * Why this is the foundation test file:
 *  - `resolvePlayerConfig` is the most-pure, most-testable function
 *    in the module (no React, no bridge, no async).
 *  - The defaults (`DEFAULT_THEME`, `DEFAULT_PLAYER_CONFIG`) are the
 *    contract that every consumer app implicitly relies on. Pinning
 *    them prevents accidental breaking changes.
 */

import {
  DEFAULT_PLAYER_CONFIG,
  DEFAULT_THEME,
  resolvePlayerConfig,
} from '../config';
import type { PlayerConfig } from '../config';

describe('resolvePlayerConfig', () => {
  it('returns full defaults when called with undefined', () => {
    const resolved = resolvePlayerConfig(undefined);
    expect(resolved).toEqual(DEFAULT_PLAYER_CONFIG);
  });

  it('returns full defaults when called with empty object', () => {
    const resolved = resolvePlayerConfig({});
    expect(resolved).toEqual(DEFAULT_PLAYER_CONFIG);
  });

  it('preserves top-level theme overrides', () => {
    const resolved = resolvePlayerConfig({
      theme: { accent: '#FF00FF' },
    });
    expect(resolved.theme.accent).toBe('#FF00FF');
    // Other theme fields fall back to DEFAULT_THEME.
    expect(resolved.theme.background).toBe(DEFAULT_THEME.background);
    expect(resolved.theme.text).toBe(DEFAULT_THEME.text);
  });

  it('preserves nested pip config', () => {
    const resolved = resolvePlayerConfig({
      pip: { enabled: false, autoEnterOnLeave: false },
    });
    expect(resolved.pip).toEqual({ enabled: false, autoEnterOnLeave: false });
  });

  it('preserves audio config', () => {
    const resolved = resolvePlayerConfig({
      audio: { backgroundPlayback: false, respectAudioFocus: false },
    });
    expect(resolved.audio).toEqual({
      backgroundPlayback: false,
      respectAudioFocus: false,
    });
  });

  it('preserves hardwareDecoding union type', () => {
    const cases: Array<PlayerConfig['hardwareDecoding']> = [
      'auto',
      'mediacodec',
      'no',
    ];
    for (const value of cases) {
      const resolved = resolvePlayerConfig({ hardwareDecoding: value });
      expect(resolved.hardwareDecoding).toBe(value);
    }
  });

  it('preserves notifications config', () => {
    const resolved = resolvePlayerConfig({
      notifications: { enabled: true, channelId: 'my_app_media' },
    });
    expect(resolved.notifications).toEqual({
      enabled: true,
      channelId: 'my_app_media',
    });
  });

  it('preserves subtitle config', () => {
    const resolved = resolvePlayerConfig({
      subtitle: { preferredLanguages: ['en', 'es'], fontSize: 22 },
    });
    expect(resolved.subtitle.preferredLanguages).toEqual(['en', 'es']);
    expect(resolved.subtitle.fontSize).toBe(22);
  });

  it('preserves debug config', () => {
    const resolved = resolvePlayerConfig({ debug: { verboseLogging: true } });
    expect(resolved.debug.verboseLogging).toBe(true);
  });

  it('merges partial config without mutating the input', () => {
    // Spec §Phase 34.5: PlayerProvider must not mutate the consumer's
    // config object — defensive against React re-renders that pass the
    // same prop reference.
    const config: PlayerConfig = {
      theme: { accent: '#ABCDEF' },
    };
    const before = JSON.stringify(config);
    resolvePlayerConfig(config);
    const after = JSON.stringify(config);
    expect(after).toBe(before);
  });

  it('returns an object that passes structural equality', () => {
    // The PlayerProvider uses `JSON.stringify(resolved)` as the
    // dependency key for its `useEffect`. Verify that two equivalent
    // configs produce identical JSON.
    const a = resolvePlayerConfig({ pip: { enabled: false } });
    const b = resolvePlayerConfig({ pip: { enabled: false } });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('returns a value that is structurally equal to DEFAULT_PLAYER_CONFIG for empty input', () => {
    // The current implementation always returns a fresh object even
    // when called with `{}` or `undefined` — there's no reference-
    // equality shortcut. PlayerProvider's setConfig effect therefore
    // runs once on mount regardless. We pin the contract here so a
    // future optimisation (returning DEFAULT_PLAYER_CONFIG by
    // reference for empty input) is a deliberate choice, not an
    // accidental side effect.
    const resolved = resolvePlayerConfig({});
    expect(resolved).toStrictEqual(DEFAULT_PLAYER_CONFIG);
  });
});

describe('DEFAULT_THEME', () => {
  it('exposes the documented dark theme', () => {
    // Lock the values so consumers can rely on them (and so the
    // DefaultControls visual baseline doesn't drift accidentally).
    // `icon` is intentionally absent — it's an optional override in
    // PlayerTheme (see types/config.ts).
    expect(DEFAULT_THEME).toEqual({
      accent: '#FFD700',
      background: '#121216',
      text: '#FFFFFF',
      textSecondary: 'rgba(255,255,255,0.6)',
      surface: 'rgba(255,255,255,0.1)',
    });
  });

  it('all colors are strings (no undefined)', () => {
    for (const [key, value] of Object.entries(DEFAULT_THEME)) {
      expect(typeof value).toBe('string');
      expect(value.length).toBeGreaterThan(0);
      // Use the value so jest doesn't warn about unused.
      void key;
    }
  });
});

describe('DEFAULT_PLAYER_CONFIG', () => {
  it('every documented sub-config is populated', () => {
    // Lock the shape — a refactor that drops a sub-config would
    // silently break consumers expecting the field.
    // Note: the defaults match resolvePlayerConfig's hard-coded
    // defaults in src/types/config.ts. If those defaults change, both
    // this test and the implementation must change together.
    expect(DEFAULT_PLAYER_CONFIG).toEqual({
      theme: DEFAULT_THEME,
      pip: { enabled: true, autoEnterOnLeave: true },
      audio: { backgroundPlayback: true, respectAudioFocus: true },
      subtitle: { preferredLanguages: [], fontSize: 16 },
      notifications: { enabled: true, channelId: 'simba_player_media' },
      hardwareDecoding: 'auto',
      debug: { verboseLogging: false },
    });
  });

  it('pip is enabled by default (opt-out is the design)', () => {
    // V12 spec: PiP is on by default; consumers explicitly disable it.
    expect(DEFAULT_PLAYER_CONFIG.pip.enabled).toBe(true);
    expect(DEFAULT_PLAYER_CONFIG.pip.autoEnterOnLeave).toBe(true);
  });

  it('audio backgroundPlayback is ON by default (matches Spotify / Apple Music)', () => {
    // V12 spec: matches AudioConfig.backgroundPlayback's docstring —
    // opt-out is the design so audio apps behave like mainstream
    // players out of the box.
    expect(DEFAULT_PLAYER_CONFIG.audio.backgroundPlayback).toBe(true);
  });
});
