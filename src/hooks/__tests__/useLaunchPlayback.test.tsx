/**
 * Unit tests for `useLaunchPlayback`.
 *
 * ## Why these exist
 *
 * Before 1.8.0, the load lifecycle lived inside `<PlayerRoot>`'s render
 * body, so every re-render fired another `loadFile` — and
 * `<PlayerProvider>` re-renders ~1 Hz off the position poll. The hook
 * exists to guarantee a payload is loaded exactly once.
 *
 * ## What these pin
 *
 *  - The payload is loaded EXACTLY ONCE per launch identity.
 *  - `startPositionMs` is authored in ms; mpv's `start` option is in
 *    seconds. A silent unit error here starts the file at the wrong place
 *    with no error anywhere.
 *  - A `null` payload is a no-op, not a `loadFile(null)`.
 *  - The title is applied BEFORE the load, because mpv reads
 *    `force-media-title` at load time.
 *
 * ## V21 F5
 *
 * This hook was one half of the two-Activity launch contract: the other
 * half was a one-shot native queue (`getLaunchParams`) that only the
 * deleted `PlayerActivity` ever filled. Both are gone, so this is now the
 * public in-window launch primitive — a consumer passes the payload and
 * the hook loads it into whatever surface it already has mounted.
 */

import React from 'react';
import { NativeModules, Text } from 'react-native';
import { render, waitFor } from '@testing-library/react-native';
import { useLaunchPlayback } from '../useLaunchPlayback';
import { PlayerProvider } from '../../components/PlayerProvider';
import type { LaunchParams } from '../../bridge/MpvPlayerModule';

const bridge = () =>
  NativeModules.MpvPlayerModule as unknown as Record<string, jest.Mock>;

function clearBridgeMocks() {
  for (const key of Object.keys(bridge())) {
    const fn = bridge()[key];
    if (typeof fn?.mockClear === 'function') fn.mockClear();
  }
}

const PARAMS: LaunchParams = {
  uri: 'https://example.test/movie.mp4',
  title: 'Movie',
  type: 'video',
  startPositionMs: 0,
};

