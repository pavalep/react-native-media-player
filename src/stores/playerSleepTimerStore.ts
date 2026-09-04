import {create} from 'zustand';

/**
 * V15 Phase 66: the sleep-timer state.
 *
 * `endTime` is a Unix timestamp in ms; the UI can compare it
 * to `Date.now()` to render a countdown. `null` means the
 * timer is disarmed.
 *
 * `mode` selects the expiry trigger:
 *   - `'time'`: countdown fires at `endTime`
 *   - `'track'`: fires at the next track boundary
 *   - `'chapter'`: fires at the next chapter boundary
 */
export type SleepTimerMode = 'time' | 'track' | 'chapter';

export interface PlayerSleepTimerStore {
  endTime: number | null;
  mode: SleepTimerMode;
  /**
   * Arm a countdown timer that fires after `seconds` from now.
   * Always sets `mode` to 'time'. Pass `null` to disarm.
   */
  setTimer: (seconds: number | null) => void;
  /**
   * Set the trigger mode. Mode-based expiry replaces any
   * countdown timer (clears `endTime`).
   */
  setMode: (mode: SleepTimerMode) => void;
  /** Disarm the timer. */
  clear: () => void;
}

export const usePlayerSleepTimerStore = create<PlayerSleepTimerStore>()((set) => ({
  endTime: null,
  mode: 'time',

  setTimer: (seconds) =>
    set(() => ({
      endTime: seconds !== null ? Date.now() + seconds * 1000 : null,
      mode: 'time',
    })),
  setMode: (mode) => set({mode, endTime: null}),
  clear: () => set({endTime: null}),
}));
