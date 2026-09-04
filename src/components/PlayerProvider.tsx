import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { NativeModules } from 'react-native';
import {
  PlayerConfig,
  PlayerTheme,
  ResolvedPlayerConfig,
  resolvePlayerConfig,
} from '../types/config';
import {
  applyPlayerEvent,
  DEFAULT_PROGRESS,
  DEFAULT_STATE,
  hydratePlayerState,
  PlayerProgress,
  PlayerProgressContext,
  PlayerState,
  PlayerStateContext,
} from '../types/player';
import {
  getMpvPlayerModule,
  PlayerEventName,
  PlayerEventPayloads,
  removeAllListeners,
  subscribePlayerEvent,
} from '../bridge/MpvPlayerModule';

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

// ═══════════════════════════════════════════════════════════════════════════
// V13 Phase 51: PlayerStateContext + PlayerProgressContext + provider
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Internal: the state + progress context provider. The full
 * `PlayerProvider` (below) is the public surface; this
 * lower-level component just exposes the state + progress
 * contexts with already-computed values, so the public
 * provider can keep its config-push logic and just slot the
 * state in.
 *
 * The contexts themselves are defined in `types/player.ts`
 * (not here) so non-JSX consumers can import them without
 * forcing the JSX transform on the whole module.
 */
function PlayerStateProvider({
  state,
  progress,
  children,
}: {
  state: PlayerState;
  progress: PlayerProgress;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <PlayerStateContext.Provider value={state}>
      <PlayerProgressContext.Provider value={progress}>
        {children}
      </PlayerProgressContext.Provider>
    </PlayerStateContext.Provider>
  );
}

/**
 * All 22 player event names. Must match `PlayerEventName` in
 * `MpvPlayerModule.ts` (and the Kotlin `MpvBridgeModule.kt`
 * `RCTDeviceEventEmitter` strings).
 *
 * Kept here (not in the bridge module) to avoid pulling the React
 * context machinery into a pure-types module; the provider is the
 * only consumer of this constant anyway.
 */
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

/** How often the provider polls `getPosition` + `getDuration` from the bridge. */
const POSITION_POLL_INTERVAL_MS = 1000;

