/**
 * Configuration types for `@simba/react-native-media-player`.
 *
 * Phase 21 entry point — every field is optional; defaults match V11
 * behaviour so existing consumers can adopt the provider without any
 * behaviour change. Phases 22-25 layer richer UI controls on top of
 * these primitives.
 *
 * Design notes
 * ------------
 * - `PlayerConfig` (input) is partial at every level so consumers can
 *   override just the keys they care about. `ResolvedPlayerConfig`
 *   (output) is fully populated — the native side always sees a
 *   complete config with no nulls.
 * - The defaults are intentionally permissive (PiP on, audio
 *   background on, hardware decoding auto, notifications on). Each
 *   can be flipped off without breaking anything else.
 * - `resolvePlayerConfig(config)` is exported so tests + debug
 *   overlays can introspect the effective values without having to
 *   render a Provider.
 */

/** Theme colors consumed by the default controls (Phase 22+) and any
 *  consumer-rendered custom UI. */
export interface PlayerTheme {
  /** Primary accent (play button highlight, progress bar, etc.). */
  accent: string;
  /** Background color of the player surface. */
  background: string;
  /** Primary text color (titles, time labels). */
  text: string;
  /** Secondary text color (subtitles, less prominent labels). */
  textSecondary: string;
  /** Surface color for floating elements (cards, menus). */
  surface: string;
  /** Optional icon color override (defaults to `text`). */
  icon?: string;
}

/** Dark default theme — matches the V11 look (golden accent on
 *  near-black). */
export const DEFAULT_THEME: PlayerTheme = {
  accent: '#FFD700',
  background: '#121216',
  text: '#FFFFFF',
  textSecondary: 'rgba(255,255,255,0.6)',
  surface: 'rgba(255,255,255,0.1)',
};

/** Picture-in-Picture configuration. */
export interface PipConfig {
  /** Master switch — when false, all PiP entry requests are ignored. */
  enabled: boolean;
  /**
   * When true, the library enters Picture-in-Picture ITSELF when the user
   * leaves the app (home, recents, app switcher).
   *
   * The entry happens in native code, inside the Activity's
   * `onUserLeaveHint()`, because by then React Native has ALREADY frozen, in
   * TWO ways: `FabricUIManager.onHostPause()` removes the DISPATCH_UI frame
   * callback, so mount items are never applied to native views, and
   * `JavaTimerManager.onHostPause()` freezes the timer registry, so
   * `requestAnimationFrame` never fires. The JS runtime itself keeps running.
   * Measured on emulator-5554 (API 37) on 2026-11-03: the JS handler ran
   * immediately, the effect that would have driven the entry ran 5.7 s late,
   * and the `requestAnimationFrame` never fired.
   *
   * On Android 12+ the library also arms Android's own auto-enter switch
   * (`PictureInPictureParams.Builder.setAutoEnterEnabled`), but ONLY while
   * media is loaded — and it commits the PiP params to the Activity early,
   * because the platform builds the PiP window from the LAST COMMITTED params
   * and crops the app's window to their source rect hint. That crop is what
   * keeps the app's chrome out of the PiP window.
   *
   * See the README's Picture-in-Picture section for how the two mechanisms
   * fit together.
   */
  autoEnterOnLeave: boolean;
  /**
   * The `nativeID` of the consumer's chrome root — the view the library hides
   * natively when it enters PiP.
   *
   * The literal belongs to the CONSUMER: the library stores it and uses it,
   * and never hardcodes one of its own. Put the same string on the
   * consumer's chrome `<View nativeID="...">`.
   *
   * Omit it when the consumer draws no chrome of its own — then the library
   * enters PiP without hiding anything.
   *
   * When it IS set and no view carries that `nativeID`, the chrome is ALREADY
   * gone — the consumer's own button path unmounts it in React before it asks
   * for the window — so the library logs that and carries on. It never refuses
   * the entry over a missing view.
   */
  chromeNativeId?: string;
}

