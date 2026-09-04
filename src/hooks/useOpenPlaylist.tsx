import {useCallback} from 'react';
import {usePlayerActivity} from './usePlayerActivity';
import type {OpenPlayerOptions} from './usePlayerActivity';

/**
 * V15 Phase 64: a minimal entry shape for `useOpenPlaylist`.
 *
 * Structurally — any object with at least `uri` and `title` qualifies.
 * The consumer's full `PlaylistEntry` (which has `duration`, `source`,
 * `type`, `mediaType`, `provider`, `folderId`) matches this without
 * any explicit cast. The hook only reads `uri` and `title`; the
 * rest of the entry is ignored.
 */
export interface PlayableEntry {
  uri: string;
  title: string;
}

/**
 * V15 Phase 64: options for `openPlaylist`.
 */
export interface OpenPlaylistOptions {
  /** Stream type for the start track. Defaults to 'audio'. */
  type?: 'video' | 'audio';
  /**
   * Index into `entries` of the track to start playback from.
   * Defaults to 0 (the first track). If `shuffle: true` and
   * `startIndex` is not provided, a random non-zero index is
   * chosen (so shuffle doesn't start from index 0 by convention;
   * but pass 0 explicitly if you want that).
   */
  startIndex?: number;
  /**
   * Optional start position in ms for the start track. Useful
   * when the consumer has a saved bookmark for the first
   * track and wants playback to resume from that position.
   * (For per-track resume, the consumer should pre-dispatch
   * a seek after the activity launches; the lookup configured
   * via `<SimbaPlayer>` is not applied here — `useOpenPlaylist`
   * calls `usePlayerActivity().openPlayer`, not the
   * `useOpenWithResume` variant.)
   */
  startPositionMs?: number;
  /**
   * If true, Fisher-Yates shuffles a copy of `entries` before
   * picking the start track. The original `entries` array is
   * not mutated. The shuffle is in-place on the copy.
   */
  shuffle?: boolean;
  /**
   * Extra fields forwarded to the start track's `openPlayer`
   * call. Useful for consumer-specific metadata like
   * `provider`, `folderId`, `artworkUri`, `subtitleUri`, etc.
   *
   * These override any defaults the hook sets (e.g. `type`).
   * If you pass `type` in `startExtras`, it wins over the
   * `type` option.
   *
   * Typed loosely (`Record<string, unknown>`) so consumers
   * can spread conditional fields without TypeScript's excess
   * property check rejecting the whole object. The fields
   * are forwarded verbatim to `openPlayer({...})`; unknown
   * fields are dropped by the consumer's call site (or
   * accepted if the consumer wraps the call).
   */
  startExtras?: Record<string, unknown>;
}

/**
 * V15 Phase 64: the return value of `useOpenPlaylist`.
 */
export interface UseOpenPlaylistResult {
  /**
   * Open the given list of entries in the player. The first
   * track (or the track at `startIndex`) is the activity's
   * launch payload. Returns `false` if `entries` is empty.
   *
   * This is the "play all from a list" pattern. The hook
   * absorbs the start-track extraction, optional shuffle,
   * and `openPlayer` call. The consumer does NOT need to
   * dispatch `loadPlaylistToPlayer` separately — that's a
   * consumer-side concern (see V15 Phase 65 for the state
   * consolidation that absorbs that too).
   *
   * @example
   * ```tsx
   * const {openPlaylist} = useOpenPlaylist();
   *
   * const handlePlayAll = () => openPlaylist(sortedTracks, {type: 'audio'});
   * const handleShuffle = () => openPlaylist(sortedTracks, {type: 'audio', shuffle: true});
   * const handlePlayFromThird = () => openPlaylist(sortedTracks, {type: 'audio', startIndex: 2});
   * ```
   */
  openPlaylist(
    entries: PlayableEntry[],
    opts?: OpenPlaylistOptions,
  ): Promise<boolean>;
}

/**
 * V15 Phase 64: factory hook for the "play all" pattern.
 *
 * Replaces the 12-30 line two-step pattern every consumer
 * wrote:
 *
 * ```tsx
 * // Before (V14)
 * const handlePlayAll = useCallback(() => {
 *   const entries = sortedTracks.map(t => ({...t}));
 *   if (entries.length === 0) return;
 *   dispatch(loadPlaylistToPlayer(entries));  // consumer-side
 *   openPlayer({
 *     uri: entries[0].uri,
 *     title: entries[0].title,
 *     type: 'audio',
 *   });
 * }, [sortedTracks, dispatch, openPlayer]);
 *
 * // After (V15 Phase 64)
 * const {openPlaylist} = useOpenPlaylist();
 * const handlePlayAll = useCallback(() => {
 *   openPlaylist(sortedTracks, {type: 'audio'});
 * }, [openPlaylist, sortedTracks]);
 * ```
 *
 * **Phase 64 scope**: the hook calls `openPlayer` with the
 * first track. The consumer's `loadPlaylistToPlayer` dispatch
 * is still required if the consumer's Queue UI needs to read
 * the playlist. **Phase 65** absorbs that step too.
 */
export function useOpenPlaylist(): UseOpenPlaylistResult {
  const {openPlayer} = usePlayerActivity();

  const openPlaylist = useCallback(
    async (
      entries: PlayableEntry[],
      opts: OpenPlaylistOptions = {},
    ): Promise<boolean> => {
      // Defensive: empty list is a no-op.
      if (!entries || entries.length === 0) return false;

      const type = opts.type ?? 'audio';

      // Resolve the start index. If shuffle is on and no
      // explicit startIndex, pick a random non-zero index.
      // (If shuffle lands on 0 by chance, the first track plays
      // first — that's fine, the shuffle just orders the rest.)
      let startIndex = opts.startIndex ?? 0;
      let orderedEntries: PlayableEntry[] = entries;

      if (opts.shuffle) {
        // Fisher-Yates shuffle a copy. Don't mutate the input.
        orderedEntries = entries.slice();
        for (let i = orderedEntries.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [orderedEntries[i], orderedEntries[j]] = [
            orderedEntries[j],
            orderedEntries[i],
          ];
        }
        if (opts.startIndex == null) {
          startIndex = Math.floor(Math.random() * orderedEntries.length);
        }
      }

      // Clamp startIndex to the valid range. A consumer that
      // passes `startIndex: 99` for a 3-entry list gets index 2.
      if (startIndex < 0) startIndex = 0;
      if (startIndex >= orderedEntries.length) {
        startIndex = orderedEntries.length - 1;
      }

      const start = orderedEntries[startIndex];
      if (!start) return false;

      return openPlayer({
        uri: start.uri,
        title: start.title,
        type,
        startPositionMs: opts.startPositionMs,
        ...(opts.startExtras as Partial<OpenPlayerOptions>),
      });
    },
    [openPlayer],
  );

  return {openPlaylist};
}
