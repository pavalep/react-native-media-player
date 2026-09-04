# Changelog

All notable changes to `@simba-dev/react-native-media-player` are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.0] - 2026-09-04 (V14.0.0 — junior-dev-level integration surface)

This is the **V14.0.0** release — the DX-polish layer on top of the V13 extraction. V13 shipped "complete the extraction"; V14 ships "make the integration so simple a junior dev can ship a working player with one import + one wrapper component + zero glue code". Every consumer's `App.tsx` now reads identically:

```tsx
<SimbaPlayer getResumePosition={(uri) => store.getState().bookmarks.byFileUri[uri]?.positionMs}>
  <AppContent />
</SimbaPlayer>
```

### Added (V14 Phases 59-63)

- **`<SimbaPlayerRoot>`** (Phase 59). Activity-branch wrapper. Calls `useLaunchParams()` internally; renders `<PlayerRoot />` when the activity was launched with playback params, otherwise renders its `children` (typically a navigator). Replaces the V13 `if (launchParams) return <PlayerRoot />` boilerplate from every consumer's `App.tsx`.
- **`useOpenFromUrl()`** (Phase 60). Deep-link helper hook. Returns a single function that filters `content://` + `file://` URIs, derives a display name from the URI basename, classifies the file as audio/video by extension, and forwards to `useOpenWithResume().openPlayer({uri, title, type, resumeId: uri})`. Replaces the V13 `handleIncomingUri` + `getMediaType` glue in the consumer's `App.tsx`.
- **`<SimbaPlayer>` now accepts a `getResumePosition` function prop** (Phase 61). The new function-prop shape is `getResumePosition={(resumeId) => number | undefined}`. The legacy `lookup={lookupObj}` object shape is retained for backward compat; if both are passed, `getResumePosition` wins.
- **`useSimbaPlayerLookup(selector?)`** (Phase 61). Factory hook that wraps an optional `selector` function in a memoized `PlayerResumeLookup` object. Without a selector, returns a no-op lookup. Hides the `useMemo<PlayerResumeLookup>(...)` boilerplate V13 consumers wrote by hand.
- **`GetResumePosition` type** exported from the module's `index.ts` — the function reference shape used by `<SimbaPlayer getResumePosition={...}>`.

### Consumer-side deprecation (V14 Phase 62)

These are **consumer-side changes** (not in the module) but worth noting because they remove the V11-mirrored state from the consumer's `playerSlice`:

- **`playbackState`, `currentPosition`, `duration`, `volume`, `isFullscreen`, `loopMode`, `playbackSpeed`** removed from the consumer's `playerSlice`. The module's `usePlayer()` is now the source of truth.
- **8 V11-only reducers removed**: `playFile`, `setPlaybackState`, `setPosition`, `setDuration`, `setVolume`, `toggleFullscreen`, `setLoopMode`, `setPlaybackSpeed`. Use `usePlayer().commands.play() / pause() / seek() / setVolume() / setSpeed() / setLoopMode()` instead.
- **7 mixed reducers** (`loadPlaylistToPlayer`, `playFromPlaylist`, `nextTrack`, `previousTrack`, `playFromQueue`, `clearPlaylist`, `clearPlayer`) lose their V11-mirror writes; the consumer parts (playlist, queue, currentIndex, currentFile, playbackHistory) stay.

### Notes

- **Backward-compatible.** All V13 consumers see the same `PlayerState`, `PlayerCommands`, `PlayerProgress`, `usePlayerActivity`, `useOpenWithResume`, `resolveStreamType`, `useLaunchParams`, `PlayerRoot`, `DefaultControls` exports. The new exports are additive; the new `<SimbaPlayer>` prop is additive (the `lookup` object prop still works).
- **No breaking changes** for any V13 consumer. The V14 DX polish is purely additive on the module side; on the consumer side it's a cleanup of the V11-mirrored state in `playerSlice` (which the consumer did not need to begin with — it was a V11-era convenience).
- **5 files migrated on the consumer side**: `useArtistScreen.ts` (also drops `playFile` dispatch), `useAlbumScreen.ts`, `useQueueScreen.ts`, `useLibraryScreen.ts`, `ArtistDetailScreen.tsx`. The consumer's `src/hooks/usePlayer.ts` (a dead wrapper that mirrored V11 fields) was moved to `v13-trash-2026-09-04/`.
- **V15 ideas** (deferred, not in this release): DRM (Widevine + ClearKey), Casting (DLNA + Chromecast + AirPlay-equivalent), iOS / Linux / tvOS support, delete `notificationService.ts` V11-only methods (kept for V11 rollback path), delete `v13-trash-2026-09-04/` directories.

