import {useStore} from 'zustand';
import {useShallow} from 'zustand/react/shallow';
import {
  usePlayerQueueStore,
} from '../stores/playerQueueStore';
import type {
  PlayerQueueItem,
  PlayerQueueStore,
} from '../stores/playerQueueStore';

/**
 * V15 Phase 65 (V16 Phase 69 hardened): the public hook for queue +
 * playback-history state.
 *
 * Two overloads:
 * - `useQueue()` returns the full store `{queue, playbackHistory, addToQueue, ...}`.
 * - `useQueue(selector)` returns the selected slice (use `useShallow`
 *   on object selectors to subscribe by-value and avoid unnecessary
 *   re-renders).
 *
 * @example
 * ```tsx
 * function QueueScreen() {
 *   const {queue, addToQueue, removeFromQueue} = useQueue();
 *   return <FlatList data={queue} ... />;
 * }
 *
 * // For a single field (no re-render on other field changes):
 * function QueueBadge() {
 *   const length = useQueueLength();
 *   return <Text>{length}</Text>;
 * }
 * ```
 */
export function useQueue(): PlayerQueueStore;
export function useQueue<T>(selector: (state: PlayerQueueStore) => T): T;
export function useQueue<T>(
  selector?: (state: PlayerQueueStore) => T,
): PlayerQueueStore | T {
  if (selector) {
    return useStore(usePlayerQueueStore, useShallow(selector));
  }
  return useStore(usePlayerQueueStore);
}

/** Convenience hook: just the queue length. */
export function useQueueLength(): number {
  return useStore(usePlayerQueueStore, state => state.queue.length);
}

/** Convenience hook: just the queue array. */
export function useQueueItems(): PlayerQueueItem[] {
  return useStore(usePlayerQueueStore, state => state.queue);
}

/** Convenience hook: just the playback history array. */
export function usePlaybackHistory(): PlayerQueueItem[] {
  return useStore(usePlayerQueueStore, state => state.playbackHistory);
}

export type {PlayerQueueItem, PlayerQueueStore} from '../stores/playerQueueStore';
