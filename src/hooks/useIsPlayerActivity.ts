import { getMpvPlayerModule } from '../bridge/MpvPlayerModule';

/**
 * Synchronous, idempotent "is this React tree hosted by the player
 * activity?" predicate.
 *
 * ## Why this exists (V19 W6.0)
 *
 * A consumer that wants to render its OWN chrome over the native
 * video surface needs to know whether it is running in
 * `PlayerActivity` (the surface exists) or `MainActivity` (it does
 * not). Before this hook, the only public way to ask was
 * `useLaunchParams()`, which is the wrong tool:
 *
 *   1. **It is one-shot.** The native side keeps launch params as a
 *      single-shot queue; the first React consumer reads them and
 *      every later consumer sees `null`. A chrome component asking
 *      "am I the player activity?" would silently steal the payload
 *      from `<PlayerRoot />` and break the default player UI.
 *   2. **It is async.** `getLaunchParams()` crosses the bridge as a
 *      `Promise`, so the answer arrives one render late — a consumer
 *      using it as a mount gate flashes its own absence for a frame.
 *   3. **It conflates two questions.** "Are there launch params?" is
 *      not "am I the player host?" — a player activity with an empty
 *      queue answers `null` to the first and `true` to the second.
 *
 * This hook answers the second question directly, and that is the
 * one a chrome compositor actually needs.
 *
 * ## Why it is not a subscription
 *
 * `isCurrentActivityPlayer()` is a plain boolean the native side
 * flips in `PlayerActivity.onCreate` / `onDestroy`. Each activity
 * mounts its OWN React tree, so the value is fixed for the lifetime
 * of any given tree and is already correct on its first render. A
 * `useSyncExternalStore` subscription would be pure overhead: there
 * is no intermediate state to observe, because the transition tears
 * the tree down rather than re-rendering it.
 *
 * Consumers that genuinely need to react to the flip *without* a
 * teardown (e.g. handling PiP) should subscribe to the `onPip*`
 * player events instead.
 *
 * ## Compatibility
 *
 * If the bridge predates this method the hook reports `false` — the
 * conservative answer. `false` means "no player surface here", which
 * is what a jest/Storybook/web host wants; a consumer that mis-detects
 * would render a chrome overlay over a non-existent surface, so
 * failing closed is the safe direction.
 */
export function useIsPlayerActivity(): boolean {
  const bridge = getMpvPlayerModule();
  try {
    return bridge.isCurrentActivityPlayer();
  } catch {
    // Pre-1.7.0 bridge (method absent) or a non-RN host. Fail closed
    // — see the compatibility note above.
    return false;
  }
}
