import type { ViewProps } from 'react-native';
import type {
  Double,
  Float,
  WithDefault,
} from 'react-native/Libraries/Types/CodegenTypes';
import codegenNativeComponent from 'react-native/Libraries/Utilities/codegenNativeComponent';

/**
 * Codegen spec for the native mpv video surface.
 *
 * This is the component that makes the picture an ordinary child of the React
 * tree instead of a sibling of the React root. Everything else about SIMBA's
 * video lane follows from that:
 *
 *  - React Native owns layout, so the surface gets a real Yoga measure/layout
 *    pass. The old path mutated `LayoutParams` straight from Kotlin, which
 *    `react-native-video` documents as a hazard - see its `ExoPlayerView`
 *    `requestLayout()` override: "React Native (Yoga) can sometimes defer
 *    layout passes that are required by ... surface view".
 *  - React Native owns z-order, so the video no longer sits behind an opaque
 *    React root and no screen has to blank itself around it.
 *  - React Native owns the lifecycle, so mount/unmount is the same event for
 *    the surface as for any other view.
 *
 * No events are declared in this first revision, deliberately. `MPVLib`
 * forwards decoded mpv events through `onMpvEvent(event, jsonPayload)`, but
 * which event names the C++ layer actually emits has not been verified against
 * a running instance. Shipping an `onReadyForDisplay` prop that never fires
 * would be worse than not shipping it: it would look like a working
 * first-frame signal while being decorative. Events get added once they can be
 * observed.
 */
export interface NativeProps extends ViewProps {
  /**
   * The mpv handle to bind this surface to, from `getNativePtr()`.
   *
   * `Double`, not `Int32`: mpv handles are 64-bit pointers and an `Int32`
   * prop would truncate them to 32 bits. Codegen maps `Double` to a Kotlin
   * `double`, which carries the full range.
   *
   * May be omitted before the player is initialised. `MpvRenderView` treats a
   * zero handle as "not bindable yet" and re-attaches from `onAttachedToWindow`
   * once a real handle arrives, so an app that renders the view on first paint
   * does not have to wait for the bridge.
   */
  nativePtr?: Double;

  /**
   * Pause playback. Declarative: set it and the surface pauses, exactly like
   * `react-native-video`'s `paused` prop.
   *
   * Audio-only playback is the case where no view is rendered at all - the
   * engine keeps running with no render target, which is the correct
   * configuration for mpv.
   */
  paused?: WithDefault<boolean, false>;

  /** Mute. Mirrors `PlayerCommands.setMuted`. */
  muted?: WithDefault<boolean, false>;

  /**
   * Playback volume, 0..100 - mpv's native range, matching the range
   * `PlayerCommands.setVolume` already exposes. No 0..1 rescaling: one unit
   * system end to end, so a value read from the engine is a value you can hand
   * straight back to it.
   */
  volume?: WithDefault<Float, 100>;

  /**
   * How the picture fills this view.
   *
   *  - `contain` - fit inside, letterboxed. Default, and what every shipping
   *    media app uses for fullscreen video.
   *  - `cover`   - fill the view, cropping the overflow, aspect preserved.
   *  - `stretch` - fill the view, aspect ignored.
   *
   * Maps onto mpv's `video-zoom` (0 / 1 / 2) rather than being reimplemented,
   * so it inherits mpv's own scaling and rounding behaviour.
   */
  resizeMode?: WithDefault<string, 'contain'>;
}

export default codegenNativeComponent<NativeProps>('SimbaVideoView');