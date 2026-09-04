import React, { createContext, useCallback, useContext } from 'react';
import { usePlayerActivity } from './usePlayerActivity';
import type { OpenPlayerOptions } from './usePlayerActivity';

/**
 * V13+ DX: a lookup function the module calls to resolve a saved
 * resume position for an item. The consumer provides this once at
 * the root of the app; every call site that wants resume-aware
 * openPlayer just passes `resumeId: item.id` to the hook's returned
 * function.
 *
 * Why the consumer provides the lookup (not the module): every
 * project persists bookmarks/history differently — Redux, SQLite,
 * MMKV, AsyncStorage, server-side. The module can't know the
 * shape of the consumer's persistence layer, so the consumer
 * provides a small adapter.
 *
 * The lookup must be **pure and synchronous**. The module calls it
 * inline at `openPlayer(...)` time. If you need async resolution,
 * hydrate the resume position into the consumer's state first and
 * have the lookup return the cached value.
 */
export interface PlayerResumeLookup {
  /**
   * Returns the saved resume position in milliseconds for the given
   * item id. Return 0 (or undefined) when no saved position exists
   * (file will play from the start).
   */
  getResumePosition(itemId: string): number | undefined;
}

const PlayerResumeContext = createContext<PlayerResumeLookup | null>(null);

/**
 * Wrap the consumer app (or any subtree) with a resume lookup.
 * Place this ABOVE every call site of `useOpenWithResume()`. In
 * practice, wrap the same subtree as `<PlayerProvider>` (Phase 54
 * will compose them in PlayerActivity, but for now the consumer
 * can wrap at App.tsx).
 *
 * The actual JSX component lives in `PlayerResumeProvider.tsx` (a
 * `.tsx` file) so the legacy JSX transform doesn't reject the
 * `React.ReactElement` return type. This module re-exports it
 * through the index.
 *
 * @example
 * ```tsx
 * function App() {
 *   const lookup = useMemo<PlayerResumeLookup>(() => ({
 *     getResumePosition: (id) => store.getState().bookmarks.byId[id]?.position ?? 0,
 *   }), []);
 *   return (
 *     <PlayerResumeProvider lookup={lookup}>
 *       <Navigator />
 *     </PlayerResumeProvider>
 *   );
 * }
 * ```
 */
export interface PlayerResumeProviderProps {
  lookup: PlayerResumeLookup;
  children: React.ReactNode;
}

/**
 * JSX component that wraps a subtree with the player resume context.
 * Returns the same React tree with the context provider wrapping
 * `children`. Place this above every call site of `useOpenWithResume`.
 */
export function PlayerResumeProvider({
  lookup,
  children,
}: PlayerResumeProviderProps): React.ReactElement {
  return (
    <PlayerResumeContext.Provider value={lookup}>
      {children}
    </PlayerResumeContext.Provider>
  );
}

/**
 * DX-friendly alternative to `usePlayerActivity().openPlayer`. The
 * returned function accepts the same `OpenPlayerOptions` as the
 * V13 `usePlayerActivity` hook, plus an optional `resumeId`. When
 * `resumeId` is provided, the module:
 *
 * 1. Reads the saved resume position from the nearest
 *    `<PlayerResumeProvider>`'s lookup.
 * 2. Substitutes it for `startPositionMs` (if the consumer didn't
 *    already pass one).
 * 3. Calls the underlying `openPlayer` with the resolved options.
 *
 * If no `PlayerResumeProvider` is in scope, the hook behaves
 * identically to `usePlayerActivity().openPlayer` (no resume
 * lookup, no error).
 *
 * This is the pattern the V13 migration prefers: every screen that
 * opens a media item passes `resumeId: item.id` and lets the
 * module handle the resume-position plumbing.
 *
 * @example
 * ```tsx
 * function TrackRow({track}) {
 *   const openPlayer = useOpenWithResume();
 *   return (
 *     <Pressable onPress={() => openPlayer({
 *       uri: track.uri,
 *       title: track.title,
 *       type: 'audio',
 *       resumeId: track.id,
 *     })}>
 *       <Text>{track.title}</Text>
 *     </Pressable>
 *   );
 * }
 * ```
 */
export function useOpenWithResume(): (opts: OpenPlayerOptions & {resumeId?: string}) => Promise<boolean> {
  const lookup = useContext(PlayerResumeContext);
  const { openPlayer } = usePlayerActivity();
  return useCallback(
    (opts) => {
      const { resumeId, startPositionMs: providedStartMs, ...rest } = opts;
      // If the consumer passed an explicit startPositionMs, respect it.
      // Otherwise, if a resumeId + lookup are available, ask the lookup.
      // Otherwise, fall back to 0.
      let startPositionMs = providedStartMs ?? 0;
      if (resumeId != null && lookup != null && providedStartMs == null) {
        try {
          const saved = lookup.getResumePosition(resumeId);
          if (typeof saved === 'number' && Number.isFinite(saved) && saved > 0) {
            startPositionMs = saved;
          }
        } catch {
          // Lookup threw — fall back to 0. The consumer's persistence
          // layer is buggy, but the player should still launch.
        }
      }
      return openPlayer({ ...rest, startPositionMs });
    },
    [lookup, openPlayer],
  );
}

/**
 * DX hook for the "press a row to play" pattern. Returns a stable
 * `playItem` function that takes a minimal item shape and a few
 * optional fields, and does the openPlayer wiring. The hook reads
 * the resume position from the nearest `PlayerResumeProvider`
 * automatically.
 *
 * This is sugar on top of `useOpenWithResume` — if the consumer
 * doesn't need this level of abstraction, use `useOpenWithResume`
 * directly.
 *
 * @example
 * ```tsx
 * function TrackRow({track}) {
 *   const play = usePlayItem();
 *   return <Pressable onPress={() => play(track, {type: 'audio'})}>...</Pressable>;
 * }
 * ```
 */
export function usePlayItem(): (item: {id: string; uri: string; title: string}, opts: {type: 'video' | 'audio'}) => Promise<boolean> {
  const openPlayer = useOpenWithResume();
  return useCallback(
    (item, opts) =>
      openPlayer({
        uri: item.uri,
        title: item.title,
        type: opts.type,
        resumeId: item.id,
      }),
    [openPlayer],
  );
}

/** Re-export the resume context for advanced consumers (testing, etc.). */
export { PlayerResumeContext };