describe('useLaunchPlayback', () => {
  beforeEach(() => {
    clearBridgeMocks();
  });

  function Harness({params}: {params: LaunchParams | null}) {
    useLaunchPlayback(params);
    return <Text>harness</Text>;
  }

  it('loads the URI and starts playback', async () => {
    render(<Harness params={PARAMS} />);
    await waitFor(() => expect(bridge().loadFile).toHaveBeenCalledTimes(1));
    expect(bridge().loadFile).toHaveBeenCalledWith(PARAMS.uri);
    expect(bridge().play).toHaveBeenCalledTimes(1);
  });

  it('does NOT re-fire when the payload object identity changes', async () => {
    // The 1 Hz position poll re-renders consumers constantly. A
    // fresh object literal for the same media must not reload.
    // RNTL 14: `render` is async, so `rerender` must be awaited off
    // the resolved value.
    const {rerender} = await render(<Harness params={{...PARAMS}} />);
    await waitFor(() => expect(bridge().loadFile).toHaveBeenCalledTimes(1));

    await rerender(<Harness params={{...PARAMS}} />);
    await rerender(<Harness params={{...PARAMS}} />);
    await waitFor(() => expect(bridge().loadFile).toHaveBeenCalledTimes(1));
  });

  it('loads again when the URI actually changes', async () => {
    const {rerender} = await render(<Harness params={PARAMS} />);
    await waitFor(() => expect(bridge().loadFile).toHaveBeenCalledTimes(1));

    await rerender(
      <Harness params={{...PARAMS, uri: 'https://example.test/next.mp4'}} />,
    );
    await waitFor(() => expect(bridge().loadFile).toHaveBeenCalledTimes(2));
    expect(bridge().loadFile).toHaveBeenLastCalledWith(
      'https://example.test/next.mp4',
    );
  });

  // ── requestId: re-launching the SAME media must load again ───────────
  //
  // `uri` + `startPositionMs` is not a unique identity for a launch. It was
  // sound only because every launch used to start a fresh `PlayerActivity` —
  // a new React root, so this hook mounted fresh and always fired.
  //
  // The moment playback is loaded into an already-open window, this hook
  // stays mounted across launches and that guarantee disappears. The
  // everyday action that breaks is "back out of a film, tap it again": same
  // URI, resume policy hands back the same position, same key, no load, and
  // the user presses play and nothing happens.

  it('loads again for the SAME uri and position when requestId differs', async () => {
    const {rerender} = await render(
      <Harness params={{...PARAMS, requestId: 'session-1'}} />,
    );
    await waitFor(() => expect(bridge().loadFile).toHaveBeenCalledTimes(1));

    await rerender(<Harness params={{...PARAMS, requestId: 'session-2'}} />);
    await waitFor(() => expect(bridge().loadFile).toHaveBeenCalledTimes(2));
  });

  it('does NOT re-fire when requestId is present but unchanged', async () => {
    // The 1 Hz position poll still re-renders consumers constantly; a new
    // object literal for the same launch must not reload.
    const {rerender} = await render(
      <Harness params={{...PARAMS, requestId: 'session-1'}} />,
    );
    await waitFor(() => expect(bridge().loadFile).toHaveBeenCalledTimes(1));

    await rerender(<Harness params={{...PARAMS, requestId: 'session-1'}} />);
    await rerender(<Harness params={{...PARAMS, requestId: 'session-1'}} />);
    await waitFor(() => expect(bridge().loadFile).toHaveBeenCalledTimes(1));
  });

  it('converts startPositionMs from milliseconds to seconds for mpv\'s start option', async () => {
    render(<Harness params={{...PARAMS, startPositionMs: 90_000}} />);
    await waitFor(() => expect(bridge().loadFile).toHaveBeenCalledTimes(1));
    expect(bridge().setProperty).toHaveBeenCalledWith('options/start', '90.000');
  });

  it('never seeks at load time — mpv refuses a seek before the file is open', async () => {
    // The defect this pins: `loadFile` + `seekAbsolute` in the same tick.
    // mpv refuses the seek (playback is not initialised yet) and the
    // refusal is silent, so the resume played from 0:00.
    render(<Harness params={PARAMS} />);
    await waitFor(() => expect(bridge().play).toHaveBeenCalledTimes(1));
    expect(bridge().seekAbsolute).not.toHaveBeenCalled();
  });

  it('is a no-op for a null payload', async () => {
    render(<Harness params={null} />);
    await waitFor(() => expect(bridge().loadFile).not.toHaveBeenCalled());
    expect(bridge().play).not.toHaveBeenCalled();
  });

  it('is a no-op for an undefined payload', async () => {
    render(<Harness params={undefined} />);
    await waitFor(() => expect(bridge().loadFile).not.toHaveBeenCalled());
  });

  // ── v1.9.3: the title the launch payload always carried ──────────────
  //
  // `LaunchParams.title` has always existed and has always come straight
  // from the host app's `openPlayer({uri, title})`. This hook — the ONE
  // place that actually loads the file — read `uri` and
  // `startPositionMs` and discarded it. With `media-title` also unobserved,
  // `PlayerState.title` stayed at the DEFAULT_STATE placeholder and every
  // player header rendered the literal string "Simba Player".
  //
  // This is the path the app actually takes (`openPlayer` → activity →
  // launch params → this hook), which is why it is the assertion that
  // matters, not just the one on `commands.loadFile`.

  it('applies the launch title as mpv force-media-title before loading', async () => {
    render(<Harness params={{...PARAMS, title: 'Overrun!'}} />);
    await waitFor(() => expect(bridge().loadFile).toHaveBeenCalledTimes(1));
    expect(bridge().setProperty).toHaveBeenCalledWith(
      'force-media-title',
      'Overrun!',
    );
  });

  it('sets the title BEFORE the load — mpv reads the option at load time', async () => {
    const order: string[] = [];
    bridge().setProperty.mockImplementation((name: string) => {
      order.push(`setProperty:${name}`);
    });
    bridge().loadFile.mockImplementation(() => {
      order.push('loadFile');
    });

    render(<Harness params={{...PARAMS, title: 'Overrun!'}} />);
    await waitFor(() => expect(bridge().loadFile).toHaveBeenCalledTimes(1));
    expect(order).toEqual([
      'setProperty:force-media-title',
      'setProperty:options/start',
      'loadFile',
    ]);
  });

  it('trims the launch title', async () => {
    render(<Harness params={{...PARAMS, title: '  Overrun!  '}} />);
    await waitFor(() => expect(bridge().loadFile).toHaveBeenCalledTimes(1));
    expect(bridge().setProperty).toHaveBeenCalledWith(
      'force-media-title',
      'Overrun!',
    );
  });

  it('omits the option when the title is blank — mpv keeps deriving its own', async () => {
    // Writing an empty `force-media-title` would BLANK the header, which
    // is worse than the derived fallback it replaced.
    render(<Harness params={{...PARAMS, title: '   '}} />);
    await waitFor(() => expect(bridge().loadFile).toHaveBeenCalledTimes(1));
    expect(bridge().setProperty).not.toHaveBeenCalledWith(
      'force-media-title',
      expect.anything(),
    );
  });

  it('still loads the file when the title write is rejected', async () => {
    // A rejected option must never cost the user their video.
    bridge().setProperty.mockImplementationOnce(() => {
      throw new Error('property rejected');
    });

    render(<Harness params={{...PARAMS, title: 'Overrun!'}} />);
    await waitFor(() => expect(bridge().loadFile).toHaveBeenCalledTimes(1));
    expect(bridge().play).toHaveBeenCalledTimes(1);
  });
});

