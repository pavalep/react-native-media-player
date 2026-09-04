import {create} from 'zustand';

/**
 * V15 Phase 65: the queue item shape exposed by `useQueue()`.
 *
 * Mirrors the consumer's V14 `playerSlice` queue entry: a
 * minimal `(fileUri, title)` plus the metadata the consumer
 * needs to display the queue UI. Kept structurally compatible
 * with the consumer's `QueueItem` type so existing UI components
 * can be migrated without shape changes.
 */
export interface PlayerQueueItem {
  fileUri: string;
  title: string;
  source?: string;
  /** `'audio' | 'video'` stream type. */
  type?: 'audio' | 'video';
  mediaType?: 'audio' | 'video';
  provider?: string;
  /** Stable linked-folder identity for local entries. */
  folderId?: string;
}

/**
 * V15 Phase 65: actions exposed by the queue store.
 */
export interface PlayerQueueActions {
  /** Append a single item to the queue's tail. */
  addToQueue: (item: PlayerQueueItem) => void;
  /** Insert a single item at the queue's head ("Play Next"). */
  prependToQueue: (item: PlayerQueueItem) => void;
  /** Remove the item at the given index. */
  removeFromQueue: (index: number) => void;
  /**
   * Reorder: move item at `fromIndex` to `toIndex`.
   * Other items shift accordingly.
   */
  reorderQueue: (fromIndex: number, toIndex: number) => void;
  /** Clear all items from the queue. */
  clearQueue: () => void;
  /**
   * In-place Fisher-Yates shuffle of the queue array.
   * The store's reference is preserved; the array contents
   * are mutated.
   */
  shuffleQueue: () => void;
  /**
   * Promote a queue item to the module's playlist and play it.
   *
   * The queue stays display-only for the rest of the playback
   * (the module's `next()` doesn't consume it). Phase 65 keeps
   * the same semantics as the V14 `playFromQueue` reducer in
   * `playerSlice`.
   */
  playFromQueue: (index: number) => void;

  /** Append a single item to the playback history. */
  addToPlaybackHistory: (item: PlayerQueueItem) => void;
  /** Clear the playback history. */
  clearPlaybackHistory: () => void;
}

/**
 * V15 Phase 65: the queue + playback-history store.
 */
export interface PlayerQueueStore extends PlayerQueueActions {
  queue: PlayerQueueItem[];
  playbackHistory: PlayerQueueItem[];
}

/**
 * V15 Phase 65: a no-op placeholder for `playFromQueue` that
 * the module-side store doesn't directly drive. The actual
 * playlist update is performed by the activity via
 * `bridge.loadPlaylist` + `bridge.setTrack`; for now, the
 * store just removes the item from the queue (Phase 65 is
 * the data-consolidation step; the actual playlist command
 * remains consumer's responsibility until Phase 66 or a
 * follow-up phase consolidates it too).
 */
function playFromQueueImpl(
  set: (updater: (state: PlayerQueueStore) => PlayerQueueStore) => void,
  index: number,
): void {
  set((state) => {
    if (index < 0 || index >= state.queue.length) return state;
    const [item] = state.queue.splice(index, 1);
    if (!item) return state;
    return {...state};
  });
}

export const usePlayerQueueStore = create<PlayerQueueStore>()((set) => ({
  queue: [],
  playbackHistory: [],

  addToQueue: (item) => set(state => ({queue: [...state.queue, item]})),
  prependToQueue: (item) =>
    set(state => ({queue: [item, ...state.queue]})),
  removeFromQueue: (index) =>
    set(state => {
      if (index < 0 || index >= state.queue.length) return state;
      return {queue: state.queue.filter((_, i) => i !== index)};
    }),
  reorderQueue: (fromIndex, toIndex) =>
    set(state => {
      if (
        fromIndex === toIndex ||
        fromIndex < 0 ||
        fromIndex >= state.queue.length ||
        toIndex < 0 ||
        toIndex >= state.queue.length
      ) {
        return state;
      }
      const next = state.queue.slice();
      const [moved] = next.splice(fromIndex, 1);
      if (!moved) return state;
      next.splice(toIndex, 0, moved);
      return {queue: next};
    }),
  clearQueue: () => set({queue: []}),
  shuffleQueue: () =>
    set(state => {
      const q = state.queue.slice();
      for (let i = q.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [q[i], q[j]] = [q[j], q[i]];
      }
      return {queue: q};
    }),
  playFromQueue: (index) => playFromQueueImpl(set, index),

  addToPlaybackHistory: (item) =>
    set(state => ({playbackHistory: [...state.playbackHistory, item]})),
  clearPlaybackHistory: () => set({playbackHistory: []}),
}));
