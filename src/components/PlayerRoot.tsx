import React from 'react';
import { StyleSheet, View } from 'react-native';
import { DefaultControls, type DefaultControlsProps } from './DefaultControls';
import { useRenderControls } from './PlayerProvider';
import { usePlayer } from '../types/player';
import { useLaunchPlayback } from '../hooks/useLaunchPlayback';
import {
  getMpvPlayerModule,
  type LaunchParams,
} from '../bridge/MpvPlayerModule';
import { PlayerSurface } from './PlayerSurface';

/**
 * Phase 23 + Phase 25 root component for the PlayerActivity JS
 * tree.
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
 *     controls (via `renderControls`) or `<DefaultControls>` as
 *     fallback. Absolutely positioned over the surface so the
 *     video fills the screen and the controls layer on top.
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
 * - The fallback path reads `usePlayer()` and passes
 *   `state.title / state.artist` + `commands.play / pause` through
 *   to `<DefaultControls>`.
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
  const { state, commands } = usePlayer();

  // V22.0.0 / 1.5.8 (D-035 fix #3 + #5 + #7): feed the launch URI to
  // mpv exactly once per `(uri, startPositionMs)` payload, NOT once
  // per render. `useLaunchPlayback` owns that contract.
  // The effect is keyed on the URI + start position, so it fires once
  // when the payload resolves to a real URI, then never again until
  // the URI actually changes.
  useLaunchPlayback(launchParams);

  const overlay: React.ReactNode = (() => {
    if (renderControls != null) {
      return renderControls();
    }
    const props: DefaultControlsProps = {
      title: state.title || 'Simba Player',
      subtitle:
        state.artist && state.album
          ? `${state.artist} • ${state.album}`
          : state.artist || state.album || undefined,
      onPlay: commands.play,
      onPause: commands.pause,
      // V22.0.0 / 1.5.8 (D-035 fix #4): the close ✕ button calls
      // `exitPipAndFinish` on the bridge, which dismisses the
      // activity + tears down the SurfaceView properly. Falls back
      // to the no-op `close` command when the bridge is absent
      // (jest / web preview).
      onClose:
        typeof (getMpvPlayerModule().exitPipAndFinish) === 'function'
          ? () => {
              try {
                getMpvPlayerModule().exitPipAndFinish();
              } catch {
                // ignore
              }
            }
          : undefined,
    };
    return <DefaultControls {...props} />;
  })();

  return (
    <View style={styles.root}>
      <PlayerSurface />
      <View style={styles.overlay}>{overlay}</View>
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
