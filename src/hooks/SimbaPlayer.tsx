import React from 'react';
import { PlayerProvider } from '../components/PlayerProvider';
import type { PlayerConfig } from '../types/config';
import { PlayerResumeProvider } from './useOpenWithResume';
import type { PlayerResumeLookup } from './useOpenWithResume';

/**
 * V13+ DX: the single-entry-point wrapper for the SIMBA player
 * module. This is the **only** component a consumer's app root
 * needs to integrate the module. It composes the three layers a
 * typical app needs:
 *
 *   1. `<PlayerProvider>` — the config + state context (Phase 51).
 *   2. `<PlayerResumeProvider>` — the bookmark-aware resume
 *      lookup used by `useOpenWithResume` (Phase 51/52 + DX).
 *
 * Without `<SimbaPlayer>`, the consumer would have to nest both
 * providers manually, which is verbose and error-prone for junior
 * developers. With `<SimbaPlayer>`, the entire integration is
 * **one import + one wrapper component**:
 *
 * @example
 * ```tsx
 * // App.tsx (the consumer's root)
 * import { SimbaPlayer } from '@simba-dev/react-native-media-player';
 *
 * export default function App() {
 *   const playerLookup = useBookmarkLookup();
 *   return (
 *     <SimbaPlayer
 *       config={{ theme: { accent: '#FFD700' } }}
 *       lookup={playerLookup}
 *     >
 *       <RootNavigator />
 *     </SimbaPlayer>
 *   );
 * }
 * ```
 *
 * The `lookup` prop is optional — pass it to enable
 * `useOpenWithResume`'s auto-resume behavior. If you only need
 * `usePlayerActivity().openPlayer(...)` (no resume lookup), you
 * can omit `lookup` and the inner `<PlayerResumeProvider>` is
 * still mounted but with a no-op lookup that always returns 0.
 *
 * **Junior-dev rule of thumb:** if your screen calls
 * `openPlayer({resumeId: item.id})`, you need a `lookup` here.
 * If you only call `openPlayer({uri, title, type})` without
 * `resumeId`, the `lookup` is optional.
 */
export interface SimbaPlayerProps {
  /**
   * Partial PlayerConfig. Every field is optional; missing
   * fields fall back to the defaults in `resolvePlayerConfig`.
   */
  config?: PlayerConfig;
  /**
   * Bookmark-aware resume lookup. If provided, the module's
   * `useOpenWithResume` hook will resolve `resumeId` arguments
   * to a `startPositionMs` via this function. If omitted,
   * `useOpenWithResume` is a no-op for resume (every call starts
   * from 0).
   */
  lookup?: PlayerResumeLookup;
  children: React.ReactNode;
}

/**
 * The one-line integration point. See `SimbaPlayerProps` for
 * usage.
 */
export function SimbaPlayer({
  config,
  lookup,
  children,
}: SimbaPlayerProps): React.ReactElement {
  return (
    <PlayerProvider config={config}>
      <PlayerResumeProvider lookup={lookup ?? noopLookup}>
        {children}
      </PlayerResumeProvider>
    </PlayerProvider>
  );
}

/**
 * No-op lookup used when the consumer doesn't pass a `lookup`
 * prop. Always returns `undefined` so `useOpenWithResume` falls
 * back to 0 (or the consumer-provided `startPositionMs`).
 */
const noopLookup: PlayerResumeLookup = {
  getResumePosition: () => undefined,
};
