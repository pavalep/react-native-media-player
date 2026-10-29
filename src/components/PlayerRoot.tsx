import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useRenderControls } from './PlayerProvider';
import { useLaunchPlayback } from '../hooks/useLaunchPlayback';
import type { LaunchParams } from '../bridge/MpvPlayerModule';
import { PlayerSurface } from './PlayerSurface';

/**
 * The player's root: the surface, and the consumer's controls over it.
 *
 * ## v2.0.0 — the library draws no chrome
 *
 * Before 2.0.0 this component fell back to `<DefaultControls>` — the
 * 564-line control bundle the library used to ship — whenever the
 * consumer did not pass `renderControls`. That fallback is **gone**.
 * The library renders **no chrome of its own**: the consumer's
 * `renderControls` output, or nothing at all.
 *
 * The overlay is mounted only when there is something to put in it, so
 * a consumer that drives the player itself (the usual case — render
 * `<SimbaVideo />` in your own tree) gets no phantom container over
 * the surface.
 *
 * V21 F5: `launchParams` is now an explicit prop with no implicit
 * fallback. It used to fall back to `useLaunchParams()`, which read a
 * one-shot native queue that only a second Activity ever filled — so the
 * fallback could not fire, and keeping it would have been a branch that
 * looked live and was not. Pass the payload in, or drive loading
 * yourself with the exported `useLaunchPlayback`.
 *
 * Renders the full player UI in two layers:
 *  1. **`<PlayerSurface />`** (Phase 25): the JS-side placeholder
 *     for the native SurfaceView that mpv draws into. Fills the
 *     available space via `flex: 1`.
 *  2. **Controls overlay** (Phase 23 + 24): the consumer's custom
 *     controls, via `renderControls`. Absolutely positioned over the
 *     surface so the video fills the screen and the controls layer on
 *     top.
 *
 * Wiring example for a consumer:
 *
 * @example
 * ```tsx
 * function App() {
 *   return (
 *     <PlayerProvider
 *       config={{ theme: { accent: '#FFD700' } }}
 *       renderControls={() => <MyCustomControls />}
 *     >
 *       <PlayerRoot />
 *     </PlayerProvider>
 *   );
 * }
 * ```
 *
 * Design notes
 * ------------
 * - The controls overlay uses `position: 'absolute'` + the four
 *   insets (`top / left / right / bottom: 0`) so it stretches over
 *   the surface without affecting its layout. The surface owns the
 *   flex layout for the tree; the controls float on top.
 * - When `renderControls` is provided, we render its output
 *   wrapped in the same absolutely-positioned overlay container,
 *   so custom controls don't need to handle their own
 *   positioning — they Just Work over the surface.
 */
/**
 * V22.0.0 / 1.5.8 (D-035 fix #5): optional `launchParams` prop.
 *
 * `<SimbaPlayerRoot>` already calls `useLaunchParams()` once at the
 * activity boundary. If we also called it here, the second read would
 * hit an empty one-shot queue (the first read consumed it) and we'd
 * fall through to the `null` branch — leaving the screen with no
 * media loaded. Letting the parent pass `launchParams` down as a
 * prop means the player root always sees the resolved payload.
 *
 * Direct consumers that mount `<PlayerRoot />` without
 * `<SimbaPlayerRoot>` (rare; legacy V11/V12 patterns) keep working:
 * when `launchParams` is left `undefined` we fall back to the hook,
 * which reads the queue exactly once and returns `null` on
 * subsequent mounts.
 */
export interface PlayerRootProps {
  launchParams?: LaunchParams | null;
}

export function PlayerRoot({
  launchParams,
}: PlayerRootProps = {}): React.ReactElement {
  const renderControls = useRenderControls();

  // V22.0.0 / 1.5.8 (D-035 fix #3 + #5 + #7): feed the launch URI to
  // mpv exactly once per `(uri, startPositionMs)` payload, NOT once
  // per render. `useLaunchPlayback` owns that contract.
  // The effect is keyed on the URI + start position, so it fires once
  // when the payload resolves to a real URI, then never again until
  // the URI actually changes.
  useLaunchPlayback(launchParams);

  // The library draws no chrome. Whatever the consumer supplied is
  // what appears over the surface; if the consumer supplied nothing,
  // there is nothing to draw.
  const controls = renderControls != null ? renderControls() : null;

  return (
    <View style={styles.root}>
      <PlayerSurface />
      {controls != null ? <View style={styles.overlay}>{controls}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
});
