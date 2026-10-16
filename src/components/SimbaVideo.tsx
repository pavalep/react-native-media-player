import React, { useMemo } from 'react';
import { StyleSheet } from 'react-native';

import { getMpvPlayerModule } from '../bridge/MpvPlayerModule';
import NativeSimbaVideoView from '../specs/SimbaVideoViewNativeComponent';
import type { NativeProps as NativeSimbaVideoViewProps } from '../specs/SimbaVideoViewNativeComponent';

export type SimbaVideoResizeMode = 'contain' | 'cover' | 'stretch';

export interface SimbaVideoProps extends NativeSimbaVideoViewProps {
  /**
   * How the picture fills this view. Maps onto mpv's `video-zoom`
   * (0 / 1 / 2) rather than being reimplemented.
   *
   * @default 'contain'
   */
  resizeMode?: SimbaVideoResizeMode;
}

/**
 * The video picture, as an ordinary React Native view.
 *
 * This is the whole point of the component: the surface is a **child of the
 * React tree**, not a sibling of the React root. Everything that made video
 * awkward follows from that one fact being fixed — React Native owns the
 * layout, the z-order and the lifecycle, so no screen has to blank itself
 * around the player and no code has to hand window coordinates to the engine.
 *
 * ```tsx
 * <SafeAreaView style={{ flex: 1, backgroundColor: '#000' }}>
 *   <Header title={state.title} onBack={commands.pause} />
 *   <SimbaVideo style={StyleSheet.absoluteFill} />
 *   <Controls onPlay={commands.togglePlayPause} onPip={commands.enterPip} />
 * </SafeAreaView>
 * ```
 *
 * ## Controlling it
 *
 * There is deliberately no ref. Playback and Picture-in-Picture are properties
 * of the **engine** and the **Activity**, not of this view, so they already
 * live on `usePlayer().commands` and work from any component, anywhere:
 *
 * ```tsx
 * const { commands } = usePlayer();
 * commands.play();  commands.pause();  commands.setVolume(50);
 * commands.seek(30_000);  commands.enterPip();  commands.next();
 * ```
 *
 * A view-addressed `enterPictureInPicture()` would be strictly worse: PiP is
 * requested exactly when the fullscreen view is about to unmount, so an
 * implementation that needed a live view would fail at the one moment it
 * matters.
 *
 * ## Audio needs none of this
 *
 * Audio-only playback renders no view at all. The engine runs with no render
 * target, which is mpv's correct configuration for audio, and every command
 * above keeps working.
 */
export function SimbaVideo(props: SimbaVideoProps): React.ReactElement {
  const { nativePtr, resizeMode = 'contain', paused, muted, volume, style, ...rest } = props;

  /**
   * `PlayerProvider` calls `initPlayer()` on mount, and the native side
   * short-circuits when a handle already exists, so inside a provider the
   * handle is always available before any child renders. Resolving it during
   * render rather than in an effect is deliberate: an effect would mount the
   * surface unbound first and leave `MpvRenderView` waiting for a
   * `setNativePtr` that only arrives on a later commit.
   *
   * Outside a provider, or when an app manages more than one engine, pass
   * `nativePtr` explicitly.
   */
  const resolvedPtr = useMemo(
    () => nativePtr ?? getMpvPlayerModule().getNativePtr(),
    [nativePtr],
  );

  const videoZoom = useMemo(() => {
    switch (resizeMode) {
      case 'cover':
        return '1';
      case 'stretch':
        return '2';
      case 'contain':
      default:
        return '0';
    }
  }, [resizeMode]);

  return (
    <NativeSimbaVideoView
      {...rest}
      nativePtr={resolvedPtr}
      paused={paused ?? false}
      muted={muted ?? false}
      volume={volume ?? 100}
      resizeMode={videoZoom}
      style={[styles.fill, style]}
    />
  );
}

const styles = StyleSheet.create({
  /**
   * Full-bleed by default, so a caller who forgets a style gets a sensible
   * picture rather than a zero-height view. A zero-height surface renders no
   * frames and reports no error anywhere, which is the worst possible failure
   * mode for a video component.
   *
   * Written out rather than using `StyleSheet.absoluteFill*`, which is not
   * declared on the `StyleSheet` type in React Native 0.86.
   */
  fill: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
});