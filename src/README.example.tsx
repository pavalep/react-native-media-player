/**
 * The typed mirror of README.md's public-API snippets.
 *
 * Every tsx snippet in the README's "Quick start", "Controls",
 * "Configuration", "Picture-in-Picture" and "Theming" sections is
 * reproduced here against the REAL public surface — the names
 * `src/index.ts` re-exports — so `tsc --noEmit` catches any drift
 * between the documentation and the API.
 *
 * Three things make that claim true, and each one is checkable:
 *
 *  - `tsconfig.json` does NOT exclude this file. It used to, and
 *    that is exactly how the file came to still import
 *    `<PlayerRoot>` and `<PlayerSurface>` — both REMOVED in 3.0.0 —
 *    with nothing failing. The exclusion is gone, so
 *    `npm run typecheck` really does check this file now.
 *  - Every import below comes from `./index`. The package's public
 *    surface is exactly what `src/index.ts` re-exports, so an
 *    import that is not re-exported there does not compile.
 *  - This is not a test file: `tsconfig.json` excludes only the
 *    `*.test.ts` and `*.test.tsx` patterns, so this file is picked
 *    up by the `include` glob over `src/` and type-checked with
 *    the rest of the package.
 *
 * It does not ship. `package.json`'s `files` allow-list carries
 * `!src/README.example.tsx`, and `npm pack --dry-run` shows the file
 * is absent from the tarball.
 */

import React from 'react';
import { Button, StyleSheet, Text, View } from 'react-native';
import {
  DEFAULT_PLAYER_CONFIG,
  PlayerProvider,
  SimbaPlayer,
  SimbaVideo,
  getMpvPlayerModule,
  resolvePlayerConfig,
  usePlayer,
  usePlayerActivity,
  usePlayerProgress,
  useRenderControls,
  useTheme,
  type PlayerCommands,
  type PlayerConfig,
  type PlayerProgress,
  type PlayerState,
} from './index';

// ── Example 1: Quick start — the one-import integration point ─────────────
//
// README "Quick start". `<SimbaPlayer>` mounts `<PlayerProvider>` (state +
// commands) and the resume lookup for you.
export function QuickStartExample(): React.ReactElement {
  return (
    <SimbaPlayer config={{audio: {backgroundPlayback: true}}}>
      <SimbaVideo />
    </SimbaPlayer>
  );
}

// ── Example 2: Play something ─────────────────────────────────────────────
//
// README "Play something". `usePlayerActivity().openPlayer(...)` is the
// launch primitive; it resolves `false` when the launch was not dispatched
// (for video: no `<SimbaVideo />` mounted).
export function PlaySomethingExample(): React.ReactElement {
  const {openPlayer} = usePlayerActivity();
  const onPress = async (): Promise<void> => {
    await openPlayer({
      uri: 'https://example.com/movie.mkv',
      title: 'Movie',
      type: 'video',
    });
  };
  return <Button title="Play" onPress={onPress} />;
}

// ── Example 3: Render the picture ─────────────────────────────────────────
//
// README "Render the picture". `<SimbaVideo />` is an ordinary view in the
// consumer's own tree, so the consumer places it and lays it out.
export function RenderPictureExample(): React.ReactElement {
  return <SimbaVideo style={{flex: 1}} resizeMode="contain" />;
}

// ── Example 4: Drive it ───────────────────────────────────────────────────
//
// README "Drive it". `usePlayer()` returns `{state, commands}`;
// `usePlayerProgress()` returns the progress object directly.
export function DriveItExample(): React.ReactElement {
  const {state, commands} = usePlayer();
  const {positionMs, durationMs} = usePlayerProgress();

  return (
    <View>
      <Text>
        {Math.floor(positionMs / 1000)} / {Math.floor(durationMs / 1000)}
      </Text>
      <Button
        title={state.isPlaying ? 'Pause' : 'Play'}
        onPress={commands.togglePlayPause}
      />
    </View>
  );
}

// ── Example 5: Optional adapter — resume positions ────────────────────────
//
// README "Optional adapter: resume positions". `resumePolicy` receives the
// `resumeId` and returns a saved position in ms, or `undefined`.
export function ResumePolicyExample(): React.ReactElement {
  const bookmarks: {byId: Record<string, {positionMs: number} | undefined>} = {
    byId: {},
  };
  return (
    <SimbaPlayer resumePolicy={(id) => bookmarks.byId[id]?.positionMs}>
      <SimbaVideo />
    </SimbaPlayer>
  );
}

// ── Example 6: Controls via the `renderControls` slot ─────────────────────
//
// README "Controls". The slot takes NO arguments and returns the tree to
// draw over the picture. The library draws no overlay — the consumer places
// the tree in its own absolutely positioned `View`.
function MyControls(): React.ReactElement {
  const {state, commands} = usePlayer();
  const theme = useTheme();
  return (
    <View style={{flex: 1, justifyContent: 'center', alignItems: 'center'}}>
      <Text style={{color: theme.text}}>{state.title}</Text>
      <Button
        title={state.isPlaying ? 'Pause' : 'Play'}
        onPress={commands.togglePlayPause}
      />
    </View>
  );
}

export function RenderControlsSlotExample(): React.ReactElement {
  return (
    <PlayerProvider renderControls={() => <MyControls />}>
      <View style={{flex: 1}}>
        <SimbaVideo />
        <View style={StyleSheet.absoluteFill}>
          <MyControls />
        </View>
      </View>
    </PlayerProvider>
  );
}

