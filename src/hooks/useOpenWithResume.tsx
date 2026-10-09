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

/**
 * V13+ DX: map a content/media-kind string to a V13 stream type
 * (`'video' | 'audio'`). Useful for consumers that historically
 * passed a content type (`'music'`, `'movie'`, etc.) where V13
 * expects a stream type.
 *
 * The mapping is conservative — anything not in the explicit
 * "video" / "audio" lists falls back to `'audio'` (the safer
 * default; if you need a different default for your app, copy
 * the function and adjust).
 *
 * The map covers the common SIMBA content kinds. Consumers with
 * custom kinds should add their own cases or pre-map before
 * calling.
 *
 * @example
 * ```ts
 * import { resolveStreamType } from '@simba-dev/react-native-media-player';
 *
 * openPlayer({
 *   uri: item.uri,
 *   title: item.title,
 *   type: resolveStreamType(item.kind),  // 'music' -> 'audio', 'movie' -> 'video', etc.
 * });
 * ```
 */
export type ContentKind =
  | 'video' | 'audio'              // stream types (passthrough)
  | 'music' | 'audiobook' | 'podcast' | 'radio' | 'archive-audio'  // audio content
  | 'movie' | 'episode' | 'live-tv' | 'video-file' | 'archive-video'  // video content
  | string;                         // unknown — falls back to 'audio'

/**
 * Content kind → playback lane.
 *
 * ## Why a single map rather than two sets plus a default
 *
 * Two sets with an unknown-value fallback cannot be tested for
 * correctness in the one case that matters. If a kind is dropped from
 * both sets it falls through to the default, and for an AUDIO kind that
 * default is also `'audio'` — so the mistake is invisible to any
 * assertion on the return value. A kind only becomes visible once it has
 * already been mis-tabulated *into* the other lane.
 *
 * That is not hypothetical: `'episode'` sat in the video list while the
 * rest of the app treats a podcast episode as audio, and `'archive-video'`
 * was absent entirely so it took the audio default. Both produced a file
 * opening the wrong PLAYER WINDOW, and neither was reachable from a
 * return-value test.
 *
 * Exported so a consumer can audit the table against its own `MediaKind`
 * union instead of discovering a gap as a mis-routed file.
 */
export const CONTENT_KIND_LANES: Readonly<Record<string, 'audio' | 'video'>> =
  Object.freeze({
    // Audio content kinds. A podcast episode belongs here, not in video.
    audio: 'audio',
    music: 'audio',
    audiobook: 'audio',
    podcast: 'audio',
    radio: 'audio',
    episode: 'audio',
    'archive-audio': 'audio',

    // Video content kinds, listed explicitly rather than as "everything
    // else" — a negative list would silently send any kind dropped from
    // the audio table to video.
    video: 'video',
    movie: 'video',
    'live-tv': 'video',
    'video-file': 'video',
    'archive-video': 'video',
  });

/**
 * Map a content/media-kind string to a stream type (`'video' | 'audio'`).
 *
 * The fallback for an unrecognised kind is `'audio'`, unchanged: an
 * unknown file is genuinely more likely to be audio-only, and the audio
 * player still plays it. The defect this fixes was never the fallback —
 * it was recognised kinds falling INTO it.
 */
export function resolveStreamType(input: ContentKind): 'video' | 'audio' {
  return CONTENT_KIND_LANES[input] ?? 'audio';
}