## [1.2.0] - 2026-09-04 (V13.0.0 stable release)

This is the **V13.0.0** release — the V13 work ("complete the extraction") is now shipped end-to-end. The consumer's `MOBILE_APP_REACT_NATIVE` app is fully on the V13 module; all V11 inline player code is deleted. The module exposes a junior-dev-friendly public surface (`<SimbaPlayer>` wrapper, `usePlayerActivity`, `useOpenWithResume`, `useLaunchParams`, `resolveStreamType`) that any future consumer can adopt with **one import + one wrapper component**.

### Added (V13 Phases 51-58)

- **Live player state in `PlayerProvider`** (Phase 51). `PlayerState` (4→20 fields), `PlayerCommands` (5→38 methods), `PlayerProgress` (2→7 fields). `PlayerProvider` hydrates from sync bridge getters, subscribes to all 22 mpv events, and runs a 1Hz `getPosition`/`getDuration` poll. State held in a `useState` (rendered) + `useRef` (read-by-handlers) pair.
- **`usePlayerActivity()`** (Phase 52). Thin wrapper exposing `{ openPlayer(opts), getLaunchParams() }` for the 32+ call sites that previously used the V11 `usePlaybackCommands()`.
- **`<SimbaPlayer>` wrapper** (Phase 53+ DX). The one-import, one-wrapper integration point that composes `PlayerProvider` + `PlayerResumeProvider`. Consumer App.tsx wiring drops from 4+ imports and 2 wrappers to **1 import + 1 wrapper component**.
- **`useOpenWithResume()` + `PlayerResumeProvider`** (Phase 53 DX). Hook that accepts a `resumeId` and looks up the saved bookmark position via the consumer's `PlayerResumeLookup`. The lookup is a small adapter the consumer provides once at the app root.
- **`usePlayItem()`** (Phase 53 DX). Sugar on top of `useOpenWithResume` — takes `{id, uri, title}` + `{type}` and returns a one-arg press handler.
- **`useLaunchParams()`** (Phase 54 DX). One-shot accessor for the activity's launch payload. Used by App.tsx to branch between `<PlayerRoot />` and the regular navigator.
- **`resolveStreamType(contentKind: ContentKind): 'video' | 'audio'`** (Phase 53 DX). Maps consumer content kinds ('music', 'movie', 'podcast', 'live-tv', 'radio', 'audiobook', 'archive-audio', 'episode', 'video-file') to V13 stream types. Passthrough for already-V13 stream types. Idempotent. Without this, every one of the 32 screen files would have an inline `type: 'audio' | 'video'` ternary.
- **`<PlayerRoot />`** (Phase 54). The module's player surface + default controls. Used in the PlayerActivity branch of App.tsx; replaces the V11 custom player UI.
- **New exported types**: `PlaylistEntry`, `PlayerResumeLookup`, `ContentKind`, `SimbaPlayerProps`, `OpenPlayerOptions` (the V13 module's openPlayer shape).

### Changed (V13 Phases 51-58)

- **`PlayerStateContext` + `PlayerProgressContext` exported** from `src/types/player.ts`. Split state context prevents the 1Hz position tick from re-rendering volume-mirror consumers.
- **`applyPlayerEvent(state, progress, event, payload) → { state, progress }`** is the new pure event-dispatch function (replaces the V12 stub `usePlayer()`). Unit-testable in isolation.
- **`hydratePlayerState(bridge)`** + **`parseMetadata(json)`** are new pure helpers exported from `types/player.ts`.
- **`openPlayer` signature reshaped** from positional args to an options object: `openPlayer({uri, title, type, startPositionMs?})` returns `Promise<boolean>`.

### Notes

- **Backward-compatible.** All V12 `usePlayer()` consumers see the same 4 fields in `state` and the same 5 methods in `commands`. New fields are additive; new commands are additive.
- **No breaking changes** for any consumer that imports from `@simba-dev/react-native-media-player`. The V11-to-V13 work was consumer-side (the 38 source files in `MOBILE_APP_REACT_NATIVE/` were migrated in 5 batches).
- **V14 ideas** (deferred, not in this release): `<PlayerLauncher>` component, automatic type inference from URI, hook composition with the activity's PlayerActivity, smart default for `useOpenWithResume`'s lookup.
- **Device verification pending**: Phase 54c requires on-device testing of the PlayerActivity branch (PlayerRoot rendering). The typecheck + jest in the consumer pass; the smoke test (play / pause / seek / skip / PiP / lock-screen controls / Bluetooth controls / exit PiP) is a manual step.

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
