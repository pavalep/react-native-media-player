import {useStore} from 'zustand';
import {usePlayerQueueSelectionStore} from '../stores/playerQueueSelectionStore';
import type {PlayerQueueSelectionStore} from '../stores/playerQueueSelectionStore';

/**
 * V15 Phase 65 (V16 Phase 69 hardened): the public hook for queue
 * multi-select state.
 *
 * Two overloads:
 * - `useQueueSelection()` returns the full store
 *   `{selectedIndices, setSelection, clearSelection, removeSelected, moveSelectedToTop}`.
 * - `useQueueSelection(selector)` returns the selected slice.
 *
 * @example
 * ```tsx
 * function QueueManagementSheet() {
 *   const {selectedIndices, setSelection, clearSelection} = useQueueSelection();
 *   // ... render multi-select UI
 * }
 * ```
 */
export function useQueueSelection(): PlayerQueueSelectionStore;
export function useQueueSelection<T>(
  selector: (state: PlayerQueueSelectionStore) => T,
): T;
export function useQueueSelection<T>(
  selector?: (state: PlayerQueueSelectionStore) => T,
): PlayerQueueSelectionStore | T {
  if (selector) {
    return useStore(usePlayerQueueSelectionStore, selector);
  }
  return useStore(usePlayerQueueSelectionStore);
}

/** Convenience hook: just the selected indices. */
export function useQueueSelectedIndices(): number[] {
  return useStore(usePlayerQueueSelectionStore, state => state.selectedIndices);
}

export type {PlayerQueueSelectionStore} from '../stores/playerQueueSelectionStore';
