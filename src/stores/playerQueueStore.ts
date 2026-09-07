import {create} from 'zustand';

/**
 * V16 Phase 69: the queue item shape exposed by `useQueue()`.
 *
 * Structurally a superset of the consumer's V14 `playerSlice`
 * queue entry. `uri` and `title` are required; the rest are
 * optional and pass through to the store. The store does not
 * inspect these fields — they're retained so the UI can
 * display rich row content.
 *
 * The three classification fields (`source`, `type`, `mediaType`)
 * are **generic** with `string` defaults. Consumers with
 * narrower literal unions (e.g. `MediaSource`/`MediaKind`/
 * `MediaLane` for SIMBA) specialize the generic:
 *
 * ```ts
 * interface MyEntry extends PlayerQueueItem<MediaSource, MediaKind, MediaLane> {
 *   // consumer-only fields
 * }
 * ```
 *
 * With the generic specialized, a `MyEntry` flows through
 * `addToQueue(entry)` and back via `useQueueItems()` without
 * the consumer needing `as unknown as` casts at the boundary.
 *
 * Default usage (`PlayerQueueItem` with no generics) is
 * backward-compatible with V15 — the three fields stay `string`.
 *
 * `resumePosition` and `autoplay` are added in V16 so a
 * consumer's `PlaybackEntry` can extend `PlayerQueueItem`
 * directly without losing its existing fields.
 */
export interface PlayerQueueItem<
  TSource extends string = string,
  TKind extends string = string,
  TLane extends string = string,
> {
  uri: string;
  title: string;
  duration: number;
  artist?: string;
  album?: string;
  artworkUri?: string;
  /** Coarse provenance (e.g. `MediaSource` = 'local' | 'api'). */
  source?: TSource;
  /** Stream type or content kind (e.g. `MediaKind`). */
  type?: TKind;
  /** Playback lane (e.g. `MediaLane` = 'audio' | 'video'). */
  mediaType?: TLane;
  provider?: string;
  /** Stable linked-folder identity for local entries. */
  folderId?: string;
  /** V16: last native-confirmed playback position for resume. */
  resumePosition?: number;
  /** V16: whether the item should auto-play on load. */
  autoplay?: boolean;
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
   * Reorder: move item at `fromIndex` to `toIndex`. Accepts
   * either an object `{fromIndex, toIndex}` (preferred — matches
   * the consumer's V14 dispatch shape) or two positional
   * arguments. Other items shift accordingly.
   */
  reorderQueue: (
    fromIndexOrOpts: number | {fromIndex: number; toIndex: number},
    toIndexArg?: number,
  ) => void;
  /** Clear all items from the queue. */
  clearQueue: () => void;
  /**
   * In-place Fisher-Yates shuffle of the queue array.
   * The store's reference is preserved; the array contents
   * are mutated.
   */
  shuffleQueue: () => void;
  /**
   * V16 Phase 72: rename from `playFromQueue`. The old name
   * implied "play this item" but the implementation only
   * removed the item from the queue - it never promoted the
   * item to the active playlist. The new name is honest about
   * what the action does. To actually promote a queue item to
   * the active playlist and play it, the consumer should call
   * `useOpenPlaylist()` separately.
   */
  removeFromQueueByIndex: (index: number) => void;

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
 * V16 Phase 72: rename from `playFromQueueImpl`. The old name
 * implied "promote to playlist + play" but the implementation
 * only spliced the item from the queue. The new name reflects
 * what the action actually does: remove from queue. To
 * promote a queue item to the active playlist, the consumer
 * should call `useOpenPlaylist()` separately.
 */
function removeFromQueueByIndexImpl(
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
  reorderQueue: (fromIndexOrOpts, toIndexArg) =>
    set(state => {
      // Normalize the two accepted call shapes (object or positional).
      const fromIndex =
        typeof fromIndexOrOpts === 'number'
          ? fromIndexOrOpts
          : fromIndexOrOpts.fromIndex;
      const toIndex =
        typeof fromIndexOrOpts === 'number'
          ? toIndexArg ?? fromIndexOrOpts
          : fromIndexOrOpts.toIndex;
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
  removeFromQueueByIndex: (index) => removeFromQueueByIndexImpl(set, index),

  addToPlaybackHistory: (item) =>
    set(state => ({playbackHistory: [...state.playbackHistory, item]})),
  clearPlaybackHistory: () => set({playbackHistory: []}),
}));
