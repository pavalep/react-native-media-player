/**
 * Phase 40 example app — 8 demo screens that exercise every documented
 * feature of `@simba/react-native-media-player`. Each screen is a
 * standalone React component that demonstrates one spec deliverable.
 *
 * Screens:
 *  - LocalFileDemo        §40.2 Local file playback (MP4 from /sdcard/Movies/)
 *  - StreamingDemo        §40.3 Streaming URL (HLS from Mux test stream)
 *  - AudioDemo            §40.4 Audio playback + MediaSession
 *  - PipDemo              §40.5 Picture-in-Picture
 *  - CustomControlsDemo   §40.6 Replace DefaultControls with MinimalControls
 *  - CustomThemeDemo      §40.7 Custom theme (pink + larger buttons)
 *  - BackgroundAudioDemo  §40.8 Background audio (audio.backgroundPlayback=true)
 *  - ErrorHandlingDemo    §38 Error event contract (bonus)
 *
 * Each demo screen uses a small "Open Player" button that calls
 * `MpvPlayerModule.openPlayer(uri, title, type, startPositionMs)`
 * to launch the native PlayerActivity. The PlayerActivity
 * reads the params + shows the V12 default controls.
 *
 * For custom-controls / custom-theme demos, the screen sets the
 * `renderControls` prop on `<PlayerProvider>` so DefaultControls
 * is replaced with the custom component.
 */

import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  TextInput,
} from 'react-native';

import {
  MpvPlayerModule,
  PlayerProvider,
  DefaultControls,
  useRenderControls,
  type PlayerConfig,
  type PlayerTheme,
  type RenderControlsFn,
} from '../../../src/index';

// ─── Shared openPlayer wrapper ───────────────────────────────────────────────

async function openPlayer(
  uri: string,
  title: string,
  type: 'video' | 'audio',
  startPositionMs = 0,
): Promise<void> {
  try {
    await MpvPlayerModule.openPlayer(uri, title, type, startPositionMs);
  } catch (e) {
    console.warn('[Example] openPlayer failed:', e);
  }
}

// ─── §40.2 LocalFileDemo ─────────────────────────────────────────────────────

export function LocalFileDemo(): React.JSX.Element {
  const [path, setPath] = useState('/sdcard/Movies/simba-qa/mp4-medium.mp4');

  return (
    <DemoContainer title="§40.2 Local file playback" specRef="40.2">
      <Text style={styles.helpText}>
        Edit the path below to point at a local media file on the device, then
        tap "Open". The native PlayerActivity launches and shows the V12
        default controls. Press home to enter PiP.
      </Text>
      <TextInput
        style={styles.input}
        value={path}
        onChangeText={setPath}
        placeholder="/sdcard/Movies/your-file.mp4"
        placeholderTextColor="#666"
        autoCapitalize="none"
        autoCorrect={false}
      />
      <OpenButton
        label="Open local file"
        onPress={() => openPlayer(path, 'Local MP4 demo', 'video')}
      />
      <Note>
        Tip: place test files in /sdcard/Movies/ and grant the app storage
        permission. The example uses /sdcard/Movies/simba-qa/mp4-medium.mp4
        by default — copy any local MP4 there to test.
      </Note>
    </DemoContainer>
  );
}

// ─── §40.3 StreamingDemo ─────────────────────────────────────────────────────

export function StreamingDemo(): React.JSX.Element {
  const DEFAULT_URL = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8';

  return (
    <DemoContainer title="§40.3 Streaming URL playback" specRef="40.3">
      <Text style={styles.helpText}>
        Opens an HLS test stream from Mux. Demonstrates that the player
        handles HTTP/HLS URLs (no codec negotiation issues with libmpv's
        bundled ffmpeg).
      </Text>
      <OpenButton
        label="Open HLS stream"
        onPress={() => openPlayer(DEFAULT_URL, 'Mux HLS test stream', 'video')}
      />
      <Note>
        If the stream stalls, check the network connection. The stream is
        public — no auth required.
      </Note>
    </DemoContainer>
  );
}

// ─── §40.4 AudioDemo ─────────────────────────────────────────────────────────

export function AudioDemo(): React.JSX.Element {
  return (
    <DemoContainer title="§40.4 Audio playback with MediaSession" specRef="40.4">
      <Text style={styles.helpText}>
        Opens an audio file. Once playback starts, the system notification +
        lock-screen controls become available. Test by pressing home and
        checking the notification shade.
      </Text>
      <OpenButton
        label="Open audio file"
        onPress={() =>
          openPlayer(
            '/sdcard/Documents/simba-qa/mp3-test.mp3',
            'Audio demo',
            'audio',
          )
        }
      />
      <Note>
        Place an MP3 at /sdcard/Documents/simba-qa/mp3-test.mp3 (or edit
        the path). The default config enables MediaSession metadata +
        transport controls for audio playback.
      </Note>
    </DemoContainer>
  );
}

// ─── §40.5 PipDemo ───────────────────────────────────────────────────────────

