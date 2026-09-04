import React from 'react';
import { PlayerRoot } from '../components/PlayerRoot';
import { useLaunchParams } from './useLaunchParams';

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
}

/**
 * The activity-branch wrapper. Mounts `<PlayerRoot />` when the
 * activity was launched with playback params, otherwise renders
 * `children`. See `SimbaPlayerRootProps` for usage.
 */
export function SimbaPlayerRoot({
  children,
}: SimbaPlayerRootProps): React.ReactElement {
  const launchParams = useLaunchParams();

  if (launchParams) {
    return <PlayerRoot />;
  }

  return <>{children}</>;
}
