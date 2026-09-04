import React, {useMemo} from 'react';
import { PlayerProvider } from '../components/PlayerProvider';
import type { PlayerConfig } from '../types/config';
import { PlayerResumeProvider } from './useOpenWithResume';
import type { PlayerResumeLookup } from './useOpenWithResume';
import type { GetResumePosition } from './useSimbaPlayerLookup';

/**
 * V13+ DX: the single-entry-point wrapper for the SIMBA player
 * module. This is the **only** component a consumer's app root
 * needs to integrate the module. It composes the three layers a
 * typical app needs:
 *
 *   1. `<PlayerProvider>` — the config + state context (Phase 51).
 *   2. `<PlayerResumeProvider>` — the bookmark-aware resume
 *      lookup used by `useOpenWithResume` (Phase 51/52 + DX).
 *
 * Without `<SimbaPlayer>`, the consumer would have to nest both
 * providers manually, which is verbose and error-prone for junior
 * developers. With `<SimbaPlayer>`, the entire integration is
 * **one import + one wrapper component**:
 *
 * @example
 * ```tsx
 * // App.tsx (the consumer's root)
 * import { SimbaPlayer } from '@simba-dev/react-native-media-player';
 *
 * export default function App() {
 *   return (
 *     <SimbaPlayer
 *       config={{ theme: { accent: '#FFD700' } }}
 *       getResumePosition={(uri) =>
 *         store.getState().bookmarks.byFileUri[uri]?.positionMs
 *       }
 *     >
 *       <RootNavigator />
 *     </SimbaPlayer>
 *   );
 * }
 * ```
 *
 * **V14 Phase 61:** the wrapper now accepts EITHER a
 * `getResumePosition` function reference (recommended for new
 * consumers) OR a `lookup` object (backward-compat for V13-era
 * consumers). If both are passed, `getResumePosition` wins.
 * The function-prop shape is one function reference instead of
 * an object literal — slightly less typing, slightly less
 * nesting.
 *
 * The `lookup` / `getResumePosition` props are optional — pass
 * one to enable `useOpenWithResume`'s auto-resume behavior. If
 * you only need `usePlayerActivity().openPlayer(...)` (no
 * resume lookup), you can omit both and the inner
 * `<PlayerResumeProvider>` is still mounted with a no-op lookup
 * that always returns `undefined`.
 *
 * **Junior-dev rule of thumb:** if your screen calls
 * `openPlayer({resumeId: item.id})`, you need a `lookup` or
 * `getResumePosition` here. If you only call
 * `openPlayer({uri, title, type})` without `resumeId`, the
 * lookup is optional.
 */
export interface SimbaPlayerProps {
  /**
   * Partial PlayerConfig. Every field is optional; missing
   * fields fall back to the defaults in `resolvePlayerConfig`.
   */
  config?: PlayerConfig;
  /**
   * Bookmark-aware resume lookup (object shape). If provided,
   * the module's `useOpenWithResume` hook will resolve
   * `resumeId` arguments to a `startPositionMs` via this
   * object's `getResumePosition` method.
   *
   * Backward-compat: V13-era consumers that pass a memoized
   * `PlayerResumeLookup` object. New consumers should prefer
   * the `getResumePosition` function-prop shape.
   *
   * If both `lookup` and `getResumePosition` are passed,
   * `getResumePosition` wins.
   */
  lookup?: PlayerResumeLookup;
  /**
   * Bookmark-aware resume lookup (function shape). Receives a
   * `resumeId` (typically a URI or item id) and returns the
   * saved position in ms, or `undefined` for no saved position.
   *
   * **Recommended for new consumers.** One function reference
   * instead of an object literal:
   *
   * ```tsx
   * <SimbaPlayer getResumePosition={(uri) => store.getState().bookmarks.byFileUri[uri]?.positionMs}>
   * ```
   *
   * If both `lookup` and `getResumePosition` are passed,
   * `getResumePosition` wins.
   */
  getResumePosition?: GetResumePosition;
  children: React.ReactNode;
}

/**
 * The one-line integration point. See `SimbaPlayerProps` for
 * usage.
 */
export function SimbaPlayer({
  config,
  lookup,
  getResumePosition,
  children,
}: SimbaPlayerProps): React.ReactElement {
  // `getResumePosition` wins over `lookup` if both are passed.
  // Memoize the resulting lookup so the `PlayerResumeContext`
  // value stays stable across renders — this is what keeps
  // every `useOpenWithResume()` consumer from re-rendering on
  // every root render.
  const effectiveLookup = useMemo<PlayerResumeLookup>(() => {
    if (getResumePosition) {
      return {getResumePosition};
    }
    if (lookup) {
      return lookup;
    }
    return noopLookup;
  }, [getResumePosition, lookup]);

  return (
    <PlayerProvider config={config}>
      <PlayerResumeProvider lookup={effectiveLookup}>
        {children}
      </PlayerResumeProvider>
    </PlayerProvider>
  );
}

/**
 * No-op lookup used when the consumer doesn't pass a `lookup`
 * or `getResumePosition` prop. Always returns `undefined` so
 * `useOpenWithResume` falls back to 0 (or the
 * consumer-provided `startPositionMs`).
 */
const noopLookup: PlayerResumeLookup = {
  getResumePosition: () => undefined,
};
