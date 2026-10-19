import { useEffect } from 'react';
import {
  getMpvPlayerModule,
  type LaunchParams,
} from '../bridge/MpvPlayerModule';
import { loadAndPlay } from '../bridge/loadAndPlay';

/**
 * Feed a launch payload to mpv, exactly once per payload.
 *
 * This is the *load lifecycle*, and nothing else. It is deliberately
 * separate from any UI so a consumer can own the player screen while
 * the module still guarantees "these params get loaded exactly once".
 *
 * ## Why the effect, and why keyed on a string
 *
 * The previous implementation called `bridge.loadFile(uri)` in the
 * render body of `<PlayerRoot>`. `<PlayerProvider>` re-renders the
 * whole tree as the native event stream drives `state` updates, so
 * every one of those re-renders fired another `loadFile` —
 * wasteful, and on some Android builds it races with mpv's internal
 * state and knocks the surface back to black for a frame (D-035 #3).
 *
 * Keying the effect on a launch-identity string means it fires once
 * when a real payload appears, then never again for the same launch.
 *
 * The key is `${requestId ?? ''}|${uri}|${startPositionSec}`. The
 * `requestId` prefix is load-bearing, not decoration: without it the
 * key was `uri|position`, which is not unique across launches. That
 * was only ever sound because each launch used to start a fresh
 * Activity (fresh React root → fresh mount → the effect always
 * fired). A consumer that loads into an already-open window keeps
 * this hook mounted, so re-launching the same file at the same
 * position would produce the same key, skip the load, and the user
 * would press play and see nothing. The inline comment above the
 * key carries the same rationale next to the code.
 *
 * `startPositionMs` is converted to seconds because mpv's
 * `seekAbsolute` is in seconds, while the launch payload is authored
 * in milliseconds.
 *
 * ## Contract
 *
 * - A `null`/`undefined` payload is a no-op. The caller is responsible
 *   for deciding whether "no payload" means "nothing to play".
 * - The bridge is read lazily inside the effect, so a module that is
 *   absent (jest, web preview, Storybook) is a silent no-op rather than
 *   a render-time crash. Consumers get a headless player for free in
 *   those environments instead of an exception.
 * - The `catch` is deliberately silent and the `finally` is
 *   deliberately absent: a load failure must surface through mpv's own
 *   `file-loaded` / `end-file` events, which the consumer's state
 *   layer already observes. Swallowing here keeps one failed load from
 *   tearing down the React tree.
 */
export function useLaunchPlayback(
  launchParams: LaunchParams | null | undefined,
): void {
  const uri = launchParams?.uri ?? null;
  const title = launchParams?.title ?? undefined;
  const startPositionMs = launchParams?.startPositionMs ?? 0;
  const startPositionSec = startPositionMs > 0 ? startPositionMs / 1000 : 0;
  // A caller-supplied `requestId` ADDS launch identity to the key; it does
  // not replace the uri|position part. Without it the key was `uri|position`,
  // which is not unique across launches: that was only ever sound because
  // each launch used to start a fresh Activity (fresh React root → fresh
  // mount → always fires). A consumer that loads into an already-open window
  // keeps this hook mounted, so re-launching the same file at the same
  // position would produce the same key, skip the load, and the user would
  // press play and see nothing.
  const requestId = launchParams?.requestId;
  const launchKey =
    uri == null ? null : `${requestId ?? ''}|${uri}|${startPositionSec}`;

  useEffect(() => {
    if (launchKey == null || uri == null) {
      return;
    }
    const bridge = getMpvPlayerModule();
    try {
      // v1.9.3 — `launchParams.title` was READ BY NOTHING here. The
      // launch payload has always carried the real title (it comes
      // straight from the host app's `openPlayer({uri, title})`), and
      // this hook — the one place that actually loads the file — threw
      // it away. Combined with `media-title` never being observed, that
      // is why every player header read "Simba Player".
      //
      // `loadAndPlay` owns the title-then-load ordering now, shared
      // with `usePlayerActivity.openPlayer` so the two entry points
      // cannot drift into loading a file under the wrong title.
      loadAndPlay(bridge, {uri, title, startPositionMs});
    } catch {
      // Bridge not present (jest/web) — ignore.
    }
    // `launchKey` is the dependency, not `uri` / `startPositionSec`:
    // the latter two are derived from the same payload, so they are
    // already consistent within a single effect run, and listing them
    // separately would re-fire the load on an identity-only change.
  }, [launchKey, startPositionSec, uri]);
}
