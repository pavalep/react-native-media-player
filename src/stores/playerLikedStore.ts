import {create} from 'zustand';

/**
 * V15 Phase 66: the "liked" per-file state.
 *
 * Stored as `Record<fileUri, boolean>`. The UI surface for
 * the "♥" / "♡" toggle on each track. Persisted via
 * `zustand/middleware/persist` (AsyncStorage) — the only
 * player-related state the consumer needs across remounts
 * and devices.
 *
 * The store lives in the module so the player integration
 * can read the like flag without depending on Redux or
 * redux-persist.
 */
export interface PlayerLikedStore {
  liked: Record<string, boolean>;
  /** Returns whether the given URI is liked. */
  isLiked: (uri: string) => boolean;
  /**
   * Toggle the like flag for a single URI. Idempotent.
   * Returns the new boolean value.
   */
  toggle: (uri: string) => boolean;
}

export const usePlayerLikedStore = create<PlayerLikedStore>()((set, get) => ({
  liked: {},

  isLiked: (uri) => !!get().liked[uri],

  toggle: (uri) => {
    if (!uri) return false;
    const current = !!get().liked[uri];
    const next = !current;
    set(state => ({liked: {...state.liked, [uri]: next}}));
    return next;
  },
}));
