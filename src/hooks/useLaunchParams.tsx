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
 * hook does — so don't call it twice.
 */
export function useLaunchParams(): LaunchParams | null {
  const [params, setParams] = useState<LaunchParams | null>(null);

  useEffect(() => {
    const bridge = getMpvPlayerModule();
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
