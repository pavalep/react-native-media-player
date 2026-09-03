# @simba-dev/react-native-media-player

React Native video & audio player powered by [libmpv](https://mpv.io/), with first-class **Picture-in-Picture**, **MediaSession**, **foreground service**, and a customizable TypeScript UI. Built for Android. Designed to be a drop-in replacement for `react-native-video` / `react-native-track-player` / `expo-av`.

![Simba Player hero image — Android video player UI mockup](https://raw.githubusercontent.com/pavalep/react-native-media-player/main/assets/hero.svg)

<p align="left">
  <a href="https://www.npmjs.com/package/@simba-dev/react-native-media-player"><img alt="npm version" src="https://img.shields.io/npm/v/@simba-dev/react-native-media-player?color=cb3837&label=npm&logo=npm" /></a>
  <a href="https://github.com/pavalep/react-native-media-player/releases"><img alt="GitHub release" src="https://img.shields.io/github/v/release/pavalep/react-native-media-player?include_prereleases&sort=semver" /></a>
  <a href="./LICENSE"><img alt="License: MIT" src="https://img.shields.io/github/license/pavalep/react-native-media-player?color=blue" /></a>
  <a href="https://www.npmjs.com/package/@simba-dev/react-native-media-player"><img alt="npm downloads" src="https://img.shields.io/npm/dm/@simba-dev/react-native-media-player" /></a>
  <a href="https://github.com/pavalep/react-native-media-player/tags"><img alt="GitHub tags" src="https://img.shields.io/github/tag-date/pavalep/react-native-media-player?label=latest%20tag&sort=semver" /></a>
  <a href="https://github.com/pavalep/react-native-media-player/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/pavalep/react-native-media-player/ci.yml?branch=main&label=CI&logo=githubactions&logoColor=white" /></a>
  <a href="https://github.com/pavalep/react-native-media-player/actions/workflows/release.yml"><img alt="Release" src="https://img.shields.io/github/actions/workflow/status/pavalep/react-native-media-player/release.yml?label=Release&logo=githubactions&logoColor=white" /></a>
</p>

<p align="left">
  <a href="https://github.com/pavalep/react-native-media-player/releases">📦 Releases</a>
  &nbsp;·&nbsp;
  <a href="./CHANGELOG.md">📝 CHANGELOG</a>
  &nbsp;·&nbsp;
  <a href="https://www.npmjs.com/package/@simba-dev/react-native-media-player">📦 npm package</a>
  &nbsp;·&nbsp;
  <a href="https://github.com/pavalep/react-native-media-player/tags">🏷️ Tags</a>
</p>

## Table of contents

1. [What is `@simba-dev/react-native-media-player`?](#what-is-simbareact-native-media-player)
2. [Installation](#installation)
3. [Basic usage](#basic-usage)
4. [Custom UI](#custom-ui)
5. [Configuration](#configuration)
6. [Picture-in-Picture](#picture-in-picture)
7. [Background audio](#background-audio)
8. [Theming](#theming)
9. [API reference](#api-reference)
10. [Troubleshooting](#troubleshooting)
11. [Limitations](#limitations)
12. [Contributing](#contributing)
13. [License](#license)

---

## What is `@simba-dev/react-native-media-player`?

A standalone NPM package that gives your React Native Android app a unified **video + audio** playback engine backed by **libmpv**. The same engine, the same MediaSession, the same foreground service — for both video and audio playback.

**Highlights:**

- **Dedicated `PlayerActivity`** — extends `ReactActivity`, mounts the mpv-powered `SurfaceView` at the content root (the proven pattern for stable PiP on Android). No more black-screen PiP bugs.
- **Unified audio + video** — one engine, one set of controls. Audio files use the same `libmpv` instance with the surface hidden; no second player to maintain.
- **Picture-in-Picture** — auto-enter on background (configurable), manual toggle, custom RemoteActions. Works correctly with the React Native view tree (no nested-SurfaceView surprises).
- **MediaSession + lock-screen controls** — title / artist / album on the lock screen; play / pause / skip / seek from Bluetooth headphones, wired headsets, Android Auto, etc.
- **Foreground service** — keeps audio alive when the activity backgrounds (Spotify-style behavior, opt-in).
- **Customizable UI** — use `<DefaultControls>` out of the box, swap in your own via the `renderControls` prop, or build fully from scratch with `usePlayer` + `useTheme`.
- **TypeScript-first** — every prop, hook, and config field is fully typed.

## Installation

```bash
npm install @simba-dev/react-native-media-player
```

Autolinking handles the rest — RN's `react-native config` will find the package via the shipped [`react-native.config.js`](./react-native.config.js) and register `com.simba.player.PlayerPackage` in your `MainApplication.kt` automatically on next build.

### Requirements

- React Native **≥ 0.76** (bridgeless mode required)
- Android `minSdk` **24** (Android 7.0 Nougat — needed for Picture-in-Picture)
- Kotlin **1.9+** in the consumer app

### Consumer setup

Add the player to your `AndroidManifest.xml` (the package ships its own `<service>` and `<receiver>` declarations, but the **launchable activity** has to be registered in your app's manifest so the consumer can launch it):

```xml
<!-- MOBILE_APP_REACT_NATIVE/android/app/src/main/AndroidManifest.xml -->
<activity
    android:name="com.simba.player.PlayerActivity"
    android:configChanges="orientation|screenSize|screenLayout|keyboardHidden|navigation"
    android:launchMode="singleTask"
    android:supportsPictureInPicture="true"
    android:resizeableActivity="true"
    android:autoRemoveFromRecents="true"
    android:theme="@style/AppTheme"
    android:exported="false" />
```

If you plan to use **background audio**, declare the foreground-service permissions:

```xml
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK" />
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
```

For **API 33+** (Android 13+) the app must request `POST_NOTIFICATIONS` at runtime before the first media-style notification is shown. The bridge's `requestNotificationPermission()` helper does this:

```ts
import { getMpvPlayerModule } from '@simba-dev/react-native-media-player';
getMpvPlayerModule().requestNotificationPermission?.(); // graceful no-op on older APIs
```

## Basic usage

```tsx
// App.tsx
import React from 'react';
import { PlayerProvider, PlayerRoot } from '@simba-dev/react-native-media-player';

export default function App() {
  return (
    <PlayerProvider>
      <PlayerRoot />
    </PlayerProvider>
  );
}
```

That's it — `<PlayerRoot>` renders `<PlayerSurface>` (the JS placeholder for the native SurfaceView) + `<DefaultControls>` (top bar + scrubber + transport buttons + auto-hide). Press play from the native side and the player comes alive.

### Launching a file from JS

```tsx
import { NativeModules } from 'react-native';

const { MpvPlayerModule } = NativeModules;

await MpvPlayerModule.openPlayer(
  'https://archive.org/download/BigBuckBunny_124/Content/big_buck_bunny_720p_surround.mp4',
  'Big Buck Bunny',
  'video', // or 'audio'
  0,       // start position in ms
);
// PlayerActivity launches, plays the file, supports PiP, etc.
```

## Custom UI

Two ways to swap the controls:

### 1. `renderControls` prop (recommended)

```tsx
import React from 'react';
import { Pressable, Text, View } from 'react-native';
import {
  PlayerProvider,
  PlayerRoot,
  usePlayer,
  useTheme,
} from '@simba-dev/react-native-media-player';

function MyCustomControls() {
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

export default function App() {
  return (
    <PlayerProvider renderControls={() => <MyCustomControls />}>
      <PlayerRoot />
    </PlayerProvider>
  );
}
```

The `renderControls` function takes no arguments — your component reads what it needs (`usePlayer`, `useTheme`, `usePlayerProgress`) from the provider context. When omitted, `<PlayerRoot>` falls back to `<DefaultControls>`.

### 2. Build fully from scratch

Skip `<PlayerRoot>` entirely and lay out your own tree:

```tsx
import React from 'react';
import { View } from 'react-native';
import { PlayerProvider, PlayerSurface } from '@simba-dev/react-native-media-player';
import { MyControls } from './MyControls';

export default function App() {
  return (
    <PlayerProvider>
      <View style={{ flex: 1 }}>
        <PlayerSurface />
        {/* your own controls, positioned absolutely over the surface */}
        <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}>
          <MyControls />
        </View>
      </View>
    </PlayerProvider>
  );
}
```

## Configuration

Pass a `config` prop to `<PlayerProvider>`:

```tsx
<PlayerProvider
  config={{
    theme: { accent: '#00FF88' },
    pip: { enabled: true, autoEnterOnLeave: true },
    audio: { backgroundPlayback: true, respectAudioFocus: true },
    hardwareDecoding: 'auto', // 'auto' | 'mediacodec' | 'no'
    notifications: { enabled: true, channelId: 'my_app_media' },
    subtitle: { preferredLanguages: ['en'], fontSize: 18 },
    debug: { verboseLogging: false },
  }}
>
  {children}
</PlayerProvider>
```

Every field is optional and falls back to the defaults in [`DEFAULT_PLAYER_CONFIG`](./src/types/config.ts). See the [API reference](#api-reference) for the full type definitions.

### Spread-and-override pattern

For minor overrides, spread the defaults:

```tsx
import { DEFAULT_PLAYER_CONFIG } from '@simba-dev/react-native-media-player';

<PlayerProvider
  config={{
    ...DEFAULT_PLAYER_CONFIG,
    audio: { ...DEFAULT_PLAYER_CONFIG.audio, backgroundPlayback: false },
  }}
>
```

## Picture-in-Picture

Picture-in-Picture is on by default. Two configuration knobs:

```tsx
<PlayerProvider
  config={{
    pip: {
      enabled: true,         // master switch — when false, all PiP entry requests are ignored
      autoEnterOnLeave: true, // auto-enter on home/recents/app-switcher
    },
  }}
>
```

### Manual PiP control

```tsx
import { NativeModules } from 'react-native';
const { MpvPlayerModule } = NativeModules;

MpvPlayerModule.enterPip();             // enter PiP right now
MpvPlayerModule.exitPip();              // expand back to fullscreen
MpvPlayerModule.exitPipAndFinish();     // close the player session
```

### PiP RemoteActions

The module's lock-screen / PiP notification exposes Play / Pause / Skip-Back / Skip-Forward actions out of the box. Custom actions are not yet exposed via the public TS API — see the [Limitations](#limitations) section.

## Background audio

Audio files keep playing when the user backgrounds the app (Spotify-style). Video files always pause on background — this is intentional, see the [audio unification rationale](#limitations).

To disable background audio:

```tsx
<PlayerProvider
  config={{ audio: { backgroundPlayback: false } }}
>
```

When `backgroundPlayback` is enabled, the module starts a foreground service (`com.simba.player.MediaPlaybackService`) that hosts the MediaSession + media-style notification. The notification's transport controls work on the lock screen, in Android Auto, on Bluetooth headphones (play / pause / skip), and via Google Assistant.

## Theming

Every color in `<DefaultControls>` comes from the `PlayerTheme` slice of the config:

```tsx
<PlayerProvider
  config={{
    theme: {
      accent: '#FFD700',                       // play button, progress fill
      background: '#121216',                   // surface background
      text: '#FFFFFF',                         // primary text
      textSecondary: 'rgba(255,255,255,0.6)',  // subtitles, time labels
      surface: 'rgba(255,255,255,0.1)',        // floating cards, icon backgrounds
      icon: '#FFFFFF',                         // optional — defaults to `text`
    },
  }}
>
```

Read the theme from a custom component:

```tsx
import { useTheme } from '@simba-dev/react-native-media-player';

const theme = useTheme();
<View style={{ backgroundColor: theme.background }} />;
```

Default theme is dark with a golden accent (`DEFAULT_THEME`).

## API reference

Every public export lives in [`src/index.ts`](./src/index.ts).

### Components

| Component | Purpose |
|---|---|
| `<PlayerProvider>` | Wraps the app; provides resolved config + `renderControls` slot to descendants. |
| `<PlayerRoot>` | Renders `<PlayerSurface>` + the controls overlay (custom via `renderControls` or `<DefaultControls>`). |
| `<PlayerSurface>` | `<View flex:1>` placeholder for the native SurfaceView. a11y-hidden. |
| `<DefaultControls>` | Pre-built controls (top bar, scrubber, transport, auto-hide). |

### Hooks

| Hook | Returns | Throws outside provider? |
|---|---|---|
| `usePlayerConfig()` | `ResolvedPlayerConfig` | ✅ Yes (programmer error) |
| `useTheme()` | `PlayerTheme` | ✅ Yes (programmer error) |
| `useRenderControls()` | `RenderControlsFn \| null` | ❌ No (falls back to default controls) |
| `usePlayer()` | `{ state: PlayerState, commands: PlayerCommands }` | ❌ No (returns defaults) |
| `usePlayerProgress()` | `{ positionMs: number, durationMs: number }` | ❌ No (returns 0/0) |

### Types

| Type | Fields |
|---|---|
| `PlayerConfig` | `theme?`, `pip?`, `audio?`, `subtitle?`, `notifications?`, `hardwareDecoding?`, `debug?` |
| `ResolvedPlayerConfig` | Same as `PlayerConfig` but every field is required + defaulted |
| `PlayerTheme` | `accent`, `background`, `text`, `textSecondary`, `surface`, `icon?` |
| `PipConfig` | `enabled`, `autoEnterOnLeave` |
| `AudioConfig` | `backgroundPlayback`, `respectAudioFocus` |
| `SubtitleConfig` | `preferredLanguages`, `fontSize` |
| `NotificationConfig` | `enabled`, `channelId` |
| `DebugConfig` | `verboseLogging` |
| `HardwareDecodingPolicy` | `'auto' \| 'mediacodec' \| 'no'` |
| `PlayerState` | `isPlaying`, `title`, `artist`, `album` |
| `PlayerProgress` | `positionMs`, `durationMs` |
| `PlayerCommands` | `play()`, `pause()`, `seek(ms)`, `skipBackward(s)`, `skipForward(s)` |
| `UsePlayerResult` | `{ state, commands }` |
| `RenderControlsFn` | `() => React.ReactNode` |
| `MpvPlayerModuleBridge` | Typed view of the native module |

### Constants

| Constant | Description |
|---|---|
| `DEFAULT_THEME` | Dark theme with golden accent |
| `DEFAULT_PLAYER_CONFIG` | Fully-resolved default config (useful for spread-and-override) |

### Functions

| Function | Description |
|---|---|
| `resolvePlayerConfig(config)` | Merge a partial config with defaults — useful for tests / debug overlays |
| `getMpvPlayerModule()` | Typed wrapper over `NativeModules.MpvPlayerModule`. Returns a no-op stub on non-RN platforms (jest, web). |

## Troubleshooting

### "MpvPlayerModule is undefined" on JS side

You probably haven't rebuilt the native side after `npm install`. Run:

```bash
cd android && ./gradlew :app:assembleDebug
```

Or do a full Metro reset:

```bash
npm start --reset-cache
```

### Player launches but video is black

- **Permissions:** on API 33+ the app must request `POST_NOTIFICATIONS` before showing the media-style notification. Use `MpvPlayerModule.requestNotificationPermission()`.
- **Codec:** if the device can't decode the format (rare — libmpv handles most), try `hardwareDecoding: 'no'` to force software decoding.
- **HTTPS:** libmpv's curl backend rejects malformed URLs. Ensure your media URLs are valid `https://` (or `content://` for local files).

### PiP doesn't auto-enter on home press

Make sure:

1. The activity has `android:supportsPictureInPicture="true"` and `android:resizeableActivity="true"` in your `AndroidManifest.xml` (the consumer must declare these — the library doesn't force them).
2. `config.pip.autoEnterOnLeave === true` (the default).
3. The app targets API 24+ on a device that supports PiP (most modern Android devices do).

### Debug logging

Enable verbose logging from JavaScript:

```tsx
import { setDebugLogging } from '@simba-dev/react-native-media-player';

// Enable verbose logging (sets mpv msg-level=all + logs every bridge call)
setDebugLogging(true);

// ... your code ...

// Disable for production
setDebugLogging(false);
```

Or via the PlayerProvider config:

```tsx
<PlayerProvider config={{ debug: { verboseLogging: true } }}>
```

Then watch logcat:

```bash
adb logcat -v color MpvBridgeModule:V MPVLib:V PipManager:V MediaPlaybackService:V ReactNativeJS:V *:S
```

The `[PlaybackTrace]` prefix tags every bridge call so you can trace end-to-end.

#### Property dump

To dump all currently-observed mpv properties to logcat (useful for debugging state divergence between native and JS):

```tsx
import { dumpObservedProperties } from '@simba-dev/react-native-media-player';

const count = dumpObservedProperties();
console.log(`Dumped ${count} properties to logcat`);
```

Output looks like:

```
[PlaybackTrace][Bridge][dumpObservedProperties] 12 properties observed:
[PlaybackTrace][Bridge][dumpProperties] property=time-pos value="123.456" requested=true
[PlaybackTrace][Bridge][dumpProperties] property=duration value="600" requested=true
...
```

#### Memory-pressure response

When the system signals memory pressure via `ComponentCallbacks2.onTrimMemory()`, the bridge automatically reduces mpv's cache:

| Level | Cache-secs |
|---|---|
| `TRIM_MEMORY_RUNNING_MODERATE` | 10 |
| `TRIM_MEMORY_RUNNING_LOW` | 5 |
| `TRIM_MEMORY_RUNNING_CRITICAL` | 2 |
| `TRIM_MEMORY_BACKGROUND` | 10 |
| `TRIM_MEMORY_COMPLETE` | 0 |

No configuration needed — the bridge listens via `PlayerActivity` registration and adjusts `mpv.setPropertyString('cache-secs', ...)`.

#### Native module init log

On every React Native init, the bridge logs:

```
[PlaybackTrace][Bridge][initialize] MpvPlayerModule v0.1.0 init: package=com.simba.app isHeadlessJsTask=false debugLogging=false
```

This confirms the module is wired + reports the package name + current debug-logging state. Use `adb logcat -s MpvBridgeModule` to filter.

### TypeScript "Cannot find module '@simba-dev/react-native-media-player'"

Make sure the package is in your `dependencies` (not `devDependencies`) and Metro has been restarted. The `package.json` field `"react-native": "src/index.ts"` lets Metro resolve to the source directly without a build step.

## Limitations

- **Android-only.** iOS is not supported (no plans — the libmpv backend is the only reason this package exists; iOS has `AVPlayer`). The `react-native.config.js` returns `ios: null` to skip iOS autolinking entirely.
- **No DRM.** libmpv does not implement Widevine / FairPlay / PlayReady. Widevine is on the libmpv roadmap but not stable.
- **No casting.** Chromecast and AirPlay are out of scope. The MediaSession integrates with Android Auto and Bluetooth headphones, but not Cast.
- **GPL considerations.** libmpv is GPLv2+ by default. Bundling libmpv in your APK makes any consumer app that links against it subject to GPL terms unless you choose an LGPL-compatible build path. See the [License](#license) section below and the bundled [`MPV_NATIVE_PROVENANCE.md`](./android/src/main/jniLibs/MPV_NATIVE_PROVENANCE.md) for the exact provenance of the binary.
- **Audio vs video background behavior.** Video files always pause on background (no PiP, no audio continuation) — this is intentional. The V11 codebase had separate engines for audio vs video; V12 unifies them on libmpv but keeps the "video = foreground-only" rule because the SurfaceView's GPU compositing stops when the activity backgrounds.
- **PiP custom RemoteActions.** The lock-screen / PiP notification exposes a fixed set of actions (Play / Pause / Skip-Back / Skip-Forward). Custom actions are a W7+ feature.
- **React Native ≥ 0.76 only.** Bridgeless mode is required (the TurboModule path uses `TurboReactPackage`, which doesn't work on the legacy bridge).

## Contributing

### Local development

The module is a sibling of the consumer app at `SIMBA/react-native-media-player/`. To work on the module and test it in the consumer app:

```bash
# 1. Make changes in react-native-media-player/

# 2. Typecheck
cd react-native-media-player
npx tsc --noEmit -p .

# 3. Build the AAR
cd ../MOBILE_APP_REACT_NATIVE/android
./gradlew :react-native-media-player:assembleDebug

# 4. Build the consumer APK (catches consumer-side regressions)
./gradlew :app:assembleDebug

# 5. Run on device
cd ..
npm run android
```

### Tests

Wave 7 (Phases 33-34) adds JUnit + Jest tests. Until then, manual testing via the consumer app is the gate.

```bash
# Type check only
cd react-native-media-player
npx tsc --noEmit -p .

# Verify the package is publishable (without actually publishing)
npm pack --dry-run
```

### Pull request guidelines

- One phase per PR (matches the spec's phase structure).
- Update SPEC + TRACKER docs as part of the change.
- Verify `./gradlew :react-native-media-player:assembleDebug :app:assembleDebug` passes.
- Verify `npx tsc --noEmit -p .` passes from the module root.

## License

**MIT** for the Java/Kotlin/TypeScript code in this package. See [`LICENSE`](./LICENSE).

**Note on bundled native libraries** (see [`LICENSE`](./LICENSE) for full text):

- [libmpv](https://mpv.io/) — **GPLv2+** by default. Bundling it makes any consumer app that links against it subject to GPL terms unless an LGPL-compatible build path is chosen.
- Bundled FFmpeg libraries (`libavcodec`, `libavformat`, `libavutil`, `libavfilter`, `libavdevice`, `libswresample`, `libswscale`) — **LGPLv2.1+** unless configured otherwise at build time.
- `libOpenCL` — Apache-2.0.
- `libc++_shared` — Apache-2.0 with LLVM exceptions.

Consumers are responsible for ensuring their app's license obligations are met when shipping these binaries. See [`android/src/main/jniLibs/MPV_NATIVE_PROVENANCE.md`](./android/src/main/jniLibs/MPV_NATIVE_PROVENANCE.md) for the exact provenance of each bundled binary.

---

**Status:** V12 — latest published version is **1.0.2** on [npmjs](https://www.npmjs.com/package/@simba-dev/react-native-media-player) and [GitHub Releases](https://github.com/pavalep/react-native-media-player/releases). See [CHANGELOG.md](./CHANGELOG.md) for the full per-version notes.
