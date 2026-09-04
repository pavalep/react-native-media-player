/**
 * @simba/react-native-media-player — public API surface.
 *
 * Phase 24 entry point — replaces the Phase 23 minimal DefaultControls
 * stub with the full polished UI (top bar + scrubber + transport +
 * auto-hide). `usePlayer()` commands are now wired to the
 * `MpvPlayerModule` bridge (so play / pause / seek actually drive
 * mpv); `usePlayerProgress()` is a separate hook for position /
 * duration that Phase 25 wires to a 1Hz bridge poll.
 *
 * Phase 25 will add the loading / error / buffer indicator in the
 * center area, swap App.tsx to wrap with `<PlayerProvider>`, and
 * wire `usePlayerProgress()` to native. Phase 30 (Wave 6) wires
 * the TypeScript build pipeline so this file is the actual
 * `package.json` `main` entry.
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

export {SimbaPlayer, type SimbaPlayerProps} from './hooks/SimbaPlayer';
export {useLaunchParams} from './hooks/useLaunchParams';

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
