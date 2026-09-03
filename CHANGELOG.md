# Changelog

All notable changes to `@simba-dev/react-native-media-player` are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.1] - 2026-09-03

### Fixed

- **README + example references to `@simba/react-native-media-player` retargeted to
  `@simba-dev/react-native-media-player`.** The bare `simba` org-name was unavailable
  at V12.0.0 publication time (npmjs reserved-name policy), so we created the
  `@simba-dev` org instead. The first published version (1.0.0) referred to the new
  scope in `package.json` but referenced the old `simba` scope in the README's title,
  TOC anchors, install command, custom-UI examples, API-reference table, the
  `Config` examples, troubleshooting + limitations headers, contributing section,
  Maven coordinates (in `android/build.gradle`), and all four example-app files.
  This patch fixes those.

### Files changed in 1.0.1

- `README.md` — every section header, TOC anchor, install command, all import
  examples, API-reference table, all bash code blocks
- `example/App.tsx` + `example/src/screens/index.tsx` + `example/package.json` +
  `example/README.md` — all references retargeted
- `android/build.gradle` — Maven `group` + doc-header reference retargeted
- `package.json` — `name` already correct in 1.0.0 (this is the prior fix); `version`
  bumped to `1.0.1` for the patch
- `CHANGELOG.md` — this entry

### Migration from 1.0.0

No code changes required. If you installed `1.0.0`, the install command still works:
```
npm install @simba-dev/react-native-media-player@1.0.0
```
But the README + npmjs page now correctly reference `@simba-dev/` everywhere; you
may want to upgrade to `1.0.1` for the corrected docs:
```
npm install @simba-dev/react-native-media-player@latest
```

## [1.0.0] - 2026-09-03

### Added

#### Native layer (Kotlin + cpp)
- **libmpv + ffmpeg bridge.** New `MpvBridgeModule.kt` (Kotlin) plus
  `android/cpp/` (C++) expose the libmpv core as a TurboModule Spec with
  typed promise/async handlers. Plays MKV, MP4, MOV, AVI, FLV, WebM, MP3,
  AAC, FLAC, and OGG out of the box. Hardware-accelerated decode via
  MediaCodec hwdec where available.
- **`MpvPlayerModule.ts` (TS).** Typed RN bridge with `play`, `pause`,
  `seek`, `setVolume`, `setRate`, `setAudioTrack`, `setSubtitleTrack`,
  `setDebugLogging`, `dumpObservedProperties`, and `dlog` (Phase 39).
- **`PlayerActivity.kt`.** Dedicated Android Activity, replacing the
  V11 inline-mount approach. Owns audio focus (AUDIOFOCUS_GAIN /
  LOSS / LOSS_TRANSIENT / LOSS_TRANSIENT_CAN_DUCK) and implements
  Android 12+ PiP re-attach, ComponentCallbacks2 memory trimming, and
  handler-thread dispatch.
- **`MediaPlaybackService.kt`.** Foreground service with `MediaSessionCompat`
  + custom transport actions + scrubbing integration (Phase 38/40).

#### React layer (TS)
- **`PlayerProvider` + `PlayerContext`.** Top-level wrapper that owns the
  JS state machine and broadcasts to `PlayerRoot` + `DefaultControls`.
- **`PlayerRoot` + `DefaultControls`.** Compose-friendly surface that hosts
  the native surface, transport bar, scrubber, and audio/subtitle menus.
- **`PlayerSurface`.** RN-side handle on the native surface, dropped in
  using `<PlayerSurface ref={ref} style={...} />`.
- **`DrmConfig` / `NotificationConfig` / `PipConfig` / `AudioConfig`.**
  First-class config types with sane defaults.
- **`setDebugLogging` + `dumpObservedProperties`.** Runtime diagnostics
  bridge methods (Phase 39).

#### Testing
- **95 jest tests** across 7 suites: bridge, surface, ui, controls, config,
  callbacks, and example app.
- **All tests pass.** Run with `npx jest`.

#### Documentation
- Full V12 specification, deprecation audit, navigation update, PiP hook
  removal, debug log cleanup, final QA report, and release runbook live
  alongside the consumer app's repo at
  `MOBILE_APP_REACT_NATIVE/md/SIMBA_PLAYER_MODULE_V12_*.md`.
- V13 planning doc (DRM, Casting, V11 cleanup, iOS) at
  `MOBILE_APP_REACT_NATIVE/md/SIMBA_PLAYER_MODULE_V13_PLANNING.md`.

### Changed

- **Breaking.** Replaces the V11 inline-mount architecture entirely. See
  [DEVELOPER_MIGRATION.md](./DEVELOPER_MIGRATION.md) for upgrade notes
  (the V11 path is removed; the V11 source tree is archived under
  `md/archive/v11/` in the consumer-app repo).
- The `GamePlayerActivity` is no longer imported anywhere in V12 — the
  JS layer mounts the surface inside the dedicated `PlayerActivity`.

### Fixed

- **The V11 Picture-in-Picture black-screen bug.** V11's inline-mount
  approach tore down the surface when the activity lost focus. V12's
  dedicated `PlayerActivity` keeps the surface alive in PiP mode via
  `onPictureInPictureModeChanged` and a re-attach path.
- **Surface re-attach on config change.** Orientation changes no longer
  destroy the playback surface (`PlayerActivity` is `android:configChanges`
  opted-in).
- **No more "audio ducking on notification dismiss".** Audio focus is now
  owned by `PlayerActivity` with proper transient-duck semantics.

### Deprecated / Removed in V12

None in 1.0.0 — V12 ships clean. V11 deprecation happens in the
**consumer-app** repo (not in this package). The V1.0.0 release here is
a fresh baseline with no legacy.

### Migration from V11

If you're upgrading from `@simba-dev/player` (V11) or any in-house inline-mount
implementation, see [DEVELOPER_MIGRATION.md](./DEVELOPER_MIGRATION.md).
Short version:

```tsx
// V11 (removed)
import { VideoHost } from '@simba-dev/player';
<VideoHost uri={uri} />

// V12 (current)
import { PlayerProvider, PlayerSurface } from '@simba-dev/react-native-media-player';
import { open } from '@simba-dev/react-native-media-player/services';

open({ uri, title: 'episode 1' }); // launches the dedicated PlayerActivity
// or render inline if you have your own UI host
<PlayerProvider><PlayerSurface uri={uri} /></PlayerProvider>
```

### Notes for V12.0.0 reviewers

- **No iOS implementation** — Android-only release.
- **Binaries not in git.** The libmpv / ffmpeg `.so` files (~500 MB total)
  are excluded from git history via `.gitignore` and are bundled into
  the npm tarball by the `files` allow-list in `package.json`. Future
  versions may move to a postinstall hook.
- **95 jest tests pass** at the time of the V12.0.0 tag.
- **V11 docs archived** at `md/archive/v11/` in the consumer-app repo.

[1.0.0]: #100---2026-09-03
