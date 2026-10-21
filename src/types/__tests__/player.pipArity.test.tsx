/**
 * The PiP command must call the native bridge with TWO arguments.
 *
 * The native TurboModule method has arity 2, and TurboModule checks the
 * argument count on EVERY call, so a zero-argument call is rejected
 * before it ever reaches the native body:
 *
 *   Exception in HostFunction: TurboModule method "enterPip"
 *   called with 0 arguments (expected argument count: 2)
 *
 * That is what the PiP button did: it threw instead of entering PiP.
 * The native side had already been made nullable (v1.9.3) and the
 * codegen spec had already been given two parameters — but the CALL
 * SITE still passed none, and nothing tested the call site's arity.
 *
 * So this file asserts the arity, not the behaviour: a test that only
 * checked "enterPip was called" would pass with a zero-argument call
 * and the bug would survive.
 */

import {NativeModules} from 'react-native';
import {renderHook} from '@testing-library/react-native';
import {usePlayer} from '../player';

function enterPipMock(): jest.Mock {
  return (NativeModules.MpvPlayerModule as unknown as Record<string, jest.Mock>)
    .enterPip;
}

describe('commands.enterPip — the native call arity', () => {
  beforeEach(() => {
    for (const key of Object.keys(NativeModules.MpvPlayerModule)) {
      const fn = (NativeModules.MpvPlayerModule as unknown as Record<
        string,
        jest.Mock
      >)[key];
      if (typeof fn?.mockClear === 'function') {
        fn.mockClear();
      }
    }
  });

  it('calls the bridge with TWO arguments even when no values are given', async () => {
    const {result} = await renderHook(() => usePlayer());
    result.current.commands.enterPip();

    const enterPip = enterPipMock();
    expect(enterPip).toHaveBeenCalledTimes(1);
    // The arity is the whole point: TurboModule rejects anything else.
    expect(enterPip.mock.calls[0]).toHaveLength(2);
    // And the "not supplied" value is null, which the native accepts
    // (its own fallbacks are "Simba Player" and "0 %").
    expect(enterPip.mock.calls[0][0]).toBeNull();
    expect(enterPip.mock.calls[0][1]).toBeNull();
  });

  it('forwards the chapter title and the progress percentage', async () => {
    const {result} = await renderHook(() => usePlayer());
    result.current.commands.enterPip('Chapter 3', '45 %');

    const enterPip = enterPipMock();
    expect(enterPip.mock.calls[0]).toHaveLength(2);
    expect(enterPip).toHaveBeenCalledWith('Chapter 3', '45 %');
  });

  it('passes null for a value that was not supplied, not undefined', async () => {
    const {result} = await renderHook(() => usePlayer());
    result.current.commands.enterPip('Chapter 3', null);

    const enterPip = enterPipMock();
    expect(enterPip.mock.calls[0]).toHaveLength(2);
    expect(enterPip).toHaveBeenCalledWith('Chapter 3', null);
  });
});
