import {useStore} from 'zustand';
import {usePlayerQueueSelectionStore} from '../stores/playerQueueSelectionStore';
import type {PlayerQueueSelectionStore} from '../stores/playerQueueSelectionStore';

/**
 * V15 Phase 65: the public hook for queue multi-select state.
 *
 * Returns the full selection store: `{selectedIndices, setSelection, clearSelection, removeSelected, moveSelectedToTop}`.
 *
 * @example
 * ```tsx
 * function QueueManagementSheet() {
 *   const {selectedIndices, setSelection, clearSelection} = useQueueSelection();
 *   // ... render multi-select UI
 * }
 * ```
 */
export function useQueueSelection<T = PlayerQueueSelectionStore>(
  selector?: (state: PlayerQueueSelectionStore) => T,
): T {
  if (selector) {
    return useStore(usePlayerQueueSelectionStore, selector);
  }
  return useStore(usePlayerQueueSelectionStore) as unknown as T;
}

/** Convenience hook: just the selected indices. */
export function useQueueSelectedIndices(): number[] {
  return useStore(usePlayerQueueSelectionStore, state => state.selectedIndices);
}

export type {PlayerQueueSelectionStore} from '../stores/playerQueueSelectionStore';
