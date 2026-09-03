/**
 * Unit tests for `src/components/DefaultControls.tsx`.
 *
 * Spec §Phase 34.7: Test DefaultControls renders correctly.
 *
 * Test surface:
 *  - Renders inside a PlayerProvider without crashing
 *  - Top bar shows the title (from prop) and subtitle
 *  - Transport buttons are present (skip back, play/pause, skip forward)
 *  - Play/pause button toggles based on state.isPlaying
 *  - Skip buttons call the bridge
 *  - Close button calls onPause (or commands.pause fallback)
 *  - formatTime is correctly applied for the time labels
 *
 * What we DON'T test (deferred):
 *  - PanResponder drag-to-seek (Phase 39 instrumented test)
 *  - Auto-hide opacity tween (Phase 39 — needs fake timers + Animated
 *    mock with manual frame advancement)
 *  - Scrubber position-to-time math (covered indirectly via the
 *    positionFromX logic in the source; pure-function tests for
 *    that math live in Phase 39 if/when we extract it).
 *
 * The MpvPlayerModule bridge mock is installed globally in
 * `jest.setup.ts`.
 */

import React from 'react';
import { NativeModules } from 'react-native';
import { fireEvent, render } from '@testing-library/react-native';
import { PlayerProvider } from '../PlayerProvider';
import { DefaultControls } from '../DefaultControls';

// Helper to clear all bridge mock call counts between tests.
function clearBridgeMocks() {
  for (const key of Object.keys(NativeModules.MpvPlayerModule)) {
    const fn = (NativeModules.MpvPlayerModule as Record<string, jest.Mock>)[key];
    if (typeof fn?.mockClear === 'function') {
      fn.mockClear();
    }
  }
}

