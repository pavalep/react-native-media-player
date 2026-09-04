import {create} from 'zustand';

/**
 * V15 Phase 66: a 10-band equalizer state.
 *
 * `gains` is a fixed-length array of 10 numeric gains (one
 * per band, in dB). `enabled` toggles whether the equalizer
 * is active. The module's mpv-backed equalizer is the
 * authoritative sink for these values; the store is a UI
 * surface.
 */
export type EqualizerGains = [number, number, number, number, number, number, number, number, number, number];

export interface PlayerEqualizerStore {
  gains: EqualizerGains;
  enabled: boolean;
  /** Replace the gains array. Must be length 10; otherwise no-op. */
  setGains: (gains: number[]) => void;
  /** Toggle the equalizer on/off. */
  toggle: () => void;
}

const DEFAULT_GAINS: EqualizerGains = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

export const usePlayerEqualizerStore = create<PlayerEqualizerStore>()((set) => ({
  gains: DEFAULT_GAINS,
  enabled: false,

  setGains: (incoming) => {
    if (incoming.length !== 10) return;
    set({gains: incoming as EqualizerGains});
  },
  toggle: () => set(state => ({enabled: !state.enabled})),
}));
