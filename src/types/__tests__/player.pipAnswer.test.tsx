/**
 * The PiP command must RELAY the OS's answer.
 *
 * ## The defect
 *
 * The native `enterPip` returned `Unit` and swallowed every failure:
 *
 *   - no activity                    → silent `return`
 *   - SDK < N                        → silent `return`
 *   - `enterPictureInPictureMode` returned false → the boolean was DISCARDED
 *   - it threw                       → caught, logged, swallowed
 *
 * A REFUSED PiP request was therefore indistinguishable from a successful
 * one, at the JS boundary.
 *
 * That matters because of what the caller does with the request. The app
 * suppresses its fullscreen chrome when PiP is up, so a refused request
 * that went unreported left the app in "PiP" mode with no transport bar, no
 * top bar, and no way out — the same latch the unmount bug produced,
 * reached by a different road.
 *
 * `Activity.enterPictureInPictureMode(PictureInPictureParams)` returns the
 * OS's own answer, so the fix is to stop throwing it away.
 *
 * ## What this asserts
 *
 * The RESULT, not just that the bridge was called. A test that only checked
 * "enterPip was called" would pass with the old `void` contract and the
 * bug would survive — which is exactly the mistake the arity test
 * (`player.pipArity.test.tsx`) was written to avoid.
 */

import {NativeModules} from 'react-native';
import {renderHook} from '@testing-library/react-native';
import {usePlayer} from '../player';

function enterPipMock(): jest.Mock {
  return (NativeModules.MpvPlayerModule as unknown as Record<string, jest.Mock>)
    .enterPip;
}

describe('commands.enterPip — the native answer is relayed', () => {
  beforeEach(() => {
    enterPipMock().mockClear();
    // The shared setup mock answers `true` (a successful entry). Each
    // test that cares sets the answer it needs.
    enterPipMock().mockReturnValue(true);
  });

  it('returns true when the OS accepted the request', async () => {
    const {result} = await renderHook(() => usePlayer());

    expect(result.current.commands.enterPip()).toBe(true);
  });

  it('returns false when the OS REFUSED the request', async () => {
    // No activity, PiP not permitted, bad params — the native side now
    // answers `false` instead of swallowing the failure.
    enterPipMock().mockReturnValue(false);
    const {result} = await renderHook(() => usePlayer());

    expect(result.current.commands.enterPip()).toBe(false);
  });

  it('does not swallow a refusal — the result is the caller\'s only signal', async () => {
    enterPipMock().mockReturnValue(false);
    const {result} = await renderHook(() => usePlayer());

    const answer = result.current.commands.enterPip();

    // A falsy-but-present answer is what the caller branches on. A
    // `undefined` (the old `void` contract) is indistinguishable from
    // "the native module is missing", so the assertion is on `false`
    // specifically, not on falsiness.
    expect(answer).not.toBeUndefined();
    expect(answer).toBe(false);
  });

  it('still calls the bridge with TWO arguments while answering', async () => {
    const {result} = await renderHook(() => usePlayer());
    result.current.commands.enterPip('Chapter 3', '45 %');

    const enterPip = enterPipMock();
    expect(enterPip.mock.calls[0]).toHaveLength(2);
    expect(enterPip).toHaveBeenCalledWith('Chapter 3', '45 %');
  });
});
