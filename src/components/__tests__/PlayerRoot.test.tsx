/**
 * Unit tests for `src/components/PlayerRoot.tsx`.
 *
 * v2.0.0 (the app's register item 28) — **the library draws no chrome.**
 *
 * `DefaultControls` was removed, so `<PlayerRoot>` has no fallback: with
 * no `renderControls`, it renders the surface and NOTHING else. Before
 * 2.0.0 it fell back to a 564-line control bundle the library shipped,
 * which meant the library always had a chrome implementation a consumer
 * could end up using by accident.
 *
 * Test surface:
 *  - no `renderControls` → the surface, and no second child
 *  - `renderControls` → the consumer's controls, over the surface
 *  - the package does not export a default control bundle
 *
 * The first test is the "must not" test: it fails if a chrome fallback
 * ever comes back, because a fallback is a second child of the root.
 */

import React from 'react';
import { Text } from 'react-native';
import { render, screen } from '@testing-library/react-native';
import { PlayerRoot } from '../PlayerRoot';
import { PlayerProvider } from '../PlayerProvider';

describe('PlayerRoot', () => {
  it('renders the surface and nothing else when the consumer supplies no controls', async () => {
    await render(
      <PlayerProvider>
        <PlayerRoot />
      </PlayerProvider>,
    );

    const tree = screen.toJSON();
    expect(tree).not.toBeNull();

    // The host tree is a plain View tree, so the root is the tree's
    // root node. `children` is typed loosely on purpose: the
    // `test-renderer` version has changed this shape before.
    const root = tree as unknown as { type: string; children: unknown };
    expect(root.type).toBe('View');

    // Exactly ONE child: the surface. A chrome fallback would be a
    // second child, and this is what kills the mutation.
    const children = Array.isArray(root.children) ? root.children : [];
    expect(children).toHaveLength(1);
  });

  it('renders the controls the consumer supplied, over the surface', async () => {
    await render(
      <PlayerProvider renderControls={() => <Text>my controls</Text>}>
        <PlayerRoot />
      </PlayerProvider>,
    );

    expect(screen.getByText('my controls')).toBeTruthy();

    const tree = screen.toJSON();
    expect(tree).not.toBeNull();
    const root = tree as unknown as { children: unknown };
    const children = Array.isArray(root.children) ? root.children : [];
    expect(children).toHaveLength(2);
  });

  it('does not export a default control bundle', async () => {
    const lib = require('../../index') as Record<string, unknown>;
    expect(Object.keys(lib)).not.toContain('DefaultControls');
    expect(lib.DefaultControls).toBeUndefined();
  });
});
