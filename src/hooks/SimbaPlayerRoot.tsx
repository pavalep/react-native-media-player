import React from 'react';
import { PlayerRoot } from '../components/PlayerRoot';
import { useLaunchParams } from './useLaunchParams';
import { useLaunchPlayback } from './useLaunchPlayback';

/**
 * V14 Phase 59: the activity-branch wrapper.
 *
 * The native `PlayerActivity` is launched with playback params
 * (`{uri, title, type, startPositionMs}`) by any `openPlayer(...)` call.
 * The activity's React tree should render the player surface +
 * controls when those params are present, and the regular app
 * navigator when they're not.
 *
 * Before V14, this branching lived in the consumer's `App.tsx`:
 *
 * ```tsx
 * const launchParams = useLaunchParams();
 * if (launchParams) {
 *   return <PlayerRoot />;
 * }
 * return <YourNavigator />;
 * ```
 *
 * `<SimbaPlayerRoot>` absorbs both the hook call and the switch.
 * Consumers just nest their navigator as children:
 *
 * @example
 * ```tsx
 * <SimbaPlayer getResumePosition={...}>
 *   <SimbaPlayerRoot>
 *     <YourNavigator />
 *   </SimbaPlayerRoot>
 * </SimbaPlayer>
 * ```
 *
 * The activity branch is opaque: the consumer cannot customize what
 * is rendered when `launchParams` is non-null. The module owns the
 * player surface + controls. If a consumer needs a different
 * activity surface (rare), they should use `PlayerRoot` directly
 * with `useLaunchParams()`.
 *
 * **Why this exists:** V14's junior-dev-level integration goal is
 * that any consumer's `App.tsx` looks the same. The launch-params
 * branch is the second-largest source of glue after the resume
 * lookup and the deep-link handler — Phase 59 deletes it from the
 * consumer's `App.tsx`.
 */
export interface SimbaPlayerRootProps {
  /**
   * The regular app content (typically a navigator). Rendered when
   * the activity was launched WITHOUT playback params — i.e., the
   * user just opened the app from the launcher or the home screen
   * icon, with no recent `openPlayer(...)` handoff queued.
   */
  children: React.ReactNode;

  /**
   * `1.8.0` — let the consumer own the player UI.
   *
   * `false` (the default, and every pre-1.8.0 behaviour) mounts
   * `<PlayerRoot />` — the module's built-in surface + controls —
   * whenever launch params are present. `children` renders only when
   * there is nothing to play.
   *
   * `true` splits the two concerns that `PlayerRoot` bundles
   * together: the module keeps the **load lifecycle**
   * (`useLaunchPlayback`, so the payload is still loaded exactly once)
   * while the consumer keeps the **UI** — `children` renders
   * unconditionally, and the consumer is responsible for showing it
   * only while something is playing.
   *
   * ## Why a consumer needs this
   *
   * `<PlayerRoot>` returns the module's default controls *instead of*
   * `children`, so any custom chrome passed as children is discarded
   * exactly when playback starts — which makes a bespoke player screen
   * unreachable. `headless` is the supported way to keep the load
   * guarantee without surrendering the UI.
   *
   * @example
   * ```tsx
   * <SimbaPlayerRoot headless>
   *   <MyNavigator />
   * </SimbaPlayerRoot>
   * ```
   */
  headless?: boolean;
}

/**
 * The activity-branch wrapper. Mounts `<PlayerRoot />` when the
 * activity was launched with playback params, otherwise renders
 * `children`. See `SimbaPlayerRootProps` for usage.
 *
 * V22.0.0 / 1.5.8 (D-035 fix #5 — `loadFile(null)` race): this
 * component is the **single owner** of the one-shot `useLaunchParams()`
 * queue. The hook reads `lastLaunchParams` once; a second consumer
 * (PlayerRoot calling its own `useLaunchParams()`) would see `null`.
 * We pass the resolved `launchParams` down to `<PlayerRoot>` as a
 * prop, so the player root never re-reads the queue. Direct
 * consumers that mount `<PlayerRoot>` without `<SimbaPlayerRoot>`
 * still get the hook fallback (PlayerRoot's `launchParams?` prop is
 * optional).
 */
export function SimbaPlayerRoot({
  children,
  headless = false,
}: SimbaPlayerRootProps): React.ReactElement {
  const launchParams = useLaunchParams();

  // `1.8.0` headless mode: the module keeps the load guarantee and
  // hands the UI back to the consumer.
  //
  // Gated on `headless` on purpose. In the default (non-headless)
  // path `<PlayerRoot>` runs the SAME hook, and two hook instances
  // holding the same payload are two independent effects — the media
  // would be loaded twice per launch, which is the exact regression
  // this extraction was meant to end. So exactly one owner runs it:
  // `<PlayerRoot>` normally, this component only in headless mode.
  useLaunchPlayback(headless ? launchParams : null);

  if (launchParams && !headless) {
    return <PlayerRoot launchParams={launchParams} />;
  }

  return <>{children}</>;
}
