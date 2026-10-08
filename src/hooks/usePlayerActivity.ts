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
  /**
   * `'video'` opens `PlayerActivity`. `'audio'` does NOT — it starts the
   * foreground media service and plays with no window at all.
   *
   * That fork lives here rather than at the call sites on purpose.
   * Three separate entry points reach this hook (`openPlayer`,
   * `useOpenWithResume`, `useOpenPlaylist`) and a consumer has no way to
   * tell which one a given screen uses. Deciding "does audio need a
   * window?" at each of those would mean three places to keep in sync,
   * and the one forgotten would open a blank full-screen player for a
   * track with no surface.
   */
  type: 'video' | 'audio';
  /** Resume position in milliseconds. 0 (or omitted) starts from the beginning. */
  startPositionMs?: number;
  /**
   * Optional artwork for the media notification's large icon — a local
   * path, `file://`, or an `http(s)` URL.
   *
   * Audio only: `PlayerActivity` shows the video frame itself, so it has
   * nothing to be handed. Consumed by `startAudioPlayback`; ignored on
   * the video path, which is why passing it unconditionally is safe.
   */
  artworkPath?: string;
  /**
   * Optional artist / album lines for the notification subtitle.
   * Audio only, for the same reason as `artworkPath`. Both are optional:
   * an untagged file shows a title and nothing else.
   */
  artist?: string;
  album?: string;
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
   * `openPlayer` call handed to `PlayerActivity`. Resolves
   * with `null` when called from MainActivity or after the
   * first read has already consumed the value. The Kotlin
   * side keeps a single-shot queue, so call this exactly
   * once per `PlayerActivity.onCreate`.
   *
   * V22.0.0 / 1.5.8 (D-035 fix #6): the runtime returns a
   * Promise (Kotlin `@ReactMethod` async). The previous sync
   * return type was a type lie — the hook stored the
   * Promise in `useState`, `if (launchParams != null)` was
   * true (Promise is truthy), and downstream `bridge.loadFile`
   * got `undefined` → `IllegalArgumentException` at the
   * Kotlin bridge. Callers must `await` this.
   */
  getLaunchParams(): Promise<LaunchParams | null>;
}

export function usePlayerActivity(): UsePlayerActivityResult {
  return useMemo<UsePlayerActivityResult>(
    () => ({
      openPlayer: (opts) => {
        const bridge = getMpvPlayerModule();
        const startPositionMs = opts.startPositionMs ?? 0;

        // Audio never opens a window. See `OpenPlayerOptions.type`.
        if (opts.type === 'audio') {
          return bridge.startAudioPlayback({
            uri: opts.uri,
            title: opts.title,
            startPositionMs,
            // A launch means "play this". The only reason not to would
            // be an explicit pause request, and the way to ask for one
            // is `commands.pause()` after the fact — not a launch that
            // silently does nothing, which is what `autoPlay: false`
            // here would look like to every existing caller.
            autoPlay: true,
            ...(opts.artworkPath ? {artworkPath: opts.artworkPath} : {}),
            ...(opts.artist ? {artist: opts.artist} : {}),
            ...(opts.album ? {album: opts.album} : {}),
          });
        }

        return bridge.openPlayer(
          opts.uri,
          opts.title,
          opts.type,
          startPositionMs,
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
