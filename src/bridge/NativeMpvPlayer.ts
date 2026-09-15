/**
 * TurboModule spec for the libmpv-backed player.
 *
 * In-session patch (SIMBA V22 D-032 follow-up / B-010 root cause):
 * codegen ONLY processes files whose contents match
 *   /export\s+default\s+\(?codegenNativeComponent</  OR  /extends TurboModule/
 * (see `node_modules/@react-native/codegen/lib/cli/combine/combine-js-to-schema.js:22`).
 * The previous source tree shipped `MpvPlayerModule.ts` (a plain TS bridge
 * with `MpvPlayerModuleBridge` interface) but no `Native*.ts` spec — so
 * `:simba-dev_react-native-media-player:generateCodegenArtifactsFromSchema`
 * emitted `No modules to process in combine-js-to-schema-cli.` and no
 * `NativeMpvPlayerSpec.java` was ever produced. In `newArchEnabled=true`
 * that means the new-arch TurboModule resolver cannot find a spec for
 * "MpvPlayerModule", JS-side `NativeModules.MpvPlayerModule` is `undefined`,
 * `resolveBridge()` returns `null`, and `openPlayer()` falls back to
 * `NOOP_BRIDGE.openPlayer` which resolves `false` (the "Player refused
 * launch" toast you saw on the Movies screen).
 *
 * The Kotlin side is wired correctly — `MpvBridgeModule` has
 * `@ReactModule(name = MpvBridgeModule.NAME)` where `NAME = "MpvPlayerModule"`
 * and `PlayerPackage` is a `TurboReactPackage` with `isTurboModule = true`.
 * The lib's `package.json` declares
 *   codegenConfig: { name: "SimbaPlayerSpec", type: "modules", jsSrcsDir: "src" }
 * and the consumer app's `react { autolinkLibrariesWithApp() }` triggers
 * `:simba-dev_react-native-media-player:generateCodegenArtifactsFromSchema`.
 *
 * Once this file exists, codegen produces `NativeMpvPlayerSpec.java`
 * under `android/app/build/generated/source/codegen/java/com/simba/player/`.
 * That spec wires the JS-side `NativeModules.MpvPlayerModule` to
 * `MpvBridgeModule` (the Kotlin `@ReactModule` of the same name) and
 * `MpvPlayerModule.ts`'s `resolveBridge()` finally finds a live bridge.
 *
 * The Spec mirrors the existing `MpvPlayerModuleBridge` interface
 * (`src/bridge/MpvPlayerModule.ts:182`). Methods NOT declared here are
 * unreachable from JS, but the Kotlin side keeps them for callers that
 * already work around the bridge (none in the consumer app today).
 *
 * Type-mapping notes for codegen:
 *  - `string | null` → `string` (codegen does not support nullable string;
 *    JS passes null, Kotlin receives the empty string).
 *  - `unknown` → `mixed` (codegen accepts `mixed` / `Object`).
 *  - `'video' | 'audio'` → `string` (codegen treats string-literal
 *    unions as plain `string`; runtime type check is the Kotlin side's job).
 *  - `Promise<T>` → method becomes async on the Kotlin side; codegen
 *    emits a `Promise` parameter type which Kotlin `@ReactMethod`
 *    receives as `Promise` (the 5th parameter when `isBlockingSynchronousMethod=false`).
 *  - All other primitives pass through.
 */
import type {TurboModule} from 'react-native';
import {TurboModuleRegistry} from 'react-native';

export interface Spec extends TurboModule {
  // ── Lifecycle ──────────────────────────────────────────────────────────
  initPlayer(): boolean;
  destroy(): void;
  getNativePtr(): number;

  // ── Playback control ───────────────────────────────────────────────────
  play(): void;
  pause(): void;
  stop(): void;
  togglePlayPause(): void;
  seekAbsolute(positionSeconds: number): void;
  seekForward(seconds: number): void;
  seekBackward(seconds: number): void;
  stepFrame(direction: number): void; // 1 | -1 — codegen treats as number
  screenshot(): string;

  // ── File loading ───────────────────────────────────────────────────────
  loadFile(path: string): void;
  loadFileWithRequestId(path: string, requestId: string): void;
  loadPlaylist(paths: ReadonlyArray<string>, startIndex: number): void;
  getFileInfo(): string;
  getVideoParams(): string;
  captureThumbnail(uri: string): string;
  grantPersistablePermission(uri: string): void;
  verifyContentUri(uri: string): boolean;

  // ── Tracks ─────────────────────────────────────────────────────────────
  getTracks(): string;
  selectTrack(trackId: number): void;
  cycleTrack(type: string): void;
  setTrack(type: string, trackId: number): void;
  setTrackVisibility(trackType: string, visible: boolean): void;

