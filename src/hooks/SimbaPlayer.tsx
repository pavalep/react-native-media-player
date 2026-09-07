import React, {useMemo} from 'react';
import { PlayerProvider } from '../components/PlayerProvider';
import type { PlayerConfig } from '../types/config';
import { PlayerResumeProvider } from './useOpenWithResume';
import type { PlayerResumeLookup } from './useOpenWithResume';

/**
 * V16 Phase 71: a single function the module calls to resolve a saved
 * resume position for a media item. The consumer provides this once
 * at the root of the app; every call site that wants resume-aware
 * openPlayer just passes `resumeId: item.uri` to the hook's returned
 * function.
 *
 * This is the V16 replacement for the V13/V14 4-path API:
 *  - V13: `lookup={PlayerResumeLookup}` (object prop)
 *  - V14: `getResumePosition={fn}` (function prop)
 *  - V14: `useSimbaPlayerLookup(selector)` (factory hook)
 *  - V14: `<PlayerResumeProvider lookup={...}>` (manual wrap)
 *
 * V16 collapses all 4 into a single `resumePolicy` function prop on
 * `<SimbaPlayer>`. The internal `PlayerResumeContext` is unchanged.
 *
 * Why the consumer provides the policy (not the module): every
 * project persists bookmarks/history differently - Redux, SQLite,
 * MMKV, AsyncStorage, server-side. The module can't know the
 * shape of the consumer's persistence layer, so the consumer
 * provides a small adapter.
 *
 * The function must be **pure and synchronous**. The module calls
 * it inline at `openPlayer(...)` time. If you need async resolution,
 * hydrate the resume position into the consumer's state first and
 * have the function return the cached value.
 */
export type ResumePolicy = (itemId: string) => number | undefined;

/**
 * V16 Phase 71: the one-import, one-wrapper integration point for
 * `<SimbaPlayer>`. The single `resumePolicy` prop replaces V13's
 * `lookup` object prop, V14's `getResumePosition` function prop,
 * and the V14 `useSimbaPlayerLookup` factory hook.
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
 *       resumePolicy={(uri) =>
 *         store.getState().bookmarks.byFileUri[uri]?.positionMs
 *       }
 *     >
 *       <RootNavigator />
 *     </SimbaPlayer>
 *   );
 * }
 * ```
 *
 * The `resumePolicy` prop is optional - omit it and the inner
 * `<PlayerResumeProvider>` is mounted with a no-op policy that
 * always returns `undefined` (resume always falls back to 0 or
 * the consumer-provided `startPositionMs`).
 *
 * **Junior-dev rule of thumb:** if your screen calls
 * `openPlayer({resumeId: item.id})`, pass a `resumePolicy` here.
 * If you only call `openPlayer({uri, title, type})` without
 * `resumeId`, the policy is optional.
 */
export interface SimbaPlayerProps {
  /**
   * Partial PlayerConfig. Every field is optional; missing
   * fields fall back to the defaults in `resolvePlayerConfig`.
   */
  config?: PlayerConfig;
  /**
   * V16: bookmark-aware resume lookup, as a single function.
   * Receives a `resumeId` (typically a URI or item id) and
   * returns the saved position in ms, or `undefined` for no
   * saved position.
   */
  resumePolicy?: ResumePolicy;
  children: React.ReactNode;
}

/**
 * The one-line integration point. See `SimbaPlayerProps` for
 * usage.
 */
export function SimbaPlayer({
  config,
  resumePolicy,
  children,
}: SimbaPlayerProps): React.ReactElement {
  // Wrap the policy in the legacy `PlayerResumeLookup` object
  // shape so the existing `PlayerResumeContext` plumbing is
  // unchanged. Memoize so the `PlayerResumeContext` value
  // stays stable across renders - this is what keeps every
  // `useOpenWithResume()` consumer from re-rendering on every
  // root render.
  const lookup = useMemo<PlayerResumeLookup>(() => {
    if (resumePolicy) {
      return {getResumePosition: resumePolicy};
    }
    return noopLookup;
  }, [resumePolicy]);

  return (
    <PlayerProvider config={config}>
      <PlayerResumeProvider lookup={lookup}>
        {children}
      </PlayerResumeProvider>
    </PlayerProvider>
  );
}

/**
 * No-op lookup used when the consumer doesn't pass a
 * `resumePolicy`. Always returns `undefined` so
 * `useOpenWithResume` falls back to 0 (or the
 * consumer-provided `startPositionMs`).
 */
const noopLookup: PlayerResumeLookup = {
  getResumePosition: () => undefined,
};