// ═══════════════════════════════════════════════════════════════════════════
// PlayerProvider
// ═══════════════════════════════════════════════════════════════════════════

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
 * PlayerConfig + renderControls slot + live player state to all
 * consumers below it.
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
 * V13 Phase 51: in addition to config + renderControls, the provider
 * now holds the live player state. The state is updated by:
 *  - **Initial hydration** (mount): synchronous bridge getters fill in
 *    position / duration / playback state / volume / mute / speed /
 *    loop / playlist / tracks / chapters / video params.
 *  - **Event subscriptions** (mount): all 22 mpv events are subscribed
 *    via `subscribePlayerEvent` and dispatched to `applyPlayerEvent`.
 *  - **1Hz position/duration poll** (mount): `setInterval` calls the
 *    sync `getPosition` / `getDuration` getters every 1000ms.
 *
 * State is held in a `useState` (rendered, for React) + `useRef`
 * (current, for event handlers to read without stale closures) pair.
 * On each event, we read the ref, compute the next state, write the
 * ref, and call setState. This is the canonical "useRef + useState"
 * pattern for "live state from imperative event sources".
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
  // ── Config + renderControls (V12) ──────────────────────────────────────
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

  // ── V13 Phase 51: live player state ────────────────────────────────────
  const [state, setState] = useState<PlayerState>(DEFAULT_STATE);
  const [progress, setProgress] = useState<PlayerProgress>(DEFAULT_PROGRESS);
  // The refs are the source of truth for event handlers. They read the
  // latest snapshot, apply their patch, and write back — this avoids
  // the stale-closure trap of `useState` setters in long-lived event
  // subscriptions.
  const stateRef = useRef<PlayerState>(DEFAULT_STATE);
  const progressRef = useRef<PlayerProgress>(DEFAULT_PROGRESS);
  // Tracks whether the 1Hz poll should fire. The poll runs in a child
  // effect that mounts the interval; the unmount cleanup is symmetric.
  // We mount/unmount ONCE for the provider's lifetime (no deps), so
  // the poll survives config changes.

  // Initial hydration + event subscriptions + 1Hz poll all live in a
  // single mount-only effect so they share the same lifecycle. (If we
  // split them across multiple effects, the ref + state would briefly
  // desync during the gap between hydration and subscription mount.)
  useEffect(() => {
    const bridge = getMpvPlayerModule();

    // ── 1. Initial hydration from sync bridge getters ───────────────────
    try {
      const initial = hydratePlayerState(bridge);
      stateRef.current = initial;
      setState(initial);
      const initialProgress: PlayerProgress = {
        positionMs: initial.positionMs,
        durationMs: initial.durationMs,
        isBuffering: initial.isBuffering,
        isSeeking: initial.isSeeking,
        seekable: initial.seekable,
        cacheRanges: [],
        cacheFill: 0,
      };
      progressRef.current = initialProgress;
      setProgress(initialProgress);
    } catch (e) {
      // Hydration is best-effort; if any getter throws we just keep
      // the defaults. (A typical cause is a stub bridge in a test
      // environment that doesn't implement every getter.)
      // eslint-disable-next-line no-console
      console.warn('[simba-player] hydratePlayerState failed:', e);
    }

    // ── 2. Subscribe to all 22 mpv events ───────────────────────────────
    // Each event handler reads the current state + progress from the
    // refs, applies the patch via the pure `applyPlayerEvent`
    // reducer, writes back to the refs, and schedules a re-render
    // via setState/setProgress. The functional setState form keeps
    // the progress equality short-circuit correct under React's
    // batching.
    const unsubs: Array<() => void> = [];
    for (const event of ALL_PLAYER_EVENTS) {
      const unsub = subscribePlayerEvent(
        event,
        (payload: PlayerEventPayloads[typeof event]) => {
          const { state: nextState, progress: nextProgress } =
            applyPlayerEvent(
              stateRef.current,
              progressRef.current,
              event,
              payload,
            );
          // Skip the setState if the new state is reference-equal
          // (a true no-op event for this state) — prevents
          // re-render storms on `videoReconfig` / PiP no-ops.
          if (nextState !== stateRef.current) {
            stateRef.current = nextState;
            setState(nextState);
          }
          // Progress: apply the patch via the functional setState
          // form so we can compare against the previous value (the
          // ref may have been updated by another event handler in
          // the same batch).
          setProgress((prev) => {
            // Cheap reference + 7-field equality check.
            if (
              prev.positionMs === nextProgress.positionMs &&
              prev.durationMs === nextProgress.durationMs &&
              prev.isBuffering === nextProgress.isBuffering &&
              prev.isSeeking === nextProgress.isSeeking &&
              prev.seekable === nextProgress.seekable &&
              prev.cacheFill === nextProgress.cacheFill &&
              prev.cacheRanges.length === nextProgress.cacheRanges.length
            ) {
              return prev;
            }
            progressRef.current = nextProgress;
            return nextProgress;
          });
        },
      );
      unsubs.push(unsub);
    }

    // ── 3. 1Hz position/duration poll ───────────────────────────────────
    // Both `getPosition` and `getDuration` are sync React methods
    // on the bridge, so the poll doesn't queue microtasks. We
    // also pick up the playback state (`getPlaybackState`) here
    // as a backup for the event stream (e.g. if the consumer is
    // mounted mid-playback and missed the `onPlaybackStateChanged`
    // event).
    const pollId = setInterval(() => {
      try {
        const posSec = bridge.getPosition();
        const durSec = bridge.getDuration();
        const positionMs = Number.isFinite(posSec)
          ? Math.round(posSec * 1000)
          : stateRef.current.positionMs;
        const durationMs = Number.isFinite(durSec)
          ? Math.round(durSec * 1000)
          : stateRef.current.durationMs;

        if (
          positionMs === stateRef.current.positionMs &&
          durationMs === stateRef.current.durationMs
        ) {
          return; // no movement — skip the setState
        }
        const next: PlayerState = {
          ...stateRef.current,
          positionMs,
          durationMs,
        };
        stateRef.current = next;
        setState(next);
        const nextProgress: PlayerProgress = {
          ...progressRef.current,
          positionMs,
          durationMs,
        };
        progressRef.current = nextProgress;
        setProgress(nextProgress);
      } catch (e) {
        // Bridge threw — keep the last known position. (The no-op
        // bridge returns 0/0, which falls into the "no movement"
        // early-return above, so it doesn't spam setState.)
        // eslint-disable-next-line no-console
        console.warn('[simba-player] position poll failed:', e);
      }
    }, POSITION_POLL_INTERVAL_MS);

    // ── Cleanup ─────────────────────────────────────────────────────────
    return () => {
      for (const unsub of unsubs) {
        try {
          unsub();
        } catch {
          // never let a single bad unsub abort the rest
        }
      }
      clearInterval(pollId);
      // Best-effort: remove any lingering listeners from the emitter
      // so the next mount of the provider starts clean. (Strict-mode
      // double-invocation can otherwise leave phantom listeners.)
      try {
        removeAllListeners();
      } catch {
        // ignore — emitter may be absent in jest
      }
    };
  }, []);

  return (
    <PlayerConfigContext.Provider value={resolved}>
      <PlayerRenderControlsContext.Provider value={renderControls ?? null}>
        <PlayerStateProvider state={state} progress={progress}>
          {children}
        </PlayerStateProvider>
      </PlayerRenderControlsContext.Provider>
    </PlayerConfigContext.Provider>
  );
}
