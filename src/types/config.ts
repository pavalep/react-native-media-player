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
  /** When true, pressing home / recents / app-switcher auto-enters PiP. */
  autoEnterOnLeave: boolean;
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
