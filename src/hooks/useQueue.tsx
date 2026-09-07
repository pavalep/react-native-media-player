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

/**
 * V16 Phase 70: typed convenience hook for the queue array.
 *
 * Returns `useQueueItems()` cast to `T[]`. Use this when the
 * consumer wants to specialize `PlayerQueueItem` to its own
 * narrow literal unions (e.g.
 * `PlayerQueueItem<MediaSource, MediaKind, MediaLane>`) so the
 * items round-trip through `addToQueue` / `useQueueItemsAs`
 * without `as unknown as` casts at the boundary.
 *
 * The runtime contract: the module's queue store accepts any
 * `PlayerQueueItem` shape on write, so an item added with
 * `PlayerQueueItem<MediaSource, MediaKind, MediaLane>` is
 * stored structurally. The cast on read asserts the consumer's
 * domain knowledge that the items in the queue are typed.
 *
 * The cast lives here (one place) instead of being scattered
 * across every read site in the consumer.
 */
export function useQueueItemsAs<T extends PlayerQueueItem = PlayerQueueItem>(): T[] {
  return useStore(usePlayerQueueStore, state => state.queue as T[]);
}

/** Convenience hook: just the playback history array. */
export function usePlaybackHistory(): PlayerQueueItem[] {
  return useStore(usePlayerQueueStore, state => state.playbackHistory);
}

/**
 * V16 Phase 70: typed convenience hook for the playback history.
 * See {@link useQueueItemsAs} for the cast contract.
 */
export function usePlaybackHistoryAs<T extends PlayerQueueItem = PlayerQueueItem>(): T[] {
  return useStore(usePlayerQueueStore, state => state.playbackHistory as T[]);
}

export type {PlayerQueueItem, PlayerQueueStore} from '../stores/playerQueueStore';
