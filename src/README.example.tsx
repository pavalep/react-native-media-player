/**
 * Phase 32 verification — every code snippet from README.md lives
 * here as a typed example so `tsc --noEmit` catches any drift between
 * the documentation and the public API.
 *
 * This file is excluded from the published tarball via the
 * `files` allow-list in package.json (only `src/` is included;
 * tsc glob is restricted to non-test files).
 */

import React from 'react';
import { NativeModules, Pressable, Text, View } from 'react-native';
import {
  DEFAULT_PLAYER_CONFIG,
  DefaultControls,
  PlayerProvider,
  PlayerRoot,
  PlayerSurface,
  getMpvPlayerModule,
  resolvePlayerConfig,
  usePlayer,
  usePlayerProgress,
  useTheme,
  type PlayerCommands,
  type PlayerConfig,
  type PlayerProgress,
  type PlayerState,
} from './index';

// ── Example 1: Basic usage ────────────────────────────────────────────────
export function BasicUsageExample(): React.ReactElement {
  return (
    <PlayerProvider>
      <PlayerRoot />
    </PlayerProvider>
  );
}

// ── Example 2: Launching a file from JS ───────────────────────────────────
export async function LaunchFileExample(): Promise<void> {
  const { MpvPlayerModule } = NativeModules;
  await MpvPlayerModule.openPlayer(
    'https://archive.org/download/BigBuckBunny_124/Content/big_buck_bunny_720p_surround.mp4',
    'Big Buck Bunny',
    'video',
    0,
  );
}

// ── Example 3: Custom controls via renderControls ─────────────────────────
function MyCustomControls(): React.ReactElement {
  const { state, commands } = usePlayer();
  const theme = useTheme();
  return (
    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
      <Text style={{ color: theme.text }}>{state.title}</Text>
      <Pressable onPress={state.isPlaying ? commands.pause : commands.play}>
        <Text style={{ color: theme.accent, fontSize: 24 }}>
          {state.isPlaying ? '⏸' : '▶'}
        </Text>
      </Pressable>
    </View>
  );
}

export function RenderControlsExample(): React.ReactElement {
  return (
    <PlayerProvider renderControls={() => <MyCustomControls />}>
      <PlayerRoot />
    </PlayerProvider>
  );
}

// ── Example 4: Build fully from scratch ───────────────────────────────────
function MyControls(): React.ReactElement {
  return <Text>my controls</Text>;
}

export function FromScratchExample(): React.ReactElement {
  return (
    <PlayerProvider>
      <View style={{ flex: 1 }}>
        <PlayerSurface />
        <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}>
          <MyControls />
        </View>
      </View>
    </PlayerProvider>
  );
}

// ── Example 5: Full config prop ───────────────────────────────────────────
export function FullConfigExample(): React.ReactElement {
  return (
    <PlayerProvider
      config={{
        theme: { accent: '#00FF88' },
        pip: { enabled: true, autoEnterOnLeave: true },
        audio: { backgroundPlayback: true, respectAudioFocus: true },
        hardwareDecoding: 'auto',
        notifications: { enabled: true, channelId: 'my_app_media' },
        subtitle: { preferredLanguages: ['en'], fontSize: 18 },
        debug: { verboseLogging: false },
      }}
    >
      <PlayerRoot />
    </PlayerProvider>
  );
}

// ── Example 6: Spread-and-override pattern ────────────────────────────────
export function SpreadOverrideExample(): React.ReactElement {
  return (
    <PlayerProvider
      config={{
        ...DEFAULT_PLAYER_CONFIG,
        audio: { ...DEFAULT_PLAYER_CONFIG.audio, backgroundPlayback: false },
      }}
    >
      <PlayerRoot />
    </PlayerProvider>
  );
}

