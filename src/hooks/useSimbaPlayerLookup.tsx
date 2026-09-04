import {useMemo} from 'react';
import type {PlayerResumeLookup} from './useOpenWithResume';

/**
 * V14 Phase 61: a function the module calls to resolve a saved
 * resume position for a media item. The consumer provides this
 * once at the root of the app; every call site that wants
 * resume-aware openPlayer just passes `resumeId: item.uri` to
 * the hook's returned function.
 *
 * Mirrors the body of `PlayerResumeLookup.getResumePosition` —
 * kept as a named type so `<SimbaPlayer getResumePosition={...}>`
 * has a self-documenting prop type instead of an inline arrow.
 */
export type GetResumePosition = (itemId: string) => number | undefined;

const noopLookup: PlayerResumeLookup = {
  getResumePosition: () => undefined,
};

/**
 * V14 Phase 61: factory hook for a stable `PlayerResumeLookup`.
 *
 * Wraps an optional `selector` function in a memoized
 * `PlayerResumeLookup` object so the lookup reference stays
 * stable across renders. The point of this hook is to ship the
 * **shape** so the consumer's `lookup={}` is always type-safe
 * + stable — the consumer never has to write `useMemo<PlayerResumeLookup>(...)`
 * themselves.
 *
 * Without a selector, returns a no-op lookup (always returns
 * `undefined`).
 *
 * @example
 * ```tsx
 * // With a selector (most common):
 * const resumeLookup = useSimbaPlayerLookup((uri) =>
 *   store.getState().bookmarks.byFileUri[uri]?.positionMs,
 * );
 *
 * return (
 *   <SimbaPlayer lookup={resumeLookup}>
 *     <AppContent />
 *   </SimbaPlayer>
 * );
 *
 * // Or — the function-prop shape (recommended for new consumers):
 * <SimbaPlayer getResumePosition={(uri) => store.getState().bookmarks.byFileUri[uri]?.positionMs} />
 * ```
 */
export function useSimbaPlayerLookup(
  selector?: GetResumePosition,
): PlayerResumeLookup {
  return useMemo<PlayerResumeLookup>(() => {
    if (!selector) return noopLookup;
    return {getResumePosition: selector};
  }, [selector]);
}
