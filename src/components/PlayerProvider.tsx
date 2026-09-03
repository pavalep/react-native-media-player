import React, { createContext, useContext, useEffect, useMemo } from 'react';
import { NativeModules } from 'react-native';
import {
  PlayerConfig,
  PlayerTheme,
  ResolvedPlayerConfig,
  resolvePlayerConfig,
} from '../types/config';

/**
 * React Context carrying the resolved PlayerConfig. Consumers should
 * prefer the `usePlayerConfig()` hook over consuming the context
 * directly — the hook returns the resolved (fully-defaulted) config
 * and throws when used outside a `<PlayerProvider>`.
 *
 * Phase 21 entry point. Phase 23 added a separate context for the
 * `renderControls` slot (since the consumer can swap the controls
 * without forcing every config consumer to re-render, and vice versa).
 */
const PlayerConfigContext = createContext<ResolvedPlayerConfig | null>(null);

/**
 * Function signature for the `renderControls` slot. Takes no args —
 * the consumer's controls component reads what it needs from
 * `usePlayer()` (state + commands) and `useTheme()` (colors) itself.
 * Returns the React tree to render in place of `DefaultControls`.
 *
 * Why a function (not a component): the parent decides WHEN to call
 * it (typically inside a `PlayerRoot` component), which lets us
 * wrap the result in error boundaries / suspense fallbacks in a
 * future phase without changing the consumer's API.
 */
export type RenderControlsFn = () => React.ReactNode;

/**
 * Context carrying the `renderControls` slot. Separate from the
 * config context so consumers that only read the config don't
 * re-render when the controls prop changes, and vice versa. `null`
 * means "no custom controls — fall back to `DefaultControls`".
 */
const PlayerRenderControlsContext = createContext<RenderControlsFn | null>(null);

/**
 * Hook to read the resolved PlayerConfig from the nearest
 * `<PlayerProvider>`. Throws when used outside a provider — that's a
 * programmer error, not a runtime fallback case.
 *
 * @example
 * ```tsx
 * const { theme, pip, audio } = usePlayerConfig();
 * ```
 */
export function usePlayerConfig(): ResolvedPlayerConfig {
  const config = useContext(PlayerConfigContext);
  if (config === null) {
    throw new Error(
      'usePlayerConfig must be used inside a <PlayerProvider>. ' +
        'Wrap your app root in <PlayerProvider config={...}>.',
    );
  }
  return config;
}

/**
 * Ergonomic shortcut for the theme slice. Equivalent to
 * `usePlayerConfig().theme` but reads cleaner at the call site and
 * avoids the (minor) repeated property access in deeply-nested
 * components.
 *
 * Phase 22 deliverable: the default controls component and any
 * consumer-rendered UI can use this hook to theme themselves without
 * having to destructure the full config.
 *
 * @example
 * ```tsx
 * const theme = useTheme();
 * <View style={{ backgroundColor: theme.background }} />
 * ```
 */
export function useTheme(): PlayerTheme {
  return usePlayerConfig().theme;
}

/**
 * Phase 23 hook: read the `renderControls` slot from the nearest
 * `<PlayerProvider>`. Returns `null` when no custom controls were
 * passed — the caller (typically `<PlayerRoot>`) should fall back to
 * `<DefaultControls>` in that case.
 *
 * Returns `null` (not throws) when used outside a provider, because
 * `<PlayerRoot>` needs to gracefully render the fallback in that
 * case. The other hooks (`usePlayerConfig` / `useTheme`) throw
 * because they have no useful fallback value.
 *
 * @example
 * ```tsx
 * function PlayerRoot() {
 *   const renderControls = useRenderControls();
 *   return renderControls != null ? renderControls() : <DefaultControls />;
 * }
 * ```
 */
export function useRenderControls(): RenderControlsFn | null {
  return useContext(PlayerRenderControlsContext);
}

/**
 * Resolve the native bridge module lazily. Returns `null` on platforms
 * where the native side isn't wired (jest unit tests, web previews,
 * Storybook) — the provider still serves the config to TS consumers
 * in those environments; only the native push is skipped.
 */