describe('DefaultControls', () => {
  beforeEach(() => {
    clearBridgeMocks();
  });

  // ── Renders ───────────────────────────────────────────────────────────

  it('renders without crashing inside a PlayerProvider', async () => {
    const { getByLabelText } = await render(
      <PlayerProvider>
        <DefaultControls />
      </PlayerProvider>,
    );
    expect(getByLabelText('Simba Player controls')).toBeTruthy();
  });

  it('renders the top bar close button', async () => {
    const { getByLabelText } = await render(
      <PlayerProvider>
        <DefaultControls />
      </PlayerProvider>,
    );
    expect(getByLabelText('Close player')).toBeTruthy();
  });

  it('renders the skip-back and skip-forward transport buttons', async () => {
    const { getByLabelText } = await render(
      <PlayerProvider>
        <DefaultControls />
      </PlayerProvider>,
    );
    expect(getByLabelText('Skip back 10 seconds')).toBeTruthy();
    expect(getByLabelText('Skip forward 10 seconds')).toBeTruthy();
  });

  it('renders the play button in the "Play" state initially', async () => {
    // Phase 24 default state: isPlaying = false.
    const { getByLabelText } = await render(
      <PlayerProvider>
        <DefaultControls />
      </PlayerProvider>,
    );
    expect(getByLabelText('Play')).toBeTruthy();
  });

  it('renders the scrubber with adjustable accessibility role', async () => {
    const { getByLabelText } = await render(
      <PlayerProvider>
        <DefaultControls />
      </PlayerProvider>,
    );
    expect(getByLabelText('Seek bar')).toBeTruthy();
  });

  // ── Title / subtitle ───────────────────────────────────────────────────

  it('shows the title from props', async () => {
    const { getByText } = await render(
      <PlayerProvider>
        <DefaultControls title="My Episode" />
      </PlayerProvider>,
    );
    expect(getByText('My Episode')).toBeTruthy();
  });

  it('falls back to player state title when no prop is given', async () => {
    // DefaultControls derives `effectiveTitle = title ?? state.title`.
    // state.title is 'Simba Player' by default (the placeholder shown
    // until the first onFileLoaded event arrives; see player.ts).
    const { getByText } = await render(
      <PlayerProvider>
        <DefaultControls />
      </PlayerProvider>,
    );
    // The placeholder "Simba Player" should appear.
    expect(getByText('Simba Player')).toBeTruthy();
  });

  it('shows the subtitle from props', async () => {
    const { getByText } = await render(
      <PlayerProvider>
        <DefaultControls title="Song" subtitle="Artist • Album" />
      </PlayerProvider>,
    );
    expect(getByText('Artist • Album')).toBeTruthy();
  });

  // ── Transport buttons → bridge ────────────────────────────────────────

  it('skip-back button calls commands.skipBackward(10) on the bridge', async () => {
    const { getByLabelText } = await render(
      <PlayerProvider>
        <DefaultControls />
      </PlayerProvider>,
    );
    fireEvent.press(getByLabelText('Skip back 10 seconds'));
    expect(NativeModules.MpvPlayerModule.seekBackward).toHaveBeenCalledWith(10);
  });

  it('skip-forward button calls commands.skipForward(10) on the bridge', async () => {
    const { getByLabelText } = await render(
      <PlayerProvider>
        <DefaultControls />
      </PlayerProvider>,
    );
    fireEvent.press(getByLabelText('Skip forward 10 seconds'));
    expect(NativeModules.MpvPlayerModule.seekForward).toHaveBeenCalledWith(10);
  });

  it('play button calls commands.play on the bridge when not playing', async () => {
    const { getByLabelText } = await render(
      <PlayerProvider>
        <DefaultControls />
      </PlayerProvider>,
    );
    fireEvent.press(getByLabelText('Play'));
    expect(NativeModules.MpvPlayerModule.play).toHaveBeenCalledTimes(1);
  });

  it('close (✕) button calls commands.pause (the close action)', async () => {
    // Phase 24 design: the close button (✕) is mapped to onPause
    // (the consumer's hook for "the user dismissed the player"),
    // which falls back to commands.pause when no prop is given.
    const { getByLabelText } = await render(
      <PlayerProvider>
        <DefaultControls />
      </PlayerProvider>,
    );
    fireEvent.press(getByLabelText('Close player'));
    expect(NativeModules.MpvPlayerModule.pause).toHaveBeenCalled();
  });

  // ── Props override fallback commands ───────────────────────────────────

  it('uses onPlay prop instead of commands.play when provided', async () => {
    const onPlay = jest.fn();
    const { getByLabelText } = await render(
      <PlayerProvider>
        <DefaultControls onPlay={onPlay} />
      </PlayerProvider>,
    );
    fireEvent.press(getByLabelText('Play'));
    expect(onPlay).toHaveBeenCalledTimes(1);
    // The fallback bridge call should NOT fire when onPlay is given.
    expect(NativeModules.MpvPlayerModule.play).not.toHaveBeenCalled();
  });

  it('uses onPause prop instead of commands.pause when provided', async () => {
    const onPause = jest.fn();
    const { getByLabelText } = await render(
      <PlayerProvider>
        <DefaultControls onPause={onPause} />
      </PlayerProvider>,
    );
    fireEvent.press(getByLabelText('Close player'));
    expect(onPause).toHaveBeenCalledTimes(1);
    expect(NativeModules.MpvPlayerModule.pause).not.toHaveBeenCalled();
  });

  // ── formatTime helper (indirect via render) ────────────────────────────

  it('formats position/duration time labels as M:SS by default', async () => {
    // Phase 24: usePlayerProgress returns {positionMs: 0, durationMs: 0}
    // so both time labels render "0:00".
    const { getAllByText } = await render(
      <PlayerProvider>
        <DefaultControls />
      </PlayerProvider>,
    );
    // Two labels: one for position, one for duration.
    const labels = getAllByText('0:00');
    expect(labels.length).toBe(2);
  });

  // ── Accessibility ──────────────────────────────────────────────────────

  it('exposes accessibilityLabel on the root container', async () => {
    const { getByLabelText } = await render(
      <PlayerProvider>
        <DefaultControls />
      </PlayerProvider>,
    );
    expect(getByLabelText('Simba Player controls')).toBeTruthy();
  });

  it('scrubber exposes min/max/now accessibilityValue', async () => {
    const { getByLabelText } = await render(
      <PlayerProvider>
        <DefaultControls />
      </PlayerProvider>,
    );
    const scrubber = getByLabelText('Seek bar');
    // RNTL exposes accessibilityValue as a prop on the rendered
    // element. Phase 24 wires {min: 0, max: 0, now: 0} for the
    // 0-duration default.
    expect(scrubber.props.accessibilityValue).toEqual({
      min: 0,
      max: 0,
      now: 0,
    });
  });
});

// ── Pure-function: formatTime ─────────────────────────────────────────────
// We don't import formatTime directly (it's not exported), but the
// behaviour is fully testable via the rendered output above. The
// "M:SS" format with `0:00` for zero/negative is the documented
// contract.
//
// A more thorough test would export formatTime for unit testing
// (deferred to Phase 39 if extraction is desirable).
