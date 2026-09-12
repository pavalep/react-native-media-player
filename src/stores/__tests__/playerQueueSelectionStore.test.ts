/**
 * Unit tests for `src/stores/playerQueueSelectionStore.ts`.
 *
 * The selection store holds the indices of queue items the
 * user has multi-tapped, plus two pure helpers that return the
 * indices sorted for batch ops (`removeSelected` descending,
 * `moveSelectedToTop` ascending). Pinning these prevents the
 * "sort order flipped" regression that would silently corrupt
 * the queue array when the caller iterates `removeSelected`'s
 * output in order to splice.
 */

import {usePlayerQueueSelectionStore} from '../playerQueueSelectionStore';

describe('playerQueueSelectionStore', () => {
  beforeEach(() => {
    usePlayerQueueSelectionStore.setState({selectedIndices: []});
  });

  it('setSelection replaces the selection array', () => {
    usePlayerQueueSelectionStore.getState().setSelection([1, 3, 5]);
    expect(usePlayerQueueSelectionStore.getState().selectedIndices).toEqual([
      1, 3, 5,
    ]);
  });

  it('clearSelection empties the selection', () => {
    usePlayerQueueSelectionStore.getState().setSelection([0, 1]);
    usePlayerQueueSelectionStore.getState().clearSelection();
    expect(usePlayerQueueSelectionStore.getState().selectedIndices).toEqual(
      [],
    );
  });

  it('removeSelected returns indices sorted DESCENDING', () => {
    usePlayerQueueSelectionStore.getState().setSelection([3, 1, 5]);
    expect(usePlayerQueueSelectionStore.getState().removeSelected()).toEqual([
      5, 3, 1,
    ]);
  });

  it('removeSelected does not mutate the stored selection', () => {
    usePlayerQueueSelectionStore.getState().setSelection([2, 0, 4]);
    usePlayerQueueSelectionStore.getState().removeSelected();
    expect(usePlayerQueueSelectionStore.getState().selectedIndices).toEqual([
      2, 0, 4,
    ]);
  });

  it('moveSelectedToTop returns indices sorted ASCENDING', () => {
    usePlayerQueueSelectionStore.getState().setSelection([4, 1, 3]);
    expect(
      usePlayerQueueSelectionStore.getState().moveSelectedToTop(),
    ).toEqual([1, 3, 4]);
  });

  it('moveSelectedToTop does not mutate the stored selection', () => {
    usePlayerQueueSelectionStore.getState().setSelection([4, 1, 3]);
    usePlayerQueueSelectionStore.getState().moveSelectedToTop();
    expect(usePlayerQueueSelectionStore.getState().selectedIndices).toEqual([
      4, 1, 3,
    ]);
  });

  it('handles empty selection gracefully', () => {
    expect(usePlayerQueueSelectionStore.getState().removeSelected()).toEqual(
      [],
    );
    expect(
      usePlayerQueueSelectionStore.getState().moveSelectedToTop(),
    ).toEqual([]);
  });
});