/** Audio playback configuration. */
export interface AudioConfig {
  /**
   * Keep playing when the user backgrounds the activity. Default `true`
   * — matches Spotify / Apple Music behaviour for audio files. Has no
   * effect on video files (which always pause on background; see
   * Phase 14 in the SPEC).
   */
  backgroundPlayback: boolean;
  /**
   * Respect Android audio focus changes (pause on phone-call ring,
   * duck for nav prompts, etc.). Default `true`.
   */
  respectAudioFocus: boolean;
}

/** Subtitle configuration. */
export interface SubtitleConfig {
  /** Preferred subtitle languages in BCP-47 order (e.g. `['en', 'fr']`). */
  preferredLanguages: string[];
  /** Font size in dp. Default 16. */
  fontSize: number;
}

/** Notification configuration. */
export interface NotificationConfig {
  /** Master switch — when false, no media-style notification is shown. */
  enabled: boolean;
  /** Channel ID for the notification channel. Must be unique per
   *  consumer app; the channel is created lazily on first use. */
  channelId: string;
}

/** Hardware decoding policy — maps 1:1 to mpv's `--hwdec` option. */
export type HardwareDecodingPolicy = 'auto' | 'mediacodec' | 'no';

/** Debug configuration. */
export interface DebugConfig {
  /** When true, the native side logs verbose mpv / bridge events. */
  verboseLogging: boolean;
}

/**
 * Global configuration for `@simba/react-native-media-player`. Passed
 * to `<PlayerProvider config={...}>` at the consumer app root.
 *
 * Every field is optional. The native side receives the *resolved*
 * config (after defaults are merged in), so the consumer never has to
 * worry about null checks on the Kotlin side.
 */
export interface PlayerConfig {
  theme?: Partial<PlayerTheme>;
  pip?: Partial<PipConfig>;
  hardwareDecoding?: HardwareDecodingPolicy;
  notifications?: Partial<NotificationConfig>;
  audio?: Partial<AudioConfig>;
  subtitle?: Partial<SubtitleConfig>;
  debug?: Partial<DebugConfig>;
}

/**
 * Fully-resolved config after defaults are merged in. This is the
 * shape the native side sees (every field is non-null). Computed by
 * `resolvePlayerConfig(config)` so consumers can introspect the
 * effective values without the provider.
 */
export interface ResolvedPlayerConfig {
  theme: PlayerTheme;
  pip: PipConfig;
  hardwareDecoding: HardwareDecodingPolicy;
  notifications: NotificationConfig;
  audio: AudioConfig;
  subtitle: SubtitleConfig;
  debug: DebugConfig;
}

/**
 * Merge a user-supplied partial config with the defaults. Exported for
 * tests + debug overlays.
 *
 * The merge is shallow per-section (theme, pip, audio, etc.) but
 * recursive in that each section has its own partial shape. For
 * example, `config.theme = { accent: '#FF0000' }` only overrides the
 * accent color and keeps the rest of the default theme.
 */
export function resolvePlayerConfig(
  config: PlayerConfig = {},
): ResolvedPlayerConfig {
  return {
    theme: { ...DEFAULT_THEME, ...(config.theme ?? {}) },
    pip: { enabled: true, autoEnterOnLeave: true, ...(config.pip ?? {}) },
    hardwareDecoding: config.hardwareDecoding ?? 'auto',
    notifications: {
      enabled: true,
      channelId: 'simba_player_media',
      ...(config.notifications ?? {}),
    },
    audio: {
      backgroundPlayback: true,
      respectAudioFocus: true,
      ...(config.audio ?? {}),
    },
    subtitle: {
      preferredLanguages: [],
      fontSize: 16,
      ...(config.subtitle ?? {}),
    },
    debug: { verboseLogging: false, ...(config.debug ?? {}) },
  };
}

/** The default config — exposed as a const so consumers can spread it
 *  (`<PlayerProvider config={{ ...DEFAULT_PLAYER_CONFIG, audio:
 *  { backgroundPlayback: false } }} />`). */
export const DEFAULT_PLAYER_CONFIG: ResolvedPlayerConfig = resolvePlayerConfig();