export function PipDemo(): React.JSX.Element {
  return (
    <DemoContainer title="§40.5 Picture-in-Picture" specRef="40.5">
      <Text style={styles.helpText}>
        Opens a video. Once playback is visible, press the home button to
        enter PiP. The V12 module keeps playback running in the PiP window
        (fixing the V11 black-screen bug).
      </Text>
      <OpenButton
        label="Open video for PiP"
        onPress={() =>
          openPlayer(
            '/sdcard/Movies/simba-qa/mp4-medium.mp4',
            'PiP demo',
            'video',
          )
        }
      />
      <Note>
        PiP support varies by OEM — some devices disable PiP at the OS
        level. Check Settings → Apps → Special access → Picture-in-picture.
      </Note>
    </DemoContainer>
  );
}

// ─── §40.6 CustomControlsDemo ────────────────────────────────────────────────

/**
 * Minimal custom controls — proves that consumers can replace
 * DefaultControls with their own UI by passing a `renderControls`
 * function to `<PlayerProvider>`.
 */
const MinimalControls: React.FC = () => {
  const { state, commands } = require('../../../src/types/player').usePlayer();
  return (
    <View style={minimalStyles.root}>
      <Text style={minimalStyles.title}>{state.title || 'Now playing'}</Text>
      <TouchableOpacity
        style={minimalStyles.playButton}
        onPress={state.isPlaying ? commands.pause : commands.play}
      >
        <Text style={minimalStyles.playButtonText}>
          {state.isPlaying ? '❚❚ Pause' : '▶ Play'}
        </Text>
      </TouchableOpacity>
    </View>
  );
};

const minimalStyles = StyleSheet.create({
  root: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  title: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 16,
  },
  playButton: {
    backgroundColor: '#fff',
    paddingHorizontal: 32,
    paddingVertical: 16,
    borderRadius: 8,
  },
  playButtonText: {
    color: '#000',
    fontSize: 16,
    fontWeight: '600',
  },
});

export function CustomControlsDemo(): React.JSX.Element {
  const renderControls: RenderControlsFn = useCallback(
    () => <MinimalControls />,
    [],
  );

  return (
    <DemoContainer title="§40.6 Custom controls" specRef="40.6">
      <Text style={styles.helpText}>
        Replaces the V12 DefaultControls with a minimal custom overlay
        (title + single play/pause button). Consumers pass a
        `renderControls` function to PlayerProvider.
      </Text>
      <PlayerProvider renderControls={renderControls}>
        <OpenButton
          label="Open with custom controls"
          onPress={() =>
            openPlayer(
              '/sdcard/Movies/simba-qa/mp4-medium.mp4',
              'Custom controls demo',
              'video',
            )
          }
        />
      </PlayerProvider>
      <Note>
        The MinimalControls component uses `usePlayer()` to read
        `state.title` + `state.isPlaying` and `commands.play` /
        `commands.pause` to drive the bridge.
      </Note>
    </DemoContainer>
  );
}

// ─── §40.7 CustomThemeDemo ───────────────────────────────────────────────────

export function CustomThemeDemo(): React.JSX.Element {
  // Custom theme: pink background, larger buttons, different scrubber color
  const pinkTheme: Partial<PlayerTheme> = {
    backgroundColor: '#ec4899', // pink-500
    controlsBackgroundColor: '#831843', // pink-900
    primaryColor: '#fbcfe8', // pink-200
    secondaryColor: '#fdf2f8', // pink-50
    scrubberColor: '#f9a8d4', // pink-300
    scrubberFillColor: '#fff',
    transportButtonSize: 56, // larger than default 40
  };

  const pinkConfig: Partial<PlayerConfig> = {
    theme: pinkTheme,
  };

  return (
    <DemoContainer title="§40.7 Custom theme" specRef="40.7">
      <Text style={styles.helpText}>
        Demonstrates the theming system. The default pink theme is
        applied via `PlayerConfig.theme`. Consumers can override any of
        the 6 documented theme keys.
      </Text>
      <PlayerProvider config={pinkConfig}>
        <OpenButton
          label="Open with pink theme"
          onPress={() =>
            openPlayer(
              '/sdcard/Movies/simba-qa/mp4-medium.mp4',
              'Pink theme demo',
              'video',
            )
          }
        />
      </PlayerProvider>
      <Note>
        Custom theme keys: backgroundColor, controlsBackgroundColor,
        primaryColor, secondaryColor, scrubberColor, scrubberFillColor,
        transportButtonSize. See PlayerTheme in src/types/config.ts.
      </Note>
    </DemoContainer>
  );
}

// ─── §40.8 BackgroundAudioDemo ───────────────────────────────────────────────

export function BackgroundAudioDemo(): React.JSX.Element {
  // Enable background audio playback — when the activity is in
  // background (PiP or home pressed), mpv continues to play.
  const bgAudioConfig: Partial<PlayerConfig> = {
    audio: {
      backgroundPlayback: true,
      pauseOnHeadsetDisconnect: true,
    },
  };

  return (
    <DemoContainer title="§40.8 Background audio playback" specRef="40.8">
      <Text style={styles.helpText}>
        Enables `audio.backgroundPlayback=true`. With this setting,
        pressing home does NOT pause the audio — it continues in the
        background with notification + lock-screen controls.
      </Text>
      <PlayerProvider config={bgAudioConfig}>
        <OpenButton
          label="Open with background audio"
          onPress={() =>
            openPlayer(
              '/sdcard/Documents/simba-qa/mp3-test.mp3',
              'Background audio demo',
              'audio',
            )
          }
        />
      </PlayerProvider>
      <Note>
        After tapping play, press home. Audio should continue in the
        background with the notification visible. To return to the
        app, tap the notification.
      </Note>
    </DemoContainer>
  );
}

