/**
 * lib v1.17.0 — the "the file is OPENING" contract, and the error
 * payload's numeric code.
 *
 * ## Why these tests exist
 *
 * Both claims were false on a device, and neither was visible in the
 * test suite:
 *
 *  - A load over a throttled link took 9 seconds and showed NO loading
 *    indicator. mpv's core state is "playing" from the moment
 *    `loadfile` is called until the file has been parsed, and the
 *    playlist is not populated until the file arrives — so "playing" and
 *    "idle" were both wrong, and no consumer could tell "opening" from
 *    either. `isLoading` is the fact, and the lib owns it because the
 *    lib is the only layer that knows a load was requested.
 *
 *  - Every failure arrived with `code: NaN`. The native payload carried
 *    a STRING `code` ("E_RENDERER_GONE") where the contract declares
 *    `code: number`, so `Number("E_RENDERER_GONE")` was NaN — and the
 *    device log showed `numeric=0` for a real failure. The payload
 *    also arrived TWICE, the second emission overwriting the first.
 *
 * A test that cannot fail is not a test, so each claim below is pinned
 * by an assertion that a regression would break.
 */

import {applyPlayerEvent, DEFAULT_PROGRESS, DEFAULT_STATE} from '../player';

describe('v1.17.0 — isLoading: the file is OPENING', () => {
  it('is false in the default state (no load has been requested)', () => {
    expect(DEFAULT_STATE.isLoading).toBe(false);
  });

  it('is true the moment a load is requested', () => {
    const {state} = applyPlayerEvent(DEFAULT_STATE, DEFAULT_PROGRESS, 'onLoadRequested', {
      uri: 'https://example.test/movie.mp4',
    });
    expect(state.isLoading).toBe(true);
  });

  it('stays true for the whole opening window', () => {
    // Anything that happens while the file is opening must not clear
    // it — a position change or a duration change during the load is
    // not "the file arrived".
    const requested = applyPlayerEvent(DEFAULT_STATE, DEFAULT_PROGRESS, 'onLoadRequested', {
      uri: 'https://example.test/movie.mp4',
    });
    const positioned = applyPlayerEvent(requested.state, requested.progress, 'onPositionChanged', {
      position: 0,
    });
    expect(positioned.state.isLoading).toBe(true);
  });

  it('is false once the file arrives', () => {
    const requested = applyPlayerEvent(DEFAULT_STATE, DEFAULT_PROGRESS, 'onLoadRequested', {
      uri: 'https://example.test/movie.mp4',
    });
    const loaded = applyPlayerEvent(requested.state, requested.progress, 'onFileLoaded', {
      file: {title: 'A Movie', duration: 120},
    });
    expect(loaded.state.isLoading).toBe(false);
    expect(loaded.state.isPlaying).toBe(true);
  });

  it('is false when the file ends — ended, or failed', () => {
    // A load that FAILS never reaches onFileLoaded, so without this the
    // lib would be stuck reporting "opening" for the rest of the
    // session.
    const loading = {...DEFAULT_STATE, isLoading: true};
    const ended = applyPlayerEvent(loading, DEFAULT_PROGRESS, 'onEndFile', {reason: 3, error: 0});
    expect(ended.state.isLoading).toBe(false);
  });
});

describe('v1.17.0 — the onError payload carries a NUMERIC code', () => {
  it('keeps a numeric code and the readable name', () => {
    const {state} = applyPlayerEvent(DEFAULT_STATE, DEFAULT_PROGRESS, 'onError', {
      code: 3001,
      codeName: 'E_LOAD_FAILED',
      recoverable: false,
      message: 'failed to load',
    });
    expect(state.error).toEqual({
      code: 3001,
      codeName: 'E_LOAD_FAILED',
      recoverable: false,
      message: 'failed to load',
    });
  });

  it('never produces NaN when the payload carries a string code', () => {
    // This is the exact shape the native bridge used to emit, and
    // `Number("E_RENDERER_GONE")` is NaN. The claim is that a failure
    // must never reach the app with a NaN code.
    const {state} = applyPlayerEvent(DEFAULT_STATE, DEFAULT_PROGRESS, 'onError', {
      code: 'E_RENDERER_GONE',
      codeName: 'E_RENDERER_GONE',
      recoverable: false,
      message: 'renderer gone',
    });
    expect(state.error).not.toBeNull();
    expect(Number.isNaN(state.error?.code)).toBe(false);
    expect(state.error?.code).toBe(0);
    // The readable name survives, so the classifier still has something.
    expect(state.error?.codeName).toBe('E_RENDERER_GONE');
  });

  it('keeps the recoverable flag — it means "playback continued"', () => {
    // mpv's END_FILE path reports recoverable=false (the file failed);
    // a fatal-level mpv LOG line reports true (playback continued). A
    // consumer that shows a terminal error card must be able to tell
    // them apart.
    const terminal = applyPlayerEvent(DEFAULT_STATE, DEFAULT_PROGRESS, 'onError', {
      code: 3001,
      codeName: 'E_LOAD_FAILED',
      recoverable: false,
      message: 'failed',
    });
    expect(terminal.state.error?.recoverable).toBe(false);

    const degraded = applyPlayerEvent(DEFAULT_STATE, DEFAULT_PROGRESS, 'onError', {
      code: 3011,
      codeName: 'E_GENERIC',
      recoverable: true,
      message: 'AudioTrack Init failed',
    });
    expect(degraded.state.error?.recoverable).toBe(true);
  });

  it('does not let a non-terminal failure mask a terminal one', () => {
    // mpv can report a fatal-level LOG line AFTER the file has already
    // failed. The last error to arrive is not necessarily the one that
    // ended playback, so the terminal failure has to survive.
    const terminal = applyPlayerEvent(DEFAULT_STATE, DEFAULT_PROGRESS, 'onError', {
      code: 3001,
      codeName: 'E_LOAD_FAILED',
      recoverable: false,
      message: 'failed to load',
    });
    const after = applyPlayerEvent(terminal.state, terminal.progress, 'onError', {
      code: 3011,
      codeName: 'E_GENERIC',
      recoverable: true,
      message: 'AudioTrack Init failed',
    });
    expect(after.state.error?.code).toBe(3001);
    expect(after.state.error?.codeName).toBe('E_LOAD_FAILED');
    expect(after.state.error?.recoverable).toBe(false);
  });

  it('lets a NEWER terminal failure replace the previous one', () => {
    // A retry that fails again must report the new failure, not the
    // previous one — otherwise the card keeps showing a stale reason.
    const first = applyPlayerEvent(DEFAULT_STATE, DEFAULT_PROGRESS, 'onError', {
      code: 3001,
      codeName: 'E_LOAD_FAILED',
      recoverable: false,
      message: 'failed to load',
    });
    const second = applyPlayerEvent(first.state, first.progress, 'onError', {
      code: 3005,
      codeName: 'E_UNKNOWN_FORMAT',
      recoverable: false,
      message: 'unknown format',
    });
    expect(second.state.error?.code).toBe(3005);
    expect(second.state.error?.message).toBe('unknown format');
  });
});
