# Changelog

All notable changes to `@simba-dev/react-native-media-player` are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] - V13 Phases 51-52

### Added

- **Expanded `PlayerState` interface** (`src/types/player.ts`). The Phase 24 state had 4 fields (`isPlaying`, `title`, `artist`, `album`); the V13 Phase 51 state has **20 fields**. New fields: `positionMs`, `durationMs`, `isBuffering`, `isSeeking`, `seekable`, `volume`, `isMuted`, `speed`, `loopMode`, `playlist` (with new `PlaylistEntry` type), `currentIndex`, `tracks`, `chapters`, `currentChapter`, `videoParams`, `error`. Backward-compatible — all V12 fields keep their semantics.
- **Expanded `PlayerCommands` interface**. V12 had 5 methods (`play`, `pause`, `seek`, `skipBackward`, `skipForward`); V13 has **38 methods**. New methods: `togglePlayPause`, `stop`, `seekBy`, `seekToChapter`, `next`, `previous`, `setVolume`, `setMuted`, `toggleMute`, `setSpeed`, `setLoopMode`, `loadFile`, `loadPlaylist`, `playlistRemove`, `shuffle`, `clear`, `selectTrack`, `cycleTrack`, `setTrack`, `enterPip`, `exitPip`, `exitPipAndFinish`, `setKeepScreenOn`, `setOrientation`, `setImmersive`, `setScreenBrightness`, `requestNotificationPermission`, `openPlayer` (reshaped from positional to options object), `getLaunchParams`, `getProperty`, `setProperty`, `observeProperty`, `unobserveProperty`, `grantPersistablePermission`, `verifyContentUri`. The `commands` object is now a module-scope singleton — `useMemo`-wrapped consumers can memoise on the reference.
- **Expanded `PlayerProgress` interface**. V12 had 2 fields (`positionMs`, `durationMs`); V13 has **7 fields**. New fields: `isBuffering`, `isSeeking`, `seekable`, `cacheRanges`, `cacheFill`. `usePlayerProgress()` now reads from a separate context (owned by `PlayerProvider`) so consumers that only render a scrubber don't re-render on every volume / track / chapter change.
- **`usePlayerActivity()` hook** (`src/hooks/usePlayerActivity.ts`). Thin wrapper exposing `{ openPlayer(opts), getLaunchParams() }` for the consumer's 33+ call sites that previously used the V11 `usePlaybackCommands()`. The hook is non-throwing: outside a provider / in jest / on web preview, the bridge resolves to the no-op fallback and `openPlayer` resolves `false` / `getLaunchParams` returns `null`.
- **`PlayerStateContext` + `PlayerProgressContext`** exported from `src/types/player.ts` (used internally by `PlayerProvider`).
- **New exported types**: `PlaylistEntry` (in `src/types/player.ts`).

### Changed

- **`PlayerProvider` now owns the live player state**. On mount it (1) hydrates from synchronous bridge getters, (2) subscribes to all 22 mpv events via `subscribePlayerEvent`, and (3) starts a 1Hz `setInterval` polling `getPosition`/`getDuration`. The state is held in a `useState` (rendered) + `useRef` (read-by-event-handlers) pair. `usePlayer()` outside a provider still returns the `DEFAULT_STATE` (no throw), so `DefaultControls` can render in any environment.
- **`applyPlayerEvent(state, progress, event, payload) → { state, progress }`** is the new pure event-dispatch function (replaces the V12 stub `usePlayer()` which returned hardcoded `DEFAULT_STATE`). Unit-testable in isolation; exported from `types/player.ts` for V14 consumers.
- **`hydratePlayerState(bridge)`** is a new pure function exported from `types/player.ts` that runs the initial-mount hydration. The provider calls it in its mount effect.
- **`parseMetadata(json)`** is a new pure function exported from `types/player.ts` for parsing mpv's `metadata` property (a JSON array of `{key, value}` entries) into `{title, artist, album}`.
- **`usePlayer()`** is now a thin context consumer (was a hardcoded-default hook). The `commands` object is a module-scope singleton so `expect(commands).toBe(firstCommands)` holds across re-renders (per the Phase 24 stable-reference contract).
- **Test file rename**: `src/types/__tests__/player.test.ts` → `player.test.tsx` (the new tests need JSX for `<PlayerProvider>` wrappers). 100/100 tests pass.

### Notes

