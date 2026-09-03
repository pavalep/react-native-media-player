/**
 * SIMBA Player — Example app entry point (Phase 40).
 *
 * Hosts 8 demo screens that exercise every documented feature of
 * `@simba-dev/react-native-media-player`. Navigation is a tiny in-app
 * state machine (no react-navigation dependency) so the example
 * app boots from `npx react-native run-android` without extra
 * packages.
 *
 * Run:
 *   cd example
 *   npm install
 *   npm run android   # or `npx react-native run-android`
 *
 * See `example/README.md` for what each screen demonstrates.
 */

import React, { useState, useCallback } from 'react';
import {
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import { setDebugLogging } from '../src/bridge/MpvPlayerModule';

import { LocalFileDemo } from './src/screens/LocalFileDemo';
import { StreamingDemo } from './src/screens/StreamingDemo';
import { AudioDemo } from './src/screens/AudioDemo';
import { PipDemo } from './src/screens/PipDemo';
import { CustomControlsDemo } from './src/screens/CustomControlsDemo';
import { CustomThemeDemo } from './src/screens/CustomThemeDemo';
import { BackgroundAudioDemo } from './src/screens/BackgroundAudioDemo';
import { ErrorHandlingDemo } from './src/screens/ErrorHandlingDemo';

type Screen =
  | 'home'
  | 'local'
  | 'streaming'
  | 'audio'
  | 'pip'
  | 'customControls'
  | 'customTheme'
  | 'background'
  | 'errors';

interface DemoEntry {
  id: Screen;
  title: string;
  subtitle: string;
  // Reference to the spec deliverable this demo proves
  specRef: string;
}

const DEMOS: ReadonlyArray<DemoEntry> = [
  {
    id: 'local',
    title: 'Local file playback',
    subtitle: 'Open a local MP4 from /sdcard/Movies/. Press home for PiP.',
    specRef: '§40.2',
  },
  {
    id: 'streaming',
    title: 'Streaming URL playback',
    subtitle: 'HLS test stream from Mux.',
    specRef: '§40.3',
  },
  {
    id: 'audio',
    title: 'Audio playback with MediaSession',
    subtitle: 'MP3 + notification/lock-screen controls.',
    specRef: '§40.4',
  },
  {
    id: 'pip',
    title: 'Picture-in-Picture',
    subtitle: 'Press home to enter PiP. Tap to expand.',
    specRef: '§40.5',
  },
  {
    id: 'customControls',
    title: 'Custom controls (replace DefaultControls)',
    subtitle: 'MinimalControls: title + play/pause only.',
    specRef: '§40.6',
  },
  {
    id: 'customTheme',
    title: 'Custom theme',
    subtitle: 'Pink theme + larger transport buttons.',
    specRef: '§40.7',
  },
  {
    id: 'background',
    title: 'Background audio playback',
    subtitle: 'audio.backgroundPlayback=true; press home, audio continues.',
    specRef: '§40.8',
  },
  {
    id: 'errors',
    title: 'Error handling',
    subtitle: 'Trigger E_NETWORK_FAILURE / E_DECODE_FAILED via the bridge.',
    specRef: '§38 (bonus)',
  },
] as const;

export default function App(): React.JSX.Element {
  const [screen, setScreen] = useState<Screen>('home');

  // Phase 39: enable verbose logging for the example app.
  // The flag is module-scoped + gated by __DEV__ so this is
  // a no-op in release builds. Consumers should NOT call this
  // in production code — it's a developer affordance.
  React.useEffect(() => {
    setDebugLogging(true);
    return () => setDebugLogging(false);
  }, []);

  const goHome = useCallback(() => setScreen('home'), []);

  if (screen !== 'home') {
    return (
      <SafeAreaView style={styles.container}>
        <TouchableOpacity style={styles.backButton} onPress={goHome}>
          <Text style={styles.backButtonText}>← Back to demos</Text>
        </TouchableOpacity>
        {renderScreen(screen)}
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>SIMBA Player V12</Text>
        <Text style={styles.subtitle}>Example app — Phase 40</Text>
      </View>
      <ScrollView style={styles.scroll}>
        {DEMOS.map((demo) => (
          <TouchableOpacity
            key={demo.id}
            style={styles.demoCard}
            onPress={() => setScreen(demo.id)}
          >
            <View style={styles.demoCardHeader}>
              <Text style={styles.demoTitle}>{demo.title}</Text>
              <Text style={styles.specBadge}>{demo.specRef}</Text>
            </View>
            <Text style={styles.demoSubtitle}>{demo.subtitle}</Text>
          </TouchableOpacity>
        ))}
        <Text style={styles.footer}>
          Phase 40 — 8 demos covering §40.2 – §40.8 (plus §38 bonus)
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

function renderScreen(screen: Screen): React.JSX.Element {
  switch (screen) {
    case 'local':
      return <LocalFileDemo />;
    case 'streaming':
      return <StreamingDemo />;
    case 'audio':
      return <AudioDemo />;
    case 'pip':
      return <PipDemo />;
    case 'customControls':
      return <CustomControlsDemo />;
    case 'customTheme':
      return <CustomThemeDemo />;
    case 'background':
      return <BackgroundAudioDemo />;
    case 'errors':
      return <ErrorHandlingDemo />;
    case 'home':
      // Unreachable — renderScreen only called when screen !== 'home'
      return <Text>Unknown screen</Text>;
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0a0a0a',
  },
  header: {
    padding: 24,
    paddingBottom: 16,
  },
  title: {
    fontSize: 28,
    fontWeight: 'bold',
    color: '#fff',
  },
  subtitle: {
    fontSize: 14,
    color: '#888',
    marginTop: 4,
  },
  scroll: {
    flex: 1,
  },
  demoCard: {
    backgroundColor: '#1a1a1a',
    marginHorizontal: 16,
    marginVertical: 6,
    padding: 16,
    borderRadius: 8,
    borderLeftWidth: 3,
    borderLeftColor: '#3b82f6',
  },
  demoCardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  demoTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#fff',
    flex: 1,
  },
  specBadge: {
    fontSize: 11,
    color: '#3b82f6',
    backgroundColor: '#1e3a8a',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 3,
    fontWeight: '600',
  },
  demoSubtitle: {
    fontSize: 13,
    color: '#aaa',
  },
  footer: {
    fontSize: 11,
    color: '#555',
    textAlign: 'center',
    padding: 24,
  },
  backButton: {
    padding: 12,
    backgroundColor: '#1a1a1a',
  },
  backButtonText: {
    color: '#3b82f6',
    fontSize: 14,
    fontWeight: '600',
  },
});
