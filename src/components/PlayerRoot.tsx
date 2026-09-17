import React, { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import { DefaultControls, type DefaultControlsProps } from './DefaultControls';
import { useRenderControls } from './PlayerProvider';
import { usePlayer } from '../types/player';
import { useLaunchParams } from '../hooks/useLaunchParams';
import {
  getMpvPlayerModule,
  type LaunchParams,
} from '../bridge/MpvPlayerModule';
import { PlayerSurface } from './PlayerSurface';

/**
 * Phase 23 + Phase 25 root component for the PlayerActivity JS
 * tree.
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
  launchParams: launchParamsProp,
}: PlayerRootProps = {}): React.ReactElement {
  const renderControls = useRenderControls();
  const { state, commands } = usePlayer();
  // V22.0.0 / 1.5.8 (D-035 fix #5): prefer the parent's resolved
  // value when it was supplied (the SimbaPlayerRoot path). Fall back
  // to the hook ONLY when the prop was omitted — direct consumers
  // that mount PlayerRoot without SimbaPlayerRoot still need a way
  // to learn the launch params, and the hook is the only entry point
  // in that case.
  const ownLaunchParams = useLaunchParams();
  const launchParams = launchParamsProp ?? ownLaunchParams;

  // V22.0.0 / 1.5.8 (D-035 fix #3 + #5 + #7): feed the launch URI
  // to mpv exactly once per `(uri, startPositionMs)` payload, NOT
  // once per render. The previous version (D-035 #3) called
  // `bridge.loadFile(uri)` synchronously in the render body — but
  // `<PlayerProvider>` re-renders the whole tree ~once per second
  // (the 1Hz position-poll drives `state` updates). Every one of
  // those re-renders fired another `loadFile`, which is wasteful
  // and on some Android builds can race with mpv's own internal
  // state, knocking the surface back to black for a frame.
  //
  // The `useEffect` keyed on the URI+start position string fires
  // once when the props/hook resolve to a real payload, then never
  // again until the URI actually changes (i.e. another
  // `openPlayer` round-trip with a different media).
  const uri = launchParams?.uri ?? null;
  const startPositionSec = launchParams?.startPositionMs
    ? launchParams.startPositionMs / 1000
    : 0;
  const launchKey = uri != null ? `${uri}|${startPositionSec}` : null;
  useEffect(() => {
    if (launchKey == null) return;
    const bridge = getMpvPlayerModule();
    try {
      bridge.loadFile(uri!);
      if (startPositionSec > 0) {
        bridge.seekAbsolute(startPositionSec);
      }
      bridge.play();
    } catch {
      // Bridge not present (jest/web) — ignore.
    }
    // launchKey intentionally drives the dep list. The individual
    // `uri` / `startPositionSec` reads are derived from the same
    // `launchParams` object, so they'll be consistent across a
    // single effect run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [launchKey]);

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