// ── Example 7: PiP config ─────────────────────────────────────────────────
export function PipConfigExample(): React.ReactElement {
  return (
    <PlayerProvider
      config={{
        pip: {
          enabled: true,
          autoEnterOnLeave: true,
        },
      }}
    >
      <PlayerRoot />
    </PlayerProvider>
  );
}

// ── Example 8: Manual PiP control ─────────────────────────────────────────
export function ManualPipExample(): void {
  const { MpvPlayerModule } = NativeModules;
  MpvPlayerModule.enterPip();
  MpvPlayerModule.exitPip();
  MpvPlayerModule.exitPipAndFinish();
}

// ── Example 9: Disable background audio ───────────────────────────────────
export function DisableBackgroundAudioExample(): React.ReactElement {
  return (
    <PlayerProvider config={{ audio: { backgroundPlayback: false } }}>
      <PlayerRoot />
    </PlayerProvider>
  );
}

// ── Example 10: Theme config ──────────────────────────────────────────────
export function ThemeExample(): React.ReactElement {
  return (
    <PlayerProvider
      config={{
        theme: {
          accent: '#FFD700',
          background: '#121216',
          text: '#FFFFFF',
          textSecondary: 'rgba(255,255,255,0.6)',
          surface: 'rgba(255,255,255,0.1)',
          icon: '#FFFFFF',
        },
      }}
    >
      <PlayerRoot />
    </PlayerProvider>
  );
}

// ── Example 11: useTheme in a custom component ────────────────────────────
export function UseThemeExample(): React.ReactElement {
  const theme = useTheme();
  return <View style={{ backgroundColor: theme.background }} />;
}

// ── Example 12: resolvePlayerConfig (introspection) ───────────────────────
export function IntrospectConfigExample(): void {
  const resolved = resolvePlayerConfig({
    pip: { enabled: false },
  });
  // resolved is fully-typed
  const _isPipEnabled: boolean = resolved.pip.enabled;
  void _isPipEnabled;
}

// ── Example 13: getMpvPlayerModule (typed bridge) ─────────────────────────
export function BridgeExample(): void {
  const bridge = getMpvPlayerModule();
  bridge.play();
  bridge.pause();
  bridge.seekAbsolute(42);
  bridge.seekBackward(10);
  bridge.seekForward(10);
  // requestNotificationPermission is not in the typed bridge surface (it's
  // optional at runtime) — verify the API is actually wired before calling.
  const native = (NativeModules as { MpvPlayerModule?: unknown }).MpvPlayerModule;
  if (
    native != null &&
    typeof (native as { requestNotificationPermission?: unknown }).requestNotificationPermission === 'function'
  ) {
    (native as { requestNotificationPermission: () => void }).requestNotificationPermission();
  }
}

// ── Example 14: usePlayerProgress (scrubber) ──────────────────────────────
export function ProgressExample(): React.ReactElement {
  const { positionMs, durationMs } = usePlayerProgress();
  const ratio = durationMs > 0 ? positionMs / durationMs : 0;
  return (
    <View>
      <Text>{`${positionMs} / ${durationMs}`}</Text>
      <Text>{`${Math.round(ratio * 100)}%`}</Text>
    </View>
  );
}

// ── Example 15: Verbose logging config ────────────────────────────────────
export function VerboseLoggingExample(): React.ReactElement {
  return (
    <PlayerProvider config={{ debug: { verboseLogging: true } }}>
      <PlayerRoot />
    </PlayerProvider>
  );
}

// ── Type-level sanity: verify all type exports resolve ───────────────────
export const _typeChecks = {
  state: {} as PlayerState,
  commands: {} as PlayerCommands,
  progress: {} as PlayerProgress,
  config: {} as PlayerConfig,
};

// ── DefaultControlsProps check (Phase 30 export) ──────────────────────────
export function DefaultControlsWithPropsExample(): React.ReactElement {
  return (
    <DefaultControls
      title="My Title"
      subtitle="My Subtitle"
      onPlay={() => {}}
      onPause={() => {}}
    />
  );
}