// ─── §38 ErrorHandlingDemo (bonus) ───────────────────────────────────────────

export function ErrorHandlingDemo(): React.JSX.Element {
  const [log, setLog] = useState<string[]>([]);

  // Subscribe to onError events. Real consumers would do this
  // in a useEffect with DeviceEventEmitter.addListener.
  React.useEffect(() => {
    const { DeviceEventEmitter } = require('react-native');
    const sub = DeviceEventEmitter.addListener(
      'onError',
      (payload: { code: string; message: string }) => {
        setLog((prev) => [
          `[${new Date().toISOString()}] ${payload.code}: ${payload.message}`,
          ...prev,
        ].slice(0, 10));
      },
    );
    return () => sub.remove();
  }, []);

  const triggerNetworkError = useCallback(() => {
    // Try to open a non-existent HLS URL → mpv fires onError
    openPlayer(
      'https://does-not-exist.invalid/stream.m3u8',
      'Network error demo',
      'video',
    );
  }, []);

  const triggerFileNotFound = useCallback(() => {
    openPlayer(
      '/sdcard/Movies/simba-qa/this-file-does-not-exist.mp4',
      'File not found demo',
      'video',
    );
  }, []);

  return (
    <DemoContainer title="§38 Error handling (bonus)" specRef="38">
      <Text style={styles.helpText}>
        Triggers common error scenarios. The native bridge emits an
        `onError` event with a structured code (E_NETWORK_FAILURE,
        E_FILE_NOT_FOUND, etc.). The example subscribes and displays
        recent events below.
      </Text>
      <OpenButton
        label="Trigger network error"
        onPress={triggerNetworkError}
      />
      <OpenButton
        label="Trigger file not found"
        onPress={triggerFileNotFound}
      />
      <View style={styles.logContainer}>
        <Text style={styles.logHeader}>Recent onError events:</Text>
        {log.length === 0 ? (
          <Text style={styles.logEmpty}>(none yet — trigger an error above)</Text>
        ) : (
          log.map((line, i) => (
            <Text key={i} style={styles.logLine}>
              {line}
            </Text>
          ))
        )}
      </View>
    </DemoContainer>
  );
}

// ─── Shared layout helpers ───────────────────────────────────────────────────

interface DemoContainerProps {
  title: string;
  specRef: string;
  children: React.ReactNode;
}

function DemoContainer({
  title,
  specRef,
  children,
}: DemoContainerProps): React.JSX.Element {
  return (
    <ScrollView style={styles.container}>
      <View style={styles.headerRow}>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.badge}>{specRef}</Text>
      </View>
      <View style={styles.body}>{children}</View>
    </ScrollView>
  );
}

interface OpenButtonProps {
  label: string;
  onPress: () => void;
}

function OpenButton({ label, onPress }: OpenButtonProps): React.JSX.Element {
  return (
    <TouchableOpacity style={styles.openButton} onPress={onPress}>
      <Text style={styles.openButtonText}>{label}</Text>
    </TouchableOpacity>
  );
}

function Note({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <Text style={styles.note}>{children}</Text>;
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0a0a0a',
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 20,
    paddingBottom: 12,
  },
  title: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#fff',
    flex: 1,
  },
  badge: {
    fontSize: 11,
    color: '#3b82f6',
    backgroundColor: '#1e3a8a',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 3,
    fontWeight: '600',
  },
  body: {
    padding: 20,
  },
  helpText: {
    color: '#aaa',
    fontSize: 13,
    lineHeight: 18,
    marginBottom: 16,
  },
  openButton: {
    backgroundColor: '#3b82f6',
    paddingVertical: 14,
    paddingHorizontal: 20,
    borderRadius: 8,
    alignItems: 'center',
    marginVertical: 6,
  },
  openButtonText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
  input: {
    backgroundColor: '#1a1a1a',
    color: '#fff',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 6,
    marginVertical: 8,
    fontFamily: 'monospace',
    fontSize: 13,
  },
  note: {
    color: '#777',
    fontSize: 12,
    fontStyle: 'italic',
    marginTop: 12,
    lineHeight: 17,
  },
  logContainer: {
    backgroundColor: '#1a1a1a',
    borderRadius: 6,
    padding: 12,
    marginTop: 16,
  },
  logHeader: {
    color: '#3b82f6',
    fontSize: 12,
    fontWeight: '600',
    marginBottom: 8,
  },
  logEmpty: {
    color: '#666',
    fontSize: 12,
    fontStyle: 'italic',
  },
  logLine: {
    color: '#fca5a5',
    fontSize: 11,
    fontFamily: 'monospace',
    marginVertical: 2,
  },
});
