/**
 * Unit tests for `useLaunchPlayback` (lib 1.8.0) and the `headless`
 * mode of `<SimbaPlayerRoot>`.
 *
 * ## Why these exist
 *
 * Before 1.8.0, the load lifecycle lived inside `<PlayerRoot>`'s
 * render body, and `<SimbaPlayerRoot>` mounted `<PlayerRoot>` *instead
 * of* its children whenever launch params were present. A consumer with
 * its own chrome therefore had its UI discarded exactly when playback
 * started, and the only way to get the load guarantee was to surrender
 * the UI.
 *
 * 1.8.0 splits the two: `useLaunchPlayback` owns the load, and
 * `headless` keeps it while `children` (the consumer's UI) renders
 * unconditionally.
 *
 * ## What these pin
 *
 *  - The payload is loaded EXACTLY ONCE per `(uri, startPositionMs)`.
 *    The old render-body version re-fired on every re-render, and
 *    `<PlayerProvider>` re-renders ~1 Hz off the position poll.
 *  - `startPositionMs` is authored in ms; mpv's `seekAbsolute` is in
 *    seconds. A silent unit error here seeks to the wrong place with no
 *    error anywhere.
 *  - `headless` still loads — that is the whole point of the flag.
 *  - A `null` payload is a no-op, not a `loadFile(null)`.
 */

import React from 'react';
import { NativeModules, Text } from 'react-native';
import { render, waitFor } from '@testing-library/react-native';
import { useLaunchPlayback } from '../useLaunchPlayback';
import { SimbaPlayerRoot } from '../SimbaPlayerRoot';
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

  it('converts startPositionMs from milliseconds to seconds', async () => {
    render(<Harness params={{...PARAMS, startPositionMs: 90_000}} />);
    await waitFor(() => expect(bridge().loadFile).toHaveBeenCalledTimes(1));
    expect(bridge().seekAbsolute).toHaveBeenCalledWith(90);
  });

  it('does not seek when the start position is 0', async () => {
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
});

describe('SimbaPlayerRoot — headless', () => {
  beforeEach(() => {
    clearBridgeMocks();
    bridge().isCurrentActivityPlayer.mockReturnValue(true);
    bridge().getLaunchParams.mockResolvedValue(PARAMS);
  });

  it('still loads the payload (that is the point of the flag)', async () => {
    // RNTL 14: `render` returns a Promise, so its queries must be
    // awaited off the resolved value — destructuring the Promise
    // itself yields `undefined` for every query.
    await render(
      <PlayerProvider>
        <SimbaPlayerRoot headless>
          <Text>consumer-chrome</Text>
        </SimbaPlayerRoot>
      </PlayerProvider>,
    );
    await waitFor(() => expect(bridge().loadFile).toHaveBeenCalledTimes(1));
    expect(bridge().loadFile).toHaveBeenCalledWith(PARAMS.uri);
  });

  it("renders the consumer's children even when launch params exist", async () => {
    // This is the regression 1.8.0 exists to fix: pre-1.8.0, params
    // present meant children were DISCARDED and <PlayerRoot /> took
    // over the screen.
    const {queryByText, getByText} = await render(
      <PlayerProvider>
        <SimbaPlayerRoot headless>
          <Text>consumer-chrome</Text>
        </SimbaPlayerRoot>
      </PlayerProvider>,
    );
    await waitFor(() => expect(getByText('consumer-chrome')).toBeTruthy());
    // The module's own default controls must NOT be on screen.
    expect(queryByText('Simba Player')).toBeNull();
  });

  it('renders children when there are no launch params', async () => {
    bridge().getLaunchParams.mockResolvedValue(null);
    const {getByText} = await render(
      <PlayerProvider>
        <SimbaPlayerRoot headless>
          <Text>consumer-chrome</Text>
        </SimbaPlayerRoot>
      </PlayerProvider>,
    );
    await waitFor(() => expect(getByText('consumer-chrome')).toBeTruthy());
    expect(bridge().loadFile).not.toHaveBeenCalled();
  });

  it('omitting headless keeps the pre-1.8.0 behaviour', async () => {
    // Back-compat guard: the default must still mount the module's own
    // player UI, discard children, AND — critically — still load
    // exactly ONCE. `<SimbaPlayerRoot>` and `<PlayerRoot>` both call
    // `useLaunchPlayback`; if both were active the media would load
    // twice per launch.
    const {queryByText} = await render(
      <PlayerProvider>
        <SimbaPlayerRoot>
          <Text>consumer-chrome</Text>
        </SimbaPlayerRoot>
      </PlayerProvider>,
    );
    await waitFor(() => expect(bridge().loadFile).toHaveBeenCalledTimes(1));
    expect(queryByText('consumer-chrome')).toBeNull();
  });
});
