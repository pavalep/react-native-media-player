import {create} from 'zustand';

/**
 * V15 Phase 65: the multi-select state for the queue UI.
 *
 * The queue screen has a multi-select mode where the user
 * taps multiple items and applies a batch operation
 * (remove / move-to-top). This store holds the selected
 * indices; the batch operations are exposed as actions.
 */
export interface PlayerQueueSelectionActions {
  setSelection: (indices: number[]) => void;
  clearSelection: () => void;
  removeSelected: () => number[];
  /**
   * Move all selected items to the top of the queue,
   * preserving the original order. Returns the indices
   * (relative to the queue BEFORE the move) that were moved.
   */
  moveSelectedToTop: () => number[];
}

export interface PlayerQueueSelectionStore
  extends PlayerQueueSelectionActions {
  selectedIndices: number[];
}

export const usePlayerQueueSelectionStore = create<PlayerQueueSelectionStore>()(
  (set, get) => ({
    selectedIndices: [],

    setSelection: (indices) => set({selectedIndices: indices}),
    clearSelection: () => set({selectedIndices: []}),

    /**
     * Read-side helper: returns the selected indices sorted
     * descending. The caller (consumer) uses this to splice
     * the actual queue array. Phase 65 doesn't move this
     * into the store because the queue itself lives in a
     * different store; we just expose the indices the
     * consumer needs.
     */
    removeSelected: () => {
      const sorted = [...get().selectedIndices].sort((a, b) => b - a);
      return sorted;
    },

    moveSelectedToTop: () => {
      const sorted = [...get().selectedIndices].sort((a, b) => a - b);
      return sorted;
    },
  }),
);
