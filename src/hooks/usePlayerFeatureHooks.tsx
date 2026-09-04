import {useStore} from 'zustand';
import {
  usePlayerSleepTimerStore,
  type PlayerSleepTimerStore,
  type SleepTimerMode,
} from '../stores/playerSleepTimerStore';
import {
  usePlayerEqualizerStore,
  type PlayerEqualizerStore,
} from '../stores/playerEqualizerStore';
import {
  usePlayerLikedStore,
  type PlayerLikedStore,
} from '../stores/playerLikedStore';
import {
  usePlayerShuffleStore,
  type PlayerShuffleStore,
} from '../stores/playerShuffleStore';

/**
 * V15 Phase 66: the sleep-timer hook.
 *
 * @example
 * ```tsx
 * const {endTime, setTimer, clear} = useSleepTimer();
 * const handle30Min = () => setTimer(30 * 60);
 * ```
 */
export function useSleepTimer(): PlayerSleepTimerStore {
  return useStore(usePlayerSleepTimerStore);
}

/** Convenience hook: just the end time (or null). */
export function useSleepTimerEnd(): number | null {
  return useStore(usePlayerSleepTimerStore, state => state.endTime);
}

/** Convenience hook: just the mode. */
export function useSleepTimerMode(): SleepTimerMode {
  return useStore(usePlayerSleepTimerStore, state => state.mode);
}

/**
 * V15 Phase 66: the equalizer hook.
 *
 * @example
 * ```tsx
 * const {gains, enabled, setGains, toggle} = useEqualizer();
 * ```
 */
export function useEqualizer(): PlayerEqualizerStore {
  return useStore(usePlayerEqualizerStore);
}

/** Convenience hook: just the enabled flag. */
export function useEqualizerEnabled(): boolean {
  return useStore(usePlayerEqualizerStore, state => state.enabled);
}

/**
 * V15 Phase 66: the per-file "liked" hook.
 *
 * @example
 * ```tsx
 * const isLiked = useIsLiked(uri);
 * const toggle = useToggleLiked();
 * <Pressable onPress={() => toggle(uri)}>{isLiked ? '♥' : '♡'}</Pressable>
 * ```
 */
export function useIsLiked(uri: string): boolean {
  return useStore(usePlayerLikedStore, state => !!state.liked[uri]);
}

export function useToggleLiked(): (uri: string) => boolean {
  return useStore(usePlayerLikedStore, state => state.toggle);
}

/** V15 Phase 66: the shuffle hook. */
export function useShuffle(): PlayerShuffleStore {
  return useStore(usePlayerShuffleStore);
}

/** Convenience hook: just the shuffle enabled flag. */
export function useShuffleEnabled(): boolean {
  return useStore(usePlayerShuffleStore, state => state.enabled);
}

export type {
  PlayerSleepTimerStore,
  SleepTimerMode,
} from '../stores/playerSleepTimerStore';
export type {PlayerEqualizerStore} from '../stores/playerEqualizerStore';
export type {PlayerLikedStore} from '../stores/playerLikedStore';
export type {PlayerShuffleStore} from '../stores/playerShuffleStore';
