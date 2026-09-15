import { useEffect, useState } from 'react';
import { getMpvPlayerModule, type LaunchParams } from '../bridge/MpvPlayerModule';

/**
 * V13 Phase 54: read the activity's launch params (one-shot).
 *
 * The native `PlayerActivity` is launched with a payload
 * `{uri, title, type, startPositionMs}` from the most recent
 * `openPlayer(...)` call (see `LaunchParams` in
 * `MpvPlayerModule.ts`). The Kotlin side keeps the params as a
 * single-shot queue — the first reader consumes them, subsequent
 * calls return `null`.
 *
 * In the JS layer, this hook is what `PlayerActivity`'s React
 * tree calls to fetch the params (typically in the activity's
 * top-level component, e.g. `AppContent`). After reading, the
 * hook exposes the params as React state so the consumer can:
 *
 *   1. Conditionally render `<PlayerRoot />` (the activity's
 *      player surface + controls) when params are present.
 *   2. Render the regular navigator when no params (e.g. when
 *      launched from the home screen icon, no recent playback
 *      was queued).
 *
 * The hook is **idempotent at the React level** — calling it
 * from multiple components reads the same native one-shot
 * queue. The first mount wins; subsequent mounts see `null`.
 * (This matches the Kotlin-side behavior; the alternative is a
 * shared React state, but that requires hoisting the hook to
 * a common ancestor.)
 *
 * V22.0.0 / 1.5.10 (D-034) activity-aware guard:
 *
 * The previous implementation consumed `lastLaunchParams` from
 * the FIRST React tree to mount. With MainActivity and
 * PlayerActivity both mounting the same `App` component (both
 * wrap in `<SimbaPlayerRoot>`), cold-start races meant stale
 * launchParams from a prior `openPlayer` call would get
 * consumed by MainActivity's React tree, and `<PlayerRoot />`
 * would get rendered over the Home screen.
 *
 * The fix here: before calling `getLaunchParams()` we ask the
 * native module `isCurrentActivityPlayer()` — a synchronous
 * boolean set to `true` by `PlayerActivity.onCreate` and reset
 * to `false` in `PlayerActivity.onDestroy`. When false (we are
 * in MainActivity, a Share Sheet host, or no React host yet),
 * we return `null` *without* calling `getLaunchParams()`, so
 * the single-shot queue stays intact for the eventual
 * PlayerActivity mount to consume.
 *
 * @example
 * ```tsx
 * function AppContent() {
 *   const launchParams = useLaunchParams();
 *   if (launchParams) {
 *     return <PlayerRoot />;
 *   }
 *   return <RootNavigator />;
 * }
 * ```
 *
 * For consumers that just want the data without the React
 * subscription (e.g. for analytics), use
 * `getMpvPlayerModule().getLaunchParams()` directly. Note that
 * a direct call consumes the one-shot queue the same way the
 * hook does — so don't call it twice from `MainActivity`'s
 * tree (it would steal the params from `PlayerActivity`).
 */
export function useLaunchParams(): LaunchParams | null {
  const [params, setParams] = useState<LaunchParams | null>(null);

  useEffect(() => {
    const bridge = getMpvPlayerModule();
    // V22.0.0 / 1.5.10 (D-034): refuse to consume the queue
    // unless we are the player host. see hook comment for why.
    try {
      const isPlayer = bridge.isCurrentActivityPlayer();
      if (!isPlayer) {
        setParams(null);
        return;
      }
    } catch {
      // Bridge didn't expose the guard (pre-1.5.10 lib) — fall
      // through to the legacy one-shot-queue read so older
      // versions of the lib keep working.
    }
    try {
      const next = bridge.getLaunchParams();
      setParams(next);
    } catch {
      // Bridge threw — assume no launch params.
      setParams(null);
    }
  }, []);

  return params;
}
