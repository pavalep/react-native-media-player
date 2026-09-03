import React from 'react';
import { StyleSheet, View } from 'react-native';
import { DefaultControls, type DefaultControlsProps } from './DefaultControls';
import { useRenderControls } from './PlayerProvider';
import { usePlayer } from '../types/player';
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
export function PlayerRoot(): React.ReactElement {
  const renderControls = useRenderControls();
  const { state, commands } = usePlayer();

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
