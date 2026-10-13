import { useMemo } from 'react';
import { getMpvPlayerModule } from '../bridge/MpvPlayerModule';
import { loadAndPlay } from '../bridge/loadAndPlay';

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
   * `'video'` loads into the mounted surface; `'audio'` starts the
   * foreground media service and plays with no surface at all.
   *
   * That fork lives here rather than at the call sites on purpose.
   * Three separate entry points reach this hook (`openPlayer`,
   * `useOpenWithResume`, `useOpenPlaylist`) and a consumer has no way to
   * tell which one a given screen uses. Deciding "does audio need a
   * surface?" at each of those would mean three places to keep in sync,
   * and the one forgotten would start a foreground service for a track
   * with no notification artwork.
   */
  type: 'video' | 'audio';
  /** Resume position in milliseconds. 0 (or omitted) starts from the beginning. */
  startPositionMs?: number;
  /**
   * Optional artwork for the media notification's large icon — a local
   * path, `file://`, or an `http(s)` URL.
   *
   * Audio only: video renders into the consumer's own surface and the
   * module never builds a notification for it, so it has nothing to be
   * handed. Consumed by `startAudioPlayback`; ignored on the video path,
   * which is why passing it unconditionally is safe.
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
 * Thin wrapper around the two launch paths, kept as a hook rather than a
 * bare function so a consumer can `jest.mock` the whole module when it
 * needs to stub launching from a test.
 *
 * Why a separate hook (not just `usePlayer().commands.openPlayer`):
 *  - `usePlayer()` requires a `<PlayerProvider>` ancestor for live state;
 *    launch calls happen from screen components (lists, grids) that are
 *    not inside a player subtree.
 *  - Returning a smaller surface keeps the screen-side code
 *    self-documenting: "this screen launches the player" vs
 *    "this screen is inside the player".
 *
 * ## Video loads in-window (V21 F5)
 *
 * Video used to be handed to a dedicated `PlayerActivity` via
 * `startActivity`. That is gone: the module now loads into the surface
 * the consumer already has mounted, which is the whole reason the
 * two-Activity architecture was removed — a `SurfaceView`'s Surface
 * belongs to its window, so a second window made an in-app video
 * mini-player impossible to build honestly.
 *
 * **The video branch refuses when no surface is mounted** and resolves
 * `false`. Loading into nothing would start audio with no picture and
 * report success, which is the "looks live and is not" failure this
 * module exists to avoid. Presentation stays with the consumer's
 * surface controller; this only decides *whether the load can happen*.
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
   * Launch the given media. For `audio` this starts the foreground
   * media service; for `video` it loads into the mounted surface.
   * Resolves `true` when the launch was dispatched and `false`
   * otherwise — audio could not start the service, or video was asked
   * for while no surface was mounted, or the bridge is in no-op mode
   * (jest / web preview, where there is no engine and no surface).
   */
  openPlayer(opts: OpenPlayerOptions): Promise<boolean>;
}

export function usePlayerActivity(): UsePlayerActivityResult {
  return useMemo<UsePlayerActivityResult>(
    () => ({
      openPlayer: (opts) => {
        const bridge = getMpvPlayerModule();
        const startPositionMs = opts.startPositionMs ?? 0;

        // Audio never touches a surface. See `OpenPlayerOptions.type`.
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

        // Video: refuse rather than load into nothing. See the class
        // docblock — reporting success here would start playback the
        // user cannot see and the caller cannot detect.
        if (!bridge.isSurfaceMounted()) {
          return Promise.resolve(false);
        }

        loadAndPlay(bridge, {
          uri: opts.uri,
          title: opts.title,
          startPositionMs,
        });
        return Promise.resolve(true);
      },
    }),
    [],
  );
}