  // ── Chapters ───────────────────────────────────────────────────────────
  getChapters(): string;
  seekChapter(direction: number): void;
  getCurrentChapter(): string;

  // ── Volume / audio ─────────────────────────────────────────────────────
  setVolume(volume: number): void;
  getVolume(): number;
  setMuted(muted: boolean): void;
  getMuted(): boolean;
  isMuted(): boolean;
  getAudioDevices(): string;
  setAudioDevice(deviceName: string): void;
  toggleMute(): void;

  // ── Playback speed ─────────────────────────────────────────────────────
  setSpeed(speed: number): void;
  getSpeed(): number;

  // ── Loop / repeat ──────────────────────────────────────────────────────
  setLoopMode(mode: string): void;
  getLoopMode(): string;
  setPlaylistLoop(loop: boolean): void;

  // ── Properties ─────────────────────────────────────────────────────────
  getProperty(name: string): string;
  setProperty(name: string, value: string): void;
  observeProperty(name: string): void;
  unobserveProperty(name: string): void;

  // ── Filters ────────────────────────────────────────────────────────────
  setVideoFilter(filter: string, enabled: boolean): void;
  setAudioFilter(filter: string, enabled: boolean): void;

  // ── Playlist ───────────────────────────────────────────────────────────
  getPlaylist(): string;
  playlistNext(): void;
  playlistPrev(): void;
  playlistRemove(index: number): void;
  playlistShuffle(): void;
  playlistClear(): void;

  // ── State queries ──────────────────────────────────────────────────────
  getPosition(): number;
  getDuration(): number;
  getPlaybackState(): string;

  // ── Activity launch (V12 Phase 3 / V13 Phase 52) ───────────────────────
  // Promise<boolean> — Kotlin @ReactMethod rejects with E_INVALID_TYPE /
  // E_NO_ACTIVITY / E_ACTIVITY_NOT_FOUND / E_SECURITY / E_OPEN_PLAYER_FAILED.
  // See `MpvBridgeModule.kt:1240-1320` for the launch implementation.
  openPlayer(
    uri: string,
    title: string,
    type: string,
    startPositionMs: number,
  ): Promise<boolean>;
  // Returns null when no launch is pending or after the first read.
  getLaunchParams(): Promise<{
    uri: string;
    title: string;
    type: string;
    startPositionMs: number;
  } | null>;

  // V22.0.0 / 1.5.10 (D-034): activity-aware launchParams guard.
  //
  // `MpvBridgeModule.lastLaunchParams` is the canonical handoff from
  // `openPlayer(...)` to the next `PlayerActivity` mount. The previous
  // architecture had `useLaunchParams()` consume it from BOTH
  // MainActivity's React tree and PlayerActivity's React tree.
  // Result on cold start: stale `lastLaunchParams` from a prior
  // `openPlayer` call (set when the user previously tapped a card)
  // was consumed by MainActivity's `<SimbaPlayerRoot>` and rendered
  // `<PlayerRoot />` over the Home screen.
  //
  // The fix: PlayerActivity sets this flag to `true` in onCreate and
  // `false` in onDestroy. `useLaunchParams()` consults it via this
  // synchronous getter and returns `null` (without consuming
  // lastLaunchParams) when we're in MainActivity.
  //
  // Why sync, not Promise: `useLaunchParams` runs the check before the
  // Promise<T> | null decision, so the synchronous bridge path keeps
  // the consumer's render logic straight-line (no Suspense / loading
  // gate at app cold start). Codegen emits a synchronous bridge
  // method as-is when the Kotlin signature is
  // `@ReactMethod(isBlockingSynchronousMethod = true)`.
  isCurrentActivityPlayer(): boolean;

  // ── Configuration (V12 Phase 21) ───────────────────────────────────────
  setConfig(configJson: string): Promise<number>;

  // ── Picture-in-Picture ─────────────────────────────────────────────────
  enterPip(chapterTitle: string, progressPct: string): void;
  exitPip(): void;
  exitPipAndFinish(): void;

  // ── Keep screen on (V12 W2.12) ──────────────────────────────────────────
  setKeepScreenOn(enabled: boolean): void;

  // ── Orientation / immersive ────────────────────────────────────────────
  setOrientation(mode: string): void;
  setImmersive(enabled: boolean): void;

  // ── Screen brightness ──────────────────────────────────────────────────
  setScreenBrightness(value: number): void;
  getScreenBrightness(): number;

  // ── Notification permission ────────────────────────────────────────────
  requestNotificationPermission(): void;
  isNotificationActive(): boolean;

  // ── Debug (V12 Phase 39) ───────────────────────────────────────────────
  setDebugLogging(enabled: boolean): void;
  dumpObservedProperties(): number;
}

export default TurboModuleRegistry.getEnforcing<Spec>('MpvPlayerModule');
