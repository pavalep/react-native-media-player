import React from 'react';
import { StyleSheet, View } from 'react-native';

export interface PlayerSurfaceProps {
  /**
   * Background color for the placeholder. Defaults to `'transparent'`,
   * so whatever is behind it shows through to the user.
   *
   * **v2.0.0:** the native SurfaceView this placeholder used to stand
   * in for is gone — the picture is `<SimbaVideo />`, in the React
   * tree. A non-transparent value therefore paints a backdrop *over*
   * the picture wherever the placeholder sits in front of it.
   */
  backgroundColor?: string;
}

/**
 * A transparent, full-size **layout placeholder**.
 *
 * ## v2.0.0 — what this is, and is not
 *
 * This component used to stand in for the native SurfaceView that mpv
 * drew into. Back then the surface was a **sibling** of the React
 * root — pinned to `android.R.id.content` by the library's own
 * `PlayerActivity` — and this box reserved the screen rectangle the
 * controls overlay was positioned against.
 *
 * **That arrangement is gone.** The picture is now `<SimbaVideo />`:
 * a Fabric component (`SimbaVideoView`) inside the React tree, with
 * React Native owning its layout, its z-order and its lifecycle.
 * Neither the library nor a host app mounts a surface at the activity
 * root any more — a host app's Activity says so in as many words.
 *
 * What is left is a transparent `flex: 1` box: a full-size rectangle
 * for a controls overlay to anchor to. `<PlayerRoot>` renders it.
 *
 * Whether this component and `<PlayerRoot>` should exist at all is an
 * open question — see `B-035` in the app's master plan. Until that is
 * decided they stay: a published package cannot quietly drop a public
 * export.
 */
export function PlayerSurface({
  backgroundColor = 'transparent',
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