describe('in-window launch (V21 F5)', () => {
  beforeEach(() => {
    clearBridgeMocks();
  });

  /**
   * The contract that replaced `<SimbaPlayerRoot headless>`.
   *
   * Video no longer starts an Activity, so a consumer drives the load
   * from its own tree and keeps its own UI. This pins the two halves of
   * the regression the `headless` flag used to guard: the module's own
   * player UI must NOT take over the screen, and the payload must load
   * exactly ONCE — two hook instances both firing would load the media
   * twice per launch.
   */
  function ConsumerChrome() {
    useLaunchPlayback(PARAMS);
    return <Text>consumer-chrome</Text>;
  }

  it('loads the payload exactly once and keeps the consumer UI', async () => {
    // RNTL 14: `render` returns a Promise, so its queries must be
    // awaited off the resolved value — destructuring the Promise
    // itself yields `undefined` for every query.
    const {queryByText, getByText} = await render(
      <PlayerProvider>
        <ConsumerChrome />
      </PlayerProvider>,
    );
    await waitFor(() => expect(bridge().loadFile).toHaveBeenCalledTimes(1));
    expect(bridge().loadFile).toHaveBeenCalledWith(PARAMS.uri);
    expect(getByText('consumer-chrome')).toBeTruthy();
    expect(queryByText('Simba Player')).toBeNull();
  });

  it('never reads the deleted one-shot launch-params queue', async () => {
    // V21 F5: `getLaunchParams` / `isCurrentActivityPlayer` no longer
    // exist. A consumer that mounted the module's root no longer had a
    // queue to consume, so it must not be consulted for anything.
    await render(
      <PlayerProvider>
        <ConsumerChrome />
      </PlayerProvider>,
    );
    await waitFor(() => expect(bridge().loadFile).toHaveBeenCalledTimes(1));
    expect(bridge().getLaunchParams).toBeUndefined();
    expect(bridge().isCurrentActivityPlayer).toBeUndefined();
  });
});
