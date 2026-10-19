/**
 * @simba/react-native-media-player — public API surface.
 *
 * The surface is three things:
 *
 *  - `usePlayer()` — the player's live state plus the command set
 *    (play / pause / seek / volume / speed / tracks / PiP and the
 *    rest). The commands are wired to the `MpvPlayerModule` bridge,
 *    so they act on the real mpv instance rather than on a stub.
 *  - `usePlayerProgress()` — position, duration and the buffer /
 *    cache fields, split out from `usePlayer()` so a scrubber does
 *    not re-render on every volume or track change. The values come
 *    from the native mpv event stream (4 Hz after native
 *    coalescing) plus a one-shot hydration read at mount — there is
 *    no JS-side timer polling the bridge.
 *  - `<SimbaVideo>` — the video picture. It is an ordinary view in
 *    the consumer's own React tree, so React Native owns the
 *    layout, the z-order and the lifecycle. Playback and
 *    Picture-in-Picture are properties of the engine, not of the
 *    view, so they work from any component via
 *    `usePlayer().commands`.
 *
 * `<SimbaPlayer>` is the one-import, one-wrapper integration point:
 * it mounts `<PlayerProvider>` (state + commands) and the resume
 * lookup for you. A consumer that drives the player itself wraps its
 * tree in `<PlayerProvider>` once and renders `<SimbaVideo>` for the
 * picture.
 */

export {
  PlayerProvider,
  usePlayerConfig,
  useTheme,
  useRenderControls,
  type PlayerProviderProps,
  type RenderControlsFn,
} from './components/PlayerProvider';

export { PlayerRoot } from './components/PlayerRoot';

export {
  SimbaVideo,
  type SimbaVideoProps,
  type SimbaVideoResizeMode,
} from './components/SimbaVideo';

export { PlayerSurface, type PlayerSurfaceProps } from './components/PlayerSurface';

export {
  DefaultControls,
  type DefaultControlsProps,
} from './components/DefaultControls';

export {
  type AudioConfig,
  type DebugConfig,
  type HardwareDecodingPolicy,
  type NotificationConfig,
  type PipConfig,
  type PlayerConfig,
  type PlayerTheme,
  type ResolvedPlayerConfig,
  type SubtitleConfig,
  DEFAULT_PLAYER_CONFIG,
  DEFAULT_THEME,
  resolvePlayerConfig,
} from './types/config';

export {
  usePlayer,
  usePlayerProgress,
  toMpvPropertyString,
  type PlayerCommands,
  type PlayerProgress,
  type PlayerState,
  type PlaylistEntry,
  type UsePlayerResult,
} from './types/player';

export {
  usePlayerActivity,
  type OpenPlayerOptions,
  type UsePlayerActivityResult,
} from './hooks/usePlayerActivity';

export {
  PlayerResumeProvider,
  useOpenWithResume,
  usePlayItem,
  resolveStreamType,
  type ContentKind,
  type PlayerResumeLookup,
  type PlayerResumeProviderProps,
} from './hooks/useOpenWithResume';

export {SimbaPlayer, type SimbaPlayerProps, type ResumePolicy} from './hooks/SimbaPlayer';
export {useOpenFromUrl} from './hooks/useOpenFromUrl';
export {
  useOpenPlaylist,
  type PlayableEntry,
  type OpenPlaylistOptions,
  type UseOpenPlaylistResult,
} from './hooks/useOpenPlaylist';
export {
  useQueue,
  useQueueLength,
  useQueueItems,
  useQueueItemsAs,
  usePlaybackHistory,
  usePlaybackHistoryAs,
  type PlayerQueueItem,
  type PlayerQueueStore,
} from './hooks/useQueue';
export {
  useQueueSelection,
  useQueueSelectedIndices,
  type PlayerQueueSelectionStore,
} from './hooks/useQueueSelection';
// v1.10.0 — the "frame at the position you left off" thumbnail. The
// first genuinely PUBLIC frame API: `screenshot` / `captureThumbnail`
// live in the bridge but were never exported here, so a consumer had
// no supported way to reach them. `captureFrame` needs no player
// instance — see the wrapper's docblock for the `null` contract.
export {
  captureFrame,
  DEFAULT_FRAME_WIDTH,
  DEFAULT_FRAME_HEIGHT,
  DEFAULT_FRAME_QUALITY,
  type CaptureFrameOptions,
} from './hooks/useResumeThumbnail';
// V21 F5 — the load half of `<PlayerRoot>`, and the in-window launch
// primitive. Video no longer starts an Activity, so a consumer that
// wants to play media into its own already-mounted surface drives it
// from here: pass the payload, and `useLaunchPlayback` loads it exactly
// once. See its docstring for the once-per-payload contract.
export {useLaunchPlayback} from './hooks/useLaunchPlayback';

export {
  getMpvPlayerModule,
  subscribePlayerEvent,
  removeAllListeners,
  setDebugLogging,
  dumpObservedProperties,
  type MpvPlayerModuleBridge,
  type PlayerEventName,
  type PlayerEventPayloads,
  type LaunchParams,
  type MpvPlaybackState,
  type MpvLoopMode,
  type MpvTrack,
  type MpvChapter,
  type MpvFileInfo,
  type MpvVideoParams,
  type MpvAudioDevice,
} from './bridge/MpvPlayerModule';