- **No version bump yet.** The V13 work lands as `1.2.0` at Phase 58 (V13 final QA + release). This Unreleased section documents Phases 51 + 52; Phases 53-58 will be appended before the release tag.
- **Backward-compatible.** All V12 `usePlayer()` consumers see the same 4 fields in `state` and the same 5 methods in `commands`. New fields are additive; new commands are additive.
- **Next up**: Phase 53 (migrate the consumer's 33+ call sites from `usePlaybackCommands`/`MpvPlayer`/`NativeModules.MpvPlayerModule` to module imports).

## [1.1.0] - 2026-09-03 (V13 Phase 50)

### Added

- **Expanded TypeScript bridge surface** (`src/bridge/MpvPlayerModule.ts`). The Phase 24 bridge exposed 9 methods needed by `DefaultControls`. The V13 Phase 50 bridge exposes **all 78 `@ReactMethod` declarations from `MpvBridgeModule.kt`** as typed methods on the `MpvPlayerModuleBridge` interface. Consumers (the `MOBILE_APP_REACT_NATIVE` consumer app in V13 Phases 53+) no longer need to reach into `NativeModules.MpvPlayerModule` directly — every bridge method is reachable via `getMpvPlayerModule().<method>()`.
- **Event subscription API** (`subscribePlayerEvent`, `removeAllListeners`). Wraps React Native's `NativeEventEmitter` with typed payload interfaces for all **22 mpv events** (`onFileLoaded`, `onPlaybackStateChanged`, `onPositionChanged`, `onDurationChanged`, `onPropertyChanged`, `onTracksChanged`, `onChapterChanged`, `onVideoParamsChanged`, `onError`, `onBuffering`, `onCacheState`, `onSeekable`, `onSeeking`, `onEndFile`, `onPlaybackRestart`, `onEndReached`, `onAudioDeviceChanged`, `onVolumeChanged`, `onSpeedChanged`, `videoReconfig`, `onPipModeChanged`, `onPipPlayPause`, `onPipExpand`, `onPipClose`).
- **New exported types**: `PlayerEventName`, `PlayerEventPayloads`, `LaunchParams`, `MpvPlaybackState`, `MpvLoopMode`, `MpvTrack`, `MpvChapter`, `MpvFileInfo`, `MpvVideoParams`, `MpvAudioDevice`.

### Changed

- **`setConfig`** now returns `Promise<number>` (the count of top-level keys parsed) instead of `Promise<void>`. Matches the Kotlin implementation at `MpvBridgeModule.kt` which calls `promise.resolve(parsed?.size ?: 0)`. Tests updated.
- **`resolveBridge()`** now also requires `loadFile` (cheap method independent of `initPlayer()`) to be present. The previous check (only `play`/`pause`/`seekAbsolute`) was insufficient — consumers using the expanded surface would silently fall back to the no-op bridge on partial mocks. The jest setup mock in `jest.setup.ts` is updated to include every method.

### Migration from 1.0.x

No breaking changes for existing consumers. The expansion adds methods + types; nothing is removed.

If a consumer was reaching into `NativeModules.MpvPlayerModule` directly, they can now import `getMpvPlayerModule()` instead. The old `MpvPlayer` API on the consumer side has an equivalent on the new bridge — see V13 spec §3.1 for the migration map.

### Notes

This is the foundation for V13 (complete the module extraction). Subsequent V13 phases (51-58) will:
- Phase 51: Wire `usePlayer`/`usePlayerProgress` to `subscribePlayerEvent` so they return live state instead of hardcoded defaults (Phase 25 was supposed to do this in V12 but didn't).
- Phase 52: Expose `openPlayer`/`getLaunchParams` via a `usePlayerActivity()` hook.
- Phase 53: Migrate the consumer's 33+ call sites from `usePlaybackCommands`/`MpvPlayer`/`NativeModules.MpvPlayerModule` to module imports.
- Phase 54-57: Mount `<PlayerProvider>` in `PlayerActivity`, then delete `src/modules/playback/`, `src/native/`, `src/contexts/TransportContext.tsx`.
- Phase 58: Release v1.2.0.

## [1.0.4] - 2026-09-03

### Added

- **OIDC trusted publishing** (`release.yml`): switched `npm publish` from long-lived `NPM_TOKEN` to GitHub Actions OIDC + npmjs trusted publisher. Configured at https://www.npmjs.com/package/@simba-dev/react-native-media-player/settings → Trusted Publisher (GitHub Actions, repo `pavalep/react-native-media-player`, workflow `release.yml`).
- **Promote workflow** (`.github/workflows/promote.yml`): `workflow_dispatch` job that promotes a `@staging` version to `@latest` via `npm dist-tag`, gated by the GitHub `production` environment with required reviewers. Publishes the corresponding draft GitHub Release.
- **Staged release model**: `release.yml` now publishes with `--tag=staging` + creates a **draft** GitHub Release. Promote workflow (manual approval) flips `staging → latest` and publishes the draft. This is the secure production release path.

### Fixed

- **`babel.config.js`** — removed stale `consumerDep()` workspace-link to `../MOBILE_APP_REACT_NATIVE/node_modules/@react-native/babel-preset`. CI run #15 failed because that sibling consumer-app directory doesn't exist in the GitHub Actions runner. Now uses `@react-native/babel-preset` directly from local node_modules.
- **`package.json`** — added `@react-native/babel-preset@0.86.0` to devDependencies (required by `babel.config.js`).
- **v1.0.3 first-publish 404** — npmjs trusted publishers sometimes 404 the very first OIDC publish to a package originally created via legacy auth. Worked around by publishing 1.0.3 via local bypass-2FA token, then 1.0.4 will re-test the OIDC path.

### Migration from 1.0.3

No code changes. CI/CD authentication model only. Consumers see no behavioral difference.

## [1.0.3] - 2026-09-03

### Added

- **GitHub Actions CI/CD pipeline.** Two workflows under `.github/workflows/`:
  - `ci.yml` — runs `npm ci` + `tsc --noEmit` + `npm run lint` + `jest` on a Node 20/22 matrix for every push to `main` and every PR. Concurrency-grouped to cancel stale runs. Coverage uploaded as artifact.
  - `release.yml` — on `v*.*.*` tag push: verifies the git tag matches `package.json` version, runs typecheck + lint + jest + `npm pack --dry-run`, then publishes to npm with `--provenance` (OIDC attestation from GitHub Actions) and auto-creates a GitHub Release with auto-generated notes.
- **Dependabot** (`.github/dependabot.yml`) — weekly npm + GitHub Actions dependency updates, grouped (react-native, testing) with semver guards on react-native minor bumps (bridgeless-mode compat).

### Fixed

- **`tsconfig.json`** — exclude `src/README.example.tsx` from `tsc --noEmit`. The file is example-code-only, intentionally excluded from the npm tarball via `package.json` `files`, but `tsc` was picking it up via `include: ["src/**/*"]` and failing on 20 errors (`Cannot find module 'react'`, missing `children` prop, etc.).
- **`README.md`** — added CI + Release workflow status badges; updated the bottom Status line to point at GitHub Releases + CHANGELOG instead of the broken link to the consumer-app spec doc.

### Changed

- **Node CI matrix** bumped from `[18, 20]` to `[20, 22]` — Node 18 reached EOL April 2025 and Node 20 is deprecated on GitHub Actions runners as of Sept 2025.
- **`package-lock.json`** committed (594 KB) so `npm ci` can resolve pinned versions in CI.

### Migration from 1.0.2

No code changes. CI/CD infrastructure only. Consumers who installed 1.0.2 see no behavioral difference.

## [1.0.2] - 2026-09-03

### Fixed

- **README hero image.** Replaced the broken `coresg-normal.trae.ai` text-to-image
  placeholder URL with a permanent `assets/hero.svg` in this repo, served via
  the GitHub raw URL `https://raw.githubusercontent.com/pavalep/react-native-media-player/main/assets/hero.svg`.
  Self-contained, no external dependencies, ~3 KB SVG that renders identically on
  GitHub README preview + npmjs README renderer.

### Added

- `assets/hero.svg` — 1600×900 hand-crafted SVG mockup showing the Simba Player UI
  on a phone-frame (dark theme, golden play button, skip-back/skip-forward,
  scrubber with progress, time labels). Includes SIMBA PLAYER branding, the
  "v12.0.2 · @simba-dev/react-native-media-player · MIT" footer chip, and
  feature badges (PiP / MediaSession / Foreground svc / TypeScript) on the
  top-right.
- `package.json` `files` allow-list now includes `assets/` so the SVG is also
  shipped in the npm tarball for consumers who want to inspect or reuse it.

### Migration from 1.0.1

No code changes. The new SVG just replaces a previously-broken image URL.

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