// ── Example 7: Controls via `useRenderControls()` ─────────────────────────
//
// README "Controls". `useRenderControls()` returns the slot, or `null` when
// there is none — the consumer's own component calls it.
function PlayerChrome(): React.ReactNode {
  const renderControls = useRenderControls();
  return renderControls != null ? renderControls() : null;
}

export function UseRenderControlsExample(): React.ReactElement {
  return (
    <PlayerProvider>
      <View style={{flex: 1}}>
        <SimbaVideo />
        <View style={StyleSheet.absoluteFill}>
          <PlayerChrome />
        </View>
      </View>
    </PlayerProvider>
  );
}

// ── Example 8: Full config prop ───────────────────────────────────────────
//
// README "Configuration". Every field is optional and is merged with the
// defaults by `resolvePlayerConfig`.
export function FullConfigExample(): React.ReactElement {
  return (
    <PlayerProvider
      config={{
        theme: {accent: '#00FF88'},
        pip: {enabled: true, autoEnterOnLeave: true},
        audio: {backgroundPlayback: true, respectAudioFocus: true},
        hardwareDecoding: 'auto',
      }}>
      <SimbaVideo />
    </PlayerProvider>
  );
}

// ── Example 9: Spread-and-override pattern ────────────────────────────────
export function SpreadOverrideExample(): React.ReactElement {
  return (
    <PlayerProvider
      config={{
        ...DEFAULT_PLAYER_CONFIG,
        audio: {...DEFAULT_PLAYER_CONFIG.audio, backgroundPlayback: false},
      }}>
      <SimbaVideo />
    </PlayerProvider>
  );
}

// ── Example 10: PiP config ────────────────────────────────────────────────
export function PipConfigExample(): React.ReactElement {
  return (
    <PlayerProvider
      config={{
        pip: {
          enabled: true,
          autoEnterOnLeave: true,
        },
      }}>
      <SimbaVideo />
    </PlayerProvider>
  );
}

// ── Example 11: Manual PiP control ────────────────────────────────────────
//
// README "Picture-in-Picture". `enterPip()` takes optional chapter title
// and progress string; the bridge always receives both.
export function ManualPipExample(): React.ReactElement {
  const {commands} = usePlayer();
  const onPress = (): void => {
    commands.enterPip();
    commands.exitPip();
    commands.exitPipAndFinish();
  };
  return <Button title="PiP" onPress={onPress} />;
}

// ── Example 12: Disable background audio ──────────────────────────────────
export function DisableBackgroundAudioExample(): React.ReactElement {
  return (
    <PlayerProvider config={{audio: {backgroundPlayback: false}}}>
      <SimbaVideo />
    </PlayerProvider>
  );
}

// ── Example 13: Theme config ──────────────────────────────────────────────
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
      }}>
      <SimbaVideo />
    </PlayerProvider>
  );
}

// ── Example 14: useTheme in a custom component ────────────────────────────
//
// README "Theming". `useTheme()` returns the resolved theme — `{accent,
// background, text, textSecondary, surface, icon?}`.
export function UseThemeExample(): React.ReactElement {
  const theme = useTheme();
  return <View style={{backgroundColor: theme.background}} />;
}

// ── Example 15: resolvePlayerConfig (introspection) ───────────────────────
export function IntrospectConfigExample(): void {
  const resolved = resolvePlayerConfig({
    pip: {enabled: false},
  });
  // resolved is fully-typed
  const _isPipEnabled: boolean = resolved.pip.enabled;
  void _isPipEnabled;
}

// ── Example 16: getMpvPlayerModule (typed bridge) ─────────────────────────
//
// README "Bridge". `getMpvPlayerModule()` returns the native module, or a
// no-op stand-in when the native side is not wired.
export function BridgeExample(): void {
  const bridge = getMpvPlayerModule();
  bridge.play();
  bridge.pause();
  bridge.seekAbsolute(42);
  bridge.seekBackward(10);
  bridge.seekForward(10);
}

// ── Example 17: usePlayerProgress (scrubber) ──────────────────────────────
export function ProgressExample(): React.ReactElement {
  const {positionMs, durationMs} = usePlayerProgress();
  const ratio = durationMs > 0 ? positionMs / durationMs : 0;
  return (
    <View>
      <Text>{`${positionMs} / ${durationMs}`}</Text>
      <Text>{`${Math.round(ratio * 100)}%`}</Text>
    </View>
  );
}

// ── Example 18: Verbose logging config ────────────────────────────────────
export function VerboseLoggingExample(): React.ReactElement {
  return (
    <PlayerProvider config={{debug: {verboseLogging: true}}}>
      <SimbaVideo />
    </PlayerProvider>
  );
}

// ── Example 19: requestNotificationPermission ─────────────────────────────
//
// README "Troubleshooting": on Android 13+ the app must hold
// `POST_NOTIFICATIONS` before the media notification is shown.
export function NotificationPermissionExample(): React.ReactElement {
  const {commands} = usePlayer();
  return (
    <Button
      title="Allow notifications"
      onPress={() => {
        commands.requestNotificationPermission();
      }}
    />
  );
}

// ── Type-level sanity: verify all type exports resolve ───────────────────
export const _typeChecks = {
  state: {} as PlayerState,
  commands: {} as PlayerCommands,
  progress: {} as PlayerProgress,
  config: {} as PlayerConfig,
};
