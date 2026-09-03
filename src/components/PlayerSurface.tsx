import React from 'react';
import { StyleSheet, View } from 'react-native';

export interface PlayerSurfaceProps {
  /**
   * Background color for the placeholder. Defaults to `#000000` to
   * match mpv's initial clear colour (the SurfaceView is black
   * before the first frame is rendered). Consumers that want the
   * placeholder to blend with their theme can override this — the
   * actual video frames will paint over it once mpv's first frame
   * is decoded.
   */
  backgroundColor?: string;
}

/**
 * Phase 25: no-op JS placeholder for the natively-rendered
 * SurfaceView. The actual SurfaceView that mpv draws into lives on
 * the Kotlin side of PlayerActivity (`MpvRenderView` in the module
 * + `PlayerActivity.onCreate`'s `setContentView`). This JS
 * component exists only to reserve layout space in the React tree
 * so the controls overlay knows where to anchor.
 *
 * Why a placeholder rather than a real view:
 *  - The native SurfaceView is attached to the activity's
 *    `android.R.id.content` FrameLayout directly (see Phase 4). It
 *    is NOT a child of the React root view, so it doesn't need a
 *    JS counterpart.
 *  - The placeholder fills the same screen rectangle as the native
 *    SurfaceView because PlayerActivity pins the React root to the
 *    same insets the SurfaceView occupies (Phase 15 — full-screen
 *    with status / nav bar handling).
 *  - Adding `position: 'absolute'` here would force the controls
 *    sibling to also be absolutely positioned. Using `flex: 1`
 *    keeps the React tree in normal flow; the controls are placed
 *    as a sibling with absolute positioning by `PlayerRoot`.
 *
 * Consumers don't usually render this directly — `PlayerRoot`
 * (Phase 23) renders it automatically. The export is exposed so
 * consumers who pass a fully custom `renderControls` to
 * `<PlayerProvider>` can still include `<PlayerSurface />` in their
 * tree when they want the placeholder visible (e.g. for theming
 * tests).
 *
 * Surface is rendered natively by PlayerActivity.
 */
export function PlayerSurface({
  backgroundColor = '#000000',
}: PlayerSurfaceProps): React.ReactElement {
  return (
    <View
      style={[styles.surface, { backgroundColor }]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      // Collapses any accessibility tree contribution from this
      // placeholder; the SurfaceView on the native side is already
      // hidden from a11y (Phase 4 sets `importantForAccessibility`
      // to `no` on the MpvRenderView).
    />
  );
}

const styles = StyleSheet.create({
  surface: {
    flex: 1,
  },
});