function getNativeModule():
  | { setConfig(configJson: string): Promise<void> }
  | null {
  const mod = (NativeModules as Record<string, unknown>).MpvPlayerModule;
  if (
    mod != null &&
    typeof (mod as { setConfig?: unknown }).setConfig === 'function'
  ) {
    return mod as { setConfig(configJson: string): Promise<void> };
  }
  return null;
}

export interface PlayerProviderProps {
  /**
   * Partial PlayerConfig — every field is optional and falls back to
   * the defaults in `resolvePlayerConfig`. Consumers who want to
   * override just one section (e.g. `audio.backgroundPlayback = false`)
   * can spread `DEFAULT_PLAYER_CONFIG` and patch a single field.
   */
  config?: PlayerConfig;
  /**
   * Phase 23 slot: optional function that returns the React tree to
   * render in place of `<DefaultControls>`. The function takes no
   * arguments — consumers that need theme / state / commands read
   * them from `useTheme()` / `usePlayer()` inside their custom
   * component.
   *
   * @example
   * ```tsx
   * <PlayerProvider
   *   renderControls={() => <MyCustomControls />}
   * >
   *   <App />
   * </PlayerProvider>
   * ```
   *
   * When omitted, `<PlayerRoot>` (Phase 23) falls back to rendering
   * `<DefaultControls>` — so consumers can adopt the player
   * incrementally: ship with the defaults, then swap in a custom
   * implementation later without touching `<PlayerProvider>`.
   */
  renderControls?: RenderControlsFn;
  /**
   * Standard React children. Typically the consumer's entire app.
   */
  children: React.ReactNode;
}

/**
 * Wraps the consumer app (or any subtree) and provides the resolved
 * PlayerConfig + renderControls slot to all consumers below it.
 *
 * On mount and whenever the resolved config changes, the provider
 * pushes the JSON-encoded config to the native side via
 * `NativeModules.MpvPlayerModule.setConfig(...)`. PlayerActivity reads
 * the cached config on its next launch (Phase 21.5) and from Phase 22
 * onwards consumes the individual fields.
 *
 * The `renderControls` slot is intentionally NOT pushed to the native
 * side — it's a JS-only concept (a function reference can't be
 * serialised to JSON). Consumer apps wrap their PlayerActivity's JS
 * tree with `<PlayerProvider renderControls={...}>` and the
 * `<PlayerRoot>` component reads it via `useRenderControls()`.
 *
 * The provider is idempotent: re-rendering with the same config does
 * not trigger an extra native push (the `JSON.stringify` dep is the
 * cheap identity check).
 */
export function PlayerProvider({
  config,
  renderControls,
  children,
}: PlayerProviderProps): React.ReactElement {
  // We depend on the JSON string rather than the `config` reference so
  // consumers who create a fresh object on every render don't trigger
  // a native push storm. The native side is a no-op when the JSON is
  // identical to the previously-cached one.
  const resolved = useMemo<ResolvedPlayerConfig>(
    () => resolvePlayerConfig(config),
    [JSON.stringify(config ?? {})],
  );

  useEffect(() => {
    const native = getNativeModule();
    if (native === null) {
      // No native module — running in a non-RN environment (jest
      // unit tests, web). Skip silently; the provider still serves
      // the config to TS consumers.
      return;
    }
    native
      .setConfig(JSON.stringify(resolved))
      .catch((err: unknown) => {
        // Non-fatal — the provider still works for TS consumers even
        // if the native side hasn't wired setConfig yet (e.g. during
        // a Wave 6 publish flow without the consumer app rebuilt).
        // eslint-disable-next-line no-console
        console.warn('[simba-player] setConfig rejected:', err);
      });
  }, [resolved]);

  return (
    <PlayerConfigContext.Provider value={resolved}>
      <PlayerRenderControlsContext.Provider value={renderControls ?? null}>
        {children}
      </PlayerRenderControlsContext.Provider>
    </PlayerConfigContext.Provider>
  );
}
