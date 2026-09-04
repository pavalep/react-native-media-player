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
 * V15 Phase 65: the public hook for queue + playback-history state.
 *
 * Returns the full store: `{queue, playbackHistory, addToQueue, ...}`.
 * Use with a selector (and `useShallow` for object selectors) to
 * subscribe to a slice of the state and avoid unnecessary
 * re-renders.
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
export function useQueue<T = PlayerQueueStore>(
  selector?: (state: PlayerQueueStore) => T,
): T {
  if (selector) {
    return useStore(usePlayerQueueStore, useShallow(selector));
  }
  return useStore(usePlayerQueueStore) as unknown as T;
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
