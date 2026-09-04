import { useMemo } from 'react';
import {
  getMpvPlayerModule,
  type LaunchParams,
} from '../bridge/MpvPlayerModule';

/**
 * Options accepted by `usePlayerActivity().openPlayer(opts)`. This is
 * the V13 module-level signature — the consumer's V11 `openPlayer`
 * took `{uri, title, duration, source, type, mediaType}` (the
 * extra fields were Redux-dispatch concerns that V13 drops because
 * there's no Redux dispatch path anymore).
 */
export interface OpenPlayerOptions {
  /** Media URI (`file://`, `content://`, or `https://`). */
  uri: string;
  /** Display title for the notification / top bar. */
  title: string;
  /** `'video'` launches the full-screen activity; `'audio'` plays in the background. */
  type: 'video' | 'audio';
  /** Resume position in milliseconds. 0 (or omitted) starts from the beginning. */
  startPositionMs?: number;
}

/**
 * V13 Phase 52: thin wrapper around `bridge.openPlayer` +
 * `bridge.getLaunchParams`. Replaces the consumer's V11
 * `usePlaybackCommands()` hook for the 33+ call sites that
 * previously launched `PlayerActivity` from screens like
 * `NowPlaying`, `AllVideos`, `Bookmarks`, etc.
 *
 * Why a separate hook (not just `usePlayer().commands.openPlayer`):
 *  - `usePlayer()` requires a `<PlayerProvider>` ancestor for
 *    live state; the activity-launch calls happen from screen
 *    components (lists, grids) that are NOT inside the player
 *    activity yet.
 *  - Returning a smaller surface keeps the screen-side code
 *    self-documenting: "this screen launches the player" vs
 *    "this screen is inside the player".
 *  - Easier to mock in consumer-side tests (jest.mock the
 *    whole `usePlayerActivity` module).
 *
 * The hook is non-throwing: the bridge resolves to a no-op
 * fallback in jest / web previews, so `openPlayer` resolves with
 * `false` and `getLaunchParams` returns `null` — both clearly
 * falsy, easy to assert against.
 *
 * @example
 * ```tsx
 * function NowPlaying() {
 *   const { openPlayer } = usePlayerActivity();
 *   const onPressSong = (song: Song) => {
 *     openPlayer({
 *       uri: song.uri,
 *       title: song.title,
 *       type: song.hasVideo ? 'video' : 'audio',
 *       startPositionMs: song.resumePositionMs,
 *     });
 *   };
 *   // ...
 * }
 * ```
 */
export interface UsePlayerActivityResult {
  /**
   * Launch the dedicated `PlayerActivity` with the given media.
   * Resolves with `true` on a successful `startActivity` and
   * `false` otherwise (e.g. when the activity is unavailable on
   * the device, the URI is unplayable, or the bridge is in
   * no-op mode).
   */
  openPlayer(opts: OpenPlayerOptions): Promise<boolean>;
  /**
   * One-shot accessor for the launch params the most recent
   * `openPlayer` call handed to `PlayerActivity`. Returns
   * `null` when called from MainActivity or after the first
   * read has already consumed the value. The Kotlin side
   * keeps a single-shot queue, so call this exactly once
   * per `PlayerActivity.onCreate`.
   */
  getLaunchParams(): LaunchParams | null;
}

export function usePlayerActivity(): UsePlayerActivityResult {
  return useMemo<UsePlayerActivityResult>(
    () => ({
      openPlayer: (opts) => {
        const bridge = getMpvPlayerModule();
        return bridge.openPlayer(
          opts.uri,
          opts.title,
          opts.type,
          opts.startPositionMs ?? 0,
        );
      },
      getLaunchParams: () => {
        const bridge = getMpvPlayerModule();
        return bridge.getLaunchParams();
      },
    }),
    [],
  );
}
