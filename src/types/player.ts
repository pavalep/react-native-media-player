import { useMemo } from 'react';
import { getMpvPlayerModule, dlog } from '../bridge/MpvPlayerModule';

/**
 * Snapshot of the player's runtime state. Phase 24 entry point —
 * `state.title / artist / album / isPlaying` come from mpv events
 * (Phase 24 still ships defaults — the mpv-event subscription lands
 * in Phase 25 when the activity swap happens); `positionMs` /
 * `durationMs` come from `usePlayerProgress()` so they update
 * independently of the rest of the state.
 */
export interface PlayerState {
  /** True when mpv is actively playing (not paused, not stopped). */
  isPlaying: boolean;
  /** Track title (from mpv `media-title` → launch title → "Simba Player"). */
  title: string;
  /** Track artist (from mpv `metadata/by-key/artist`). Empty when untagged. */
  artist: string;
  /** Track album (from mpv `metadata/by-key/album`). Empty when untagged. */
  album: string;
}

/**
 * Position + duration. Returned by `usePlayerProgress()` so it can
 * update at a different cadence than `usePlayer()` (1Hz for
 * progress vs once-per-event for the rest of the state). Consumers
 * that don't render a scrubber / time labels can opt out of the
 * 1Hz re-render storm by NOT calling `usePlayerProgress()`.
 */
export interface PlayerProgress {
  /** Current playback position in milliseconds. 0 when no file is loaded. */
  positionMs: number;
  /** Total duration in milliseconds. 0 when unknown (mpv hasn't parsed yet). */
  durationMs: number;
}

/**
 * Player commands. Phase 24 wires the play / pause / seek methods
 * to `MpvPlayerModule` bridge calls — the methods are no longer
 * stub no-ops, they call `MPVLib.nativePlay / nativePause /
 * nativeSeek` via the React Native bridge.
 */
export interface PlayerCommands {
  /** Resume playback (or start playback of the current file). */
  play(): void;
  /** Pause playback (mpv remains at the current position). */
  pause(): void;
  /** Seek to an absolute position in milliseconds. */
  seek(positionMs: number): void;
  /** Skip backward by N seconds (clamps at 0). */
  skipBackward(seconds: number): void;
  /** Skip forward by N seconds. */
  skipForward(seconds: number): void;
}

/** Combined result from `usePlayer()`. */
export interface UsePlayerResult {
  state: PlayerState;
  commands: PlayerCommands;
}

/**
 * Phase 24 default state used until mpv events wire in (Phase 25).
 * `title` falls back to "Simba Player" so the top bar shows
 * something rather than an empty string during the cold-start
 * window before the first `onFileLoaded` event fires.
 */
const DEFAULT_STATE: PlayerState = {
  isPlaying: false,
  title: 'Simba Player',
  artist: '',
  album: '',
};

/** Phase 24 default progress (Phase 25 wires to 1Hz bridge poll). */
const DEFAULT_PROGRESS: PlayerProgress = {
  positionMs: 0,
  durationMs: 0,
};

/**
 * Hook returning the player's current state + commands.
 *
 * Phase 24 wires the commands to `MpvPlayerModule` (so play / pause /
 * seek actually drive mpv when the native side is wired) but keeps
 * `state` at the defaults. Phase 25 adds the mpv-event
 * subscription that updates `state.title / artist / album /
 * isPlaying` from `onFileLoaded`, `onEndFile`, `onPlaybackRestart`
 * events.
 */
export function usePlayer(): UsePlayerResult {
  const bridge = useMemo(getMpvPlayerModule, []);
  return useMemo<UsePlayerResult>(
    () => ({
      state: DEFAULT_STATE,
      commands: {
        play: () => {
          // Phase 39: log bridge calls when verbose logging is on.
          // Helps debug "play button doesn't do anything" by showing
          // whether the bridge call is being made at all + what arg.
          dlog('commands.play()');
          bridge.play();
        },
        pause: () => {
          dlog('commands.pause()');
          bridge.pause();
        },
        seek: (positionMs: number) => {
          dlog('commands.seek(positionMs=', positionMs, ')');
          // Convert ms → seconds for the bridge (mpv's nativeSeek
          // takes a Double in seconds; PlayerCommands uses ms for
          // ergonomic JS-side arithmetic).
          bridge.seekAbsolute(positionMs / 1000);
        },
        skipBackward: (seconds: number) => {
          dlog('commands.skipBackward(', seconds, ')');
          bridge.seekBackward(seconds);
        },
        skipForward: (seconds: number) => {
          dlog('commands.skipForward(', seconds, ')');
          bridge.seekForward(seconds);
        },
      },
    }),
    [bridge],
  );
}

/**
 * Phase 24 hook: returns position + duration. Separate from
 * `usePlayer()` so consumers that don't render a scrubber (just
 * play/pause buttons) don't pay the 1Hz re-render cost.
 *
 * Phase 24 returns the defaults (0 / 0). Phase 25 wires to a
 * 1Hz poll of `MpvBridgeModule.getTimePos` + `getDuration` (both
 * `@ReactMethod(isBlockingSynchronousMethod = true)`) or a
 * property-observer subscription on `time-pos` / `duration`.
 */
export function usePlayerProgress(): PlayerProgress {
  return DEFAULT_PROGRESS;
}
