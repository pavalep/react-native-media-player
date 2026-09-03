# SIMBA Player — Example App (Phase 40)

A standalone React Native app demonstrating **every documented feature** of
[`@simba-dev/react-native-media-player`](../README.md). Use it as:

- A **reference implementation** for how to wire the module into your app
- A **visual test harness** for verifying changes to the module
- A **demo** to show stakeholders what the player looks like

---

## What it demonstrates

8 demo screens, each exercising one spec deliverable:

| # | Screen | Spec | What it proves |
|---|---|---|---|
| 1 | **Local file playback** | §40.2 | Opens a local MP4 from `/sdcard/Movies/`. Press home for PiP. |
| 2 | **Streaming URL playback** | §40.3 | Opens an HLS test stream from Mux (HTTPS + adaptive bitrate). |
| 3 | **Audio playback with MediaSession** | §40.4 | Opens an MP3 with notification + lock-screen controls. |
| 4 | **Picture-in-Picture** | §40.5 | Opens a video. Press home → enters PiP. Tap to expand. |
| 5 | **Custom controls** | §40.6 | Replaces `DefaultControls` with a minimal custom overlay (title + play/pause). |
| 6 | **Custom theme** | §40.7 | Applies a custom theme (pink background, larger buttons). |
| 7 | **Background audio playback** | §40.8 | `audio.backgroundPlayback=true` — audio continues after pressing home. |
| 8 | **Error handling** (bonus) | §38 | Triggers `E_NETWORK_FAILURE` + `E_FILE_NOT_FOUND` and displays the `onError` events. |

Each screen has a **spec badge** in the top-right showing which section of the
V12 spec it proves out.

---

## Running it

### Prerequisites

- React Native dev environment (Node 18+, JDK 17, Android Studio with SDK 35+)
- A device or emulator running Android 6.0+ (API 24+)
- The `@simba-dev/react-native-media-player` module checked out locally (this
  example uses `file:..` in `package.json` to resolve it directly)

### Install

```bash
cd example
npm install
# or: pnpm install / yarn install
```

### Run on Android

```bash
npm run android
# or: npx react-native run-android
```

The app builds in ~30 seconds on a warm Metro cache. First install may take
2–3 minutes for the Gradle build.

### Run on iOS

iOS is not supported by this module (libmpv is Android-only). The `ios`
script is included for completeness but `npm run ios` will fail at the
`pod install` step.

---

## Project layout

```
example/
├── App.tsx                       # Entry point — 8-demo home screen
├── src/
│   └── screens/
│       └── index.tsx             # All 8 demo screens (consolidated)
├── package.json                  # Module dep via "file:.."
├── tsconfig.json                 # Strict TS config
└── README.md                     # This file
```

The example app intentionally has **no extra dependencies** beyond React +
React Native — no react-navigation, no state management library, no UI kit.
The home screen uses a tiny in-app state machine for navigation between
demos, and the screens use only the documented SIMBA Player public API.

---

## What to test on each screen

| Screen | Manual test |
|---|---|
| Local file | Copy a local MP4 to `/sdcard/Movies/simba-qa/mp4-medium.mp4`, tap "Open", verify playback starts within 2s. Press home → PiP shows live video (V11 bug regression check). |
| Streaming | Tap "Open HLS stream", verify first frame appears within 5s and playback continues for 60s without buffering. |
| Audio | Tap "Open audio file", press home, check notification shade for media controls. Lock screen → check lock-screen controls. |
| PiP | Tap "Open video for PiP", wait for playback, press home. Verify PiP window appears with live video. Tap PiP → expands to full screen. |
| Custom controls | Tap "Open with custom controls", verify the minimal overlay (title + play/pause button only) replaces the default scrubber + transport. |
| Custom theme | Tap "Open with pink theme", verify the player UI uses the pink theme (background, scrubber, buttons). |
| Background audio | Tap "Open with background audio", press home. Verify audio continues in the background (notification visible). Re-open the app via the notification. |
| Error handling | Tap "Trigger network error" — wait 10s, verify the log shows `E_NETWORK_FAILURE`. Tap "Trigger file not found" — verify `E_FILE_NOT_FOUND` appears. |

---

## Notes

- **Verbose logging is on by default** (Phase 39's `setDebugLogging(true)` in
  `App.tsx`). Use `adb logcat -s MpvBridgeModule` to see the trace.
- **Test media must be provided manually** — the example uses placeholder
  paths (`/sdcard/Movies/simba-qa/mp4-medium.mp4`). Copy your own media to
  those paths or edit the constants in `src/screens/index.tsx`.
- **The example uses `PlayerProvider` from the module** for the custom-controls
  + custom-theme + background-audio demos. The other demos use the module's
  standalone `MpvPlayerModule.openPlayer()` API which doesn't require a
  Provider (the Provider is only needed for in-app embedded players).
- **No PiP permission prompt** is needed at runtime — PiP is gated by
  `packageManager.hasSystemFeature(FEATURE_PICTURE_IN_PICTURE)` and the
  system Settings → Apps → Special access → Picture-in-picture toggle.

---

## See also

- [Module README](../README.md) — full API reference
- [SIMBA_PLAYER_MODULE_V12_SPECIFICATION.md](../../../MOBILE_APP_REACT_NATIVE/md/SIMBA_PLAYER_MODULE_V12_SPECIFICATION.md) — spec §40
- [SIMBA_PLAYER_MODULE_V12_ERROR_CONTRACT.md](../../../MOBILE_APP_REACT_NATIVE/md/SIMBA_PLAYER_MODULE_V12_ERROR_CONTRACT.md) — error event contract used by screen 8
