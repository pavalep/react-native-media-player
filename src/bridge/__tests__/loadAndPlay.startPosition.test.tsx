/**
 * The resume contract: a launch that resumes must START at the saved
 * position, and the start position must be part of the LOAD.
 *
 * ## The defect this pins
 *
 * A resuming launch used to do `loadFile(uri)` and then
 * `seekAbsolute(seconds)`. mpv **refuses** a seek until the file has
 * actually opened — `cmd_seek` bails out with `cmd->success = false`
 * while `!mpctx->playback_initialized` (mpv `player/command.c`) — and
 * `playback_initialized` is only set once the file is open (mpv
 * `player/loadfile.c`, immediately before `MPV_EVENT_FILE_LOADED`).
 *
 * The native side discarded mpv's return code, so the refusal was
 * completely silent: the file played from 0:00, the transport bar
 * truthfully showed 0:00, and the resume simply did not happen. Measured
 * on device: `seekAbsolute position=1060.727` was logged and mpv never
 * emitted a `seek` event — while a manual scrub (a seek issued after the
 * file was open) landed exactly where it was aimed.
 *
 * The fix writes mpv's own `start` option BEFORE the load. mpv reads it
 * while the file opens, so the start position becomes part of the load
 * and cannot be dropped.
 *
 * ## What is pinned here
 *
 *  - the start position is written, in SECONDS, before the load;
 *  - the load does NOT issue a `seek` (that was the defect);
 *  - the start position is written on EVERY load, including `0` — mpv's
 *    `start` option is persistent, so skipping the write would carry the
 *    last resume position into the NEXT file;
 *  - a rejected write still loads and plays the file;
 *  - `onPlaybackRestart` does not zero the position — the position is
 *    owned by `time-pos` and by nothing else.
 */

import { NativeModules } from 'react-native';
import { loadAndPlay } from '../loadAndPlay';
import type { MpvPlayerModuleBridge } from '../MpvPlayerModule';
import {
  applyPlayerEvent,
  DEFAULT_PROGRESS,
  DEFAULT_STATE,
} from '../../types/player';

const bridge = () =>
  NativeModules.MpvPlayerModule as unknown as MpvPlayerModuleBridge & {
    setProperty: jest.Mock;
    loadFile: jest.Mock;
    play: jest.Mock;
    seekAbsolute: jest.Mock;
  };

function clearBridgeMocks() {
  for (const key of Object.keys(bridge())) {
    const fn = (bridge() as unknown as Record<string, unknown>)[key];
    if (typeof (fn as { mockClear?: () => void })?.mockClear === 'function') {
      (fn as { mockClear: () => void }).mockClear();
    }
  }
}

const URI = 'https://example.test/movie.mp4';

describe('loadAndPlay — the start position is part of the load', () => {
  beforeEach(() => {
    clearBridgeMocks();
  });

  it('writes the start position in SECONDS before the load', () => {
    // 90 000 ms is 90 s. A unit error here seeks to the wrong place with
    // no error anywhere.
    loadAndPlay(bridge(), {uri: URI, startPositionMs: 90_000});

    const order: string[] = [];
    bridge().setProperty.mockImplementation((name: string) => {
      order.push(`setProperty:${name}`);
    });
    bridge().loadFile.mockImplementation(() => {
      order.push('loadFile');
    });

    loadAndPlay(bridge(), {uri: URI, startPositionMs: 90_000});

    expect(bridge().setProperty).toHaveBeenCalledWith('options/start', '90.000');
    expect(order).toEqual(['setProperty:options/start', 'loadFile']);
  });

  it('does NOT issue a seek at load time — mpv refuses it', () => {
    // The defect: `loadFile` + `seekAbsolute` in the same tick. mpv
    // refuses the seek (playback is not initialised yet) and the refusal
    // is silent, so the resume plays from 0:00.
    loadAndPlay(bridge(), {uri: URI, startPositionMs: 90_000});
    expect(bridge().seekAbsolute).not.toHaveBeenCalled();
  });

  it('always writes the start position, so a resume cannot leak into the next file', () => {
    // mpv's `start` option is persistent. A plain load MUST write 0, or
    // the next file starts where the last one was resumed to.
    loadAndPlay(bridge(), {uri: URI});
    expect(bridge().setProperty).toHaveBeenCalledWith('options/start', '0.000');
  });

  it('writes 0 for a negative or non-finite start position', () => {
    loadAndPlay(bridge(), {uri: URI, startPositionMs: -5_000});
    expect(bridge().setProperty).toHaveBeenCalledWith('options/start', '0.000');

    clearBridgeMocks();
    loadAndPlay(bridge(), {uri: URI, startPositionMs: Number.NaN});
    expect(bridge().setProperty).toHaveBeenCalledWith('options/start', '0.000');
  });

  it('still loads and plays the file when the option write is rejected', () => {
    // A rejected option must never cost the user their video. mpv plays
    // the file from the beginning and the resume is simply not honoured.
    bridge().setProperty.mockImplementationOnce(() => {
      throw new Error('property rejected');
    });

    loadAndPlay(bridge(), {uri: URI, startPositionMs: 90_000});

    expect(bridge().loadFile).toHaveBeenCalledWith(URI);
    expect(bridge().play).toHaveBeenCalledTimes(1);
  });
});

describe('onPlaybackRestart does not own the position', () => {
  it('keeps the position it was given', () => {
    // mpv fires `playback-restart` when playback (re)starts — including
    // right after a seek. Zeroing the position there restarted the
    // transport bar's clock at 0:00 while the video sat at the position
    // the user had just seeked to (or resumed to).
    const progress = {...DEFAULT_PROGRESS, positionMs: 1_060_727};
    const state = {...DEFAULT_STATE, isPlaying: false, positionMs: 1_060_727};

    const next = applyPlayerEvent(state, progress, 'onPlaybackRestart', {});

    expect(next.progress.positionMs).toBe(1_060_727);
    expect(next.state.positionMs).toBe(1_060_727);
    expect(next.state.isPlaying).toBe(true);
  });
});
