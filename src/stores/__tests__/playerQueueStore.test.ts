/**
 * Unit tests for `src/stores/playerQueueStore.ts`.
 *
 * The queue store is a pure zustand store. Its actions are
 * synchronous, side-effect-free, and operate on a local array —
 * no React, no bridge. This file pins the public surface
 * (add/prepend/remove/reorder/clear/shuffle + history) so that
 * V14/V15/V16 phase renames (e.g. `playFromQueue` →
 * `removeFromQueueByIndex` in Phase 72) don't silently regress.
 */

import {usePlayerQueueStore, type PlayerQueueItem} from '../playerQueueStore';

const sample = (overrides: Partial<PlayerQueueItem> = {}): PlayerQueueItem => ({
  uri: `file:///sample-${Math.random().toString(36).slice(2)}.mp4`,
  title: 'Sample',
  duration: 1000,
  ...overrides,
});

describe('playerQueueStore', () => {
  beforeEach(() => {
    // Reset between tests — the store is module-level, so its state
    // persists across tests within a single jest worker.
    usePlayerQueueStore.setState({queue: [], playbackHistory: []});
  });

  describe('queue actions', () => {
    it('addToQueue appends to the tail', () => {
      const a = sample({title: 'A'});
      const b = sample({title: 'B'});
      usePlayerQueueStore.getState().addToQueue(a);
      usePlayerQueueStore.getState().addToQueue(b);
      const {queue} = usePlayerQueueStore.getState();
      expect(queue).toHaveLength(2);
      expect(queue[0]).toEqual(a);
      expect(queue[1]).toEqual(b);
    });

    it('prependToQueue inserts at the head', () => {
      const a = sample({title: 'A'});
      const b = sample({title: 'B'});
      usePlayerQueueStore.getState().addToQueue(a);
      usePlayerQueueStore.getState().prependToQueue(b);
      const {queue} = usePlayerQueueStore.getState();
      expect(queue.map(i => i.title)).toEqual(['B', 'A']);
    });

    it('removeFromQueue splices the item at the index', () => {
      const a = sample({title: 'A'});
      const b = sample({title: 'B'});
      const c = sample({title: 'C'});
      usePlayerQueueStore.setState({queue: [a, b, c]});
      usePlayerQueueStore.getState().removeFromQueue(1);
      expect(usePlayerQueueStore.getState().queue.map(i => i.title)).toEqual([
        'A',
        'C',
      ]);
    });

    it('removeFromQueue is a no-op for out-of-range indices', () => {
      const a = sample({title: 'A'});
      usePlayerQueueStore.setState({queue: [a]});
      usePlayerQueueStore.getState().removeFromQueue(-1);
      usePlayerQueueStore.getState().removeFromQueue(99);
      expect(usePlayerQueueStore.getState().queue).toHaveLength(1);
    });

    it('reorderQueue accepts the positional (fromIndex, toIndex) shape', () => {
      const a = sample({title: 'A'});
      const b = sample({title: 'B'});
      const c = sample({title: 'C'});
      usePlayerQueueStore.setState({queue: [a, b, c]});
      usePlayerQueueStore.getState().reorderQueue(0, 2);
      expect(usePlayerQueueStore.getState().queue.map(i => i.title)).toEqual([
        'B',
        'C',
        'A',
      ]);
    });

    it('reorderQueue accepts the {fromIndex, toIndex} object shape', () => {
      const a = sample({title: 'A'});
      const b = sample({title: 'B'});
      const c = sample({title: 'C'});
      usePlayerQueueStore.setState({queue: [a, b, c]});
      usePlayerQueueStore.getState().reorderQueue({fromIndex: 2, toIndex: 0});
      expect(usePlayerQueueStore.getState().queue.map(i => i.title)).toEqual([
        'C',
        'A',
        'B',
      ]);
    });

    it('reorderQueue is a no-op when fromIndex === toIndex or out of range', () => {
      const a = sample({title: 'A'});
      const b = sample({title: 'B'});
      usePlayerQueueStore.setState({queue: [a, b]});
      usePlayerQueueStore.getState().reorderQueue(0, 0);
      usePlayerQueueStore.getState().reorderQueue(-1, 0);
      usePlayerQueueStore.getState().reorderQueue(0, 5);
      expect(usePlayerQueueStore.getState().queue.map(i => i.title)).toEqual([
        'A',
        'B',
      ]);
    });

    it('clearQueue empties the queue but preserves history', () => {
      const a = sample({title: 'A'});
      usePlayerQueueStore.getState().addToQueue(a);
      usePlayerQueueStore.getState().addToPlaybackHistory(a);
      usePlayerQueueStore.getState().clearQueue();
      const {queue, playbackHistory} = usePlayerQueueStore.getState();
      expect(queue).toEqual([]);
      expect(playbackHistory).toHaveLength(1);
    });

    it('shuffleQueue permutes the queue in place', () => {
      const items = Array.from({length: 10}, (_, i) => sample({title: `T${i}`}));
      usePlayerQueueStore.setState({queue: items});
      usePlayerQueueStore.getState().shuffleQueue();
      const {queue} = usePlayerQueueStore.getState();
      // Same elements, just reordered
      expect(queue.map(i => i.title).sort()).toEqual(
        items.map(i => i.title).sort(),
      );
    });

    it('removeFromQueueByIndex (Phase 72 rename of playFromQueue) splices the queue', () => {
      const a = sample({title: 'A'});
      const b = sample({title: 'B'});
      const c = sample({title: 'C'});
      usePlayerQueueStore.setState({queue: [a, b, c]});
      usePlayerQueueStore.getState().removeFromQueueByIndex(1);
      expect(usePlayerQueueStore.getState().queue.map(i => i.title)).toEqual([
        'A',
        'C',
      ]);
    });

    it('removeFromQueueByIndex is a no-op for invalid index', () => {
      const a = sample({title: 'A'});
      usePlayerQueueStore.setState({queue: [a]});
      usePlayerQueueStore.getState().removeFromQueueByIndex(99);
      expect(usePlayerQueueStore.getState().queue).toHaveLength(1);
    });
  });

  describe('playback history', () => {
    it('addToPlaybackHistory appends to the tail', () => {
      const a = sample({title: 'A'});
      const b = sample({title: 'B'});
      usePlayerQueueStore.getState().addToPlaybackHistory(a);
      usePlayerQueueStore.getState().addToPlaybackHistory(b);
      const {playbackHistory} = usePlayerQueueStore.getState();
      expect(playbackHistory).toHaveLength(2);
      expect(playbackHistory[0]).toEqual(a);
      expect(playbackHistory[1]).toEqual(b);
    });

    it('clearPlaybackHistory empties the history but preserves queue', () => {
      const a = sample({title: 'A'});
      usePlayerQueueStore.getState().addToQueue(a);
      usePlayerQueueStore.getState().addToPlaybackHistory(a);
      usePlayerQueueStore.getState().clearPlaybackHistory();
      const {queue, playbackHistory} = usePlayerQueueStore.getState();
      expect(playbackHistory).toEqual([]);
      expect(queue).toHaveLength(1);
    });
  });
});
