/**
 * Contract tests for `<SimbaVideo>`.
 *
 * These pin the promise the component makes to a consumer: it is an ordinary
 * React Native view that React Native lays out, and every prop on it either
 * reaches the native view or has a stated default.
 *
 * The native component is mocked as a host element ('SimbaVideoView') and
 * located by testID. RNTL 14 has no `getByType` - only semantic queries - and
 * a testID lookup that succeeds is itself the proof that matters: the view is
 * reachable *through the React tree*. That is the whole regression this
 * component exists to fix. The old picture was mounted by Kotlin at
 * `android.R.id.content`, a sibling of the React root, so no React query could
 * ever have found it.
 */
import React from 'react';
import { render, screen } from '@testing-library/react-native';

import { SimbaVideo, type SimbaVideoProps } from '../SimbaVideo';

jest.mock('../../specs/SimbaVideoViewNativeComponent', () => ({
  __esModule: true,
  default: 'SimbaVideoView',
}));

const TEST_ID = 'native-video';

// `jest.setup.ts` already installs `getNativePtr: fn(() => 0)` on
// NativeModules.MpvPlayerModule.
const bridge = () =>
  require('react-native').NativeModules.MpvPlayerModule as {
    getNativePtr: jest.Mock;
  };

/** Render and return the props that actually cross into the native view. */
async function renderNative(
  props: Partial<SimbaVideoProps> = {},
): Promise<Record<string, unknown>> {
  await render(<SimbaVideo testID={TEST_ID} {...props} />);
  return screen.getByTestId(TEST_ID).props as Record<string, unknown>;
}

describe('SimbaVideo', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    bridge().getNativePtr.mockReturnValue(0);
  });

  it('renders a real native view reachable through the React tree', async () => {
    // If this test needs changing, the surface is no longer in the tree.
    await render(<SimbaVideo testID={TEST_ID} />);

    expect(screen.getByTestId(TEST_ID)).toBeTruthy();
  });

  describe('nativePtr', () => {
    it('resolves the handle from the bridge when the prop is absent', async () => {
      bridge().getNativePtr.mockReturnValue(4242);

      const p = await renderNative();

      expect(p.nativePtr).toBe(4242);
    });

    it('prefers an explicit prop and does not consult the bridge', async () => {
      // An app managing more than one engine passes its own handle. Silently
      // preferring the singleton would bind the wrong engine with no error.
      const p = await renderNative({ nativePtr: 99 });

      expect(p.nativePtr).toBe(99);
      expect(bridge().getNativePtr).not.toHaveBeenCalled();
    });

    it('passes the handle through unrounded', async () => {
      // mpv handles are 64-bit. An Int32 round-trip would hand mpv a pointer
      // to nothing, and the symptom would be "video never appears" rather
      // than a type error.
      const big = 9007199254740991; // > Number.MAX_SAFE_INTEGER
      const p = await renderNative({ nativePtr: big });

      expect(p.nativePtr).toBe(big);
    });
  });

  describe('resizeMode maps onto mpv video-zoom', () => {
    it('contain is the default and maps to 0 (fit, letterboxed)', async () => {
      expect((await renderNative()).resizeMode).toBe('0');
    });

    it('contain → 0 when asked for explicitly', async () => {
      expect((await renderNative({ resizeMode: 'contain' })).resizeMode).toBe('0');
    });

    it('cover → 1 (fill, cropping, aspect preserved)', async () => {
      expect((await renderNative({ resizeMode: 'cover' })).resizeMode).toBe('1');
    });

    it('stretch → 2 (fill, aspect ignored)', async () => {
      expect((await renderNative({ resizeMode: 'stretch' })).resizeMode).toBe('2');
    });

    it('falls back to fit for an unrecognised mode', async () => {
      // mpv would reject an unknown video-zoom value; a wrong-but-valid
      // letterbox is recoverable, a rejected property is not.
      const p = await renderNative({ resizeMode: 'bogus' as never });
      expect(p.resizeMode).toBe('0');
    });
  });

  describe('defaults', () => {
    it('applies stated defaults for every prop that reaches native', async () => {
      // A native view defaulting to "unset" while Kotlin defaults to
      // something else is how a prop ends up looking accepted while doing
      // nothing.
      const p = await renderNative();

      expect(p.paused).toBe(false);
      expect(p.muted).toBe(false);
      expect(p.volume).toBe(100);
    });

    it('honours explicit values over defaults', async () => {
      const p = await renderNative({ paused: true, muted: true, volume: 35 });

      expect(p.paused).toBe(true);
      expect(p.muted).toBe(true);
      expect(p.volume).toBe(35);
    });
  });

  describe('layout', () => {
    it('carries a full-bleed default style', async () => {
      // A caller who forgets a style must not get a zero-height surface.
      // That renders no frames and reports no error anywhere - the exact
      // failure this project keeps having to chase.
      const style = (await renderNative()).style as Array<
        Record<string, unknown>
      >;

      expect(style[0]).toMatchObject({
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
      });
    });

    it('lets the caller override the default style', async () => {
      const style = (await renderNative({ style: { flex: 1 } }))
        .style as Array<Record<string, unknown>>;

      expect(style[1]).toEqual({ flex: 1 });
    });
  });

  it('forwards unknown props through to the native view', async () => {
    await render(
      <SimbaVideo testID={TEST_ID} accessibilityLabel="Video" />,
    );

    expect(screen.getByTestId(TEST_ID).props.accessibilityLabel).toBe('Video');
  });
});