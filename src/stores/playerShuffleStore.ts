import {create} from 'zustand';

/**
 * V15 Phase 66: the shuffle flag.
 *
 * A boolean. The V14-era consumer-side redux `state.player.shuffle`
 * is gone; consumers now read this flag via `useShuffle()` and
 * toggle it via `useShuffle().toggle()`.
 */
export interface PlayerShuffleStore {
  enabled: boolean;
  toggle: () => void;
}

export const usePlayerShuffleStore = create<PlayerShuffleStore>()((set) => ({
  enabled: false,
  toggle: () => set(state => ({enabled: !state.enabled})),
}));
