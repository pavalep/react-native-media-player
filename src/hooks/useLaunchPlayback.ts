import { useEffect } from 'react';
import {
  applyForceMediaTitle,
  getMpvPlayerModule,
  type LaunchParams,
} from '../bridge/MpvPlayerModule';

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
 * whole tree roughly once a second (the 1 Hz position poll drives
 * `state` updates), so every one of those re-renders fired another
 * `loadFile` — wasteful, and on some Android builds it races with
 * mpv's internal state and knocks the surface back to black for a
 * frame (D-035 #3).
 *
 * Keying the effect on `${uri}|${startPositionSec}` means it fires once
 * when a real payload appears, then never again until the URI actually
 * changes — i.e. a subsequent `openPlayer(...)` for different media.
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
  const startPositionSec = launchParams?.startPositionMs
    ? launchParams.startPositionMs / 1000
    : 0;
  const launchKey = uri != null ? `${uri}|${startPositionSec}` : null;

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
      // Must precede `loadFile`: mpv reads the option at load time.
      applyForceMediaTitle(bridge, title);
      bridge.loadFile(uri);
      if (startPositionSec > 0) {
        bridge.seekAbsolute(startPositionSec);
      }
      bridge.play();
    } catch {
      // Bridge not present (jest/web) — ignore.
    }
    // `launchKey` is the dependency, not `uri` / `startPositionSec`:
    // the latter two are derived from the same payload, so they are
    // already consistent within a single effect run, and listing them
    // separately would re-fire the load on an identity-only change.
  }, [launchKey, startPositionSec, uri]);
}
