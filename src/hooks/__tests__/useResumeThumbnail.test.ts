/**
 * Unit tests for the public `captureFrame` wrapper
 * (`src/hooks/useResumeThumbnail.ts`).
 *
 * What is testable at the JS level is the wrapper's own contract,
 * not the extraction itself — the pixels come from
 * `MediaMetadataRetriever` on a native background thread and are
 * exercised on-device:
 *
 *  - `null` (never a rejection) is passed through for "no frame
 *    available" — the live stream / unsupported container /
 *    unreachable URL / past-the-end cases,
 *  - a resolved absolute path is passed through unchanged,
 *  - programmer error rejects with the documented `E_*` codes
 *    BEFORE any bridge call happens,
 *  - omitted options are filled in with the poster-sized defaults,
 *    and the options object is ALWAYS sent (the codegen'd TurboModule
 *    signature is positional, so an absent 3rd argument is an arity
 *    hazard rather than a clean null),
 *  - a partial options object only overrides what it names.
 *
 * The bridge itself is the global `NativeModules.MpvPlayerModule`
 * mock installed in `jest.setup.ts`; `getMpvPlayerModule()` returns
 * that instance because the mock satisfies `resolveBridge()`.
 */

import { NativeModules } from 'react-native';
import {
  captureFrame,
  DEFAULT_FRAME_WIDTH,
  DEFAULT_FRAME_HEIGHT,
  DEFAULT_FRAME_QUALITY,
} from '../useResumeThumbnail';

const nativeCaptureFrame = NativeModules.MpvPlayerModule
  .captureFrame as jest.Mock;

describe('captureFrame', () => {
  beforeEach(() => {
    nativeCaptureFrame.mockClear();
    nativeCaptureFrame.mockResolvedValue(null);
  });

  describe('the null contract', () => {
    it('resolves null without throwing when no frame is available', async () => {
      await expect(captureFrame('https://cdn.test/a.mkv', 42_000)).resolves.toBeNull();
    });

    it('does not reject — null is the documented fallback signal', async () => {
      // A rejection here would force every consumer into a try/catch
      // and would break the no-op bridge hosts (jest / web preview),
      // which resolve null rather than throw.
      const result = await captureFrame('file:///movies/a.mp4', 0).catch(
        (e: unknown) => `rejected: ${String(e)}`,
      );
      expect(result).toBeNull();
    });

    it('passes a resolved absolute path through unchanged', async () => {
      const path = '/data/user/0/com.simba/files/simba-resume-thumbs/frame_1_30000.jpg';
      nativeCaptureFrame.mockResolvedValue(path);
      await expect(captureFrame('file:///movies/a.mp4', 31_000)).resolves.toBe(path);
    });
  });

  describe('programmer errors', () => {
    it('rejects a blank uri with E_INVALID_URI and never touches the bridge', async () => {
      await expect(captureFrame('   ', 1000)).rejects.toMatchObject({
        code: 'E_INVALID_URI',
      });
      expect(nativeCaptureFrame).not.toHaveBeenCalled();
    });

    it('rejects a negative positionMs with E_INVALID_POSITION', async () => {
      await expect(captureFrame('file:///a.mp4', -1)).rejects.toMatchObject({
        code: 'E_INVALID_POSITION',
      });
      expect(nativeCaptureFrame).not.toHaveBeenCalled();
    });

    it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
      'rejects the non-finite positionMs %p',
      async (bad) => {
        await expect(captureFrame('file:///a.mp4', bad)).rejects.toMatchObject({
          code: 'E_INVALID_POSITION',
        });
      },
    );

    it('accepts positionMs === 0 (start of media is a valid frame)', async () => {
      await expect(captureFrame('file:///a.mp4', 0)).resolves.toBeNull();
      expect(nativeCaptureFrame).toHaveBeenCalledTimes(1);
    });
  });

  describe('options', () => {
    it('applies the poster-sized defaults when options are omitted', async () => {
      await captureFrame('file:///a.mp4', 5000);
      expect(nativeCaptureFrame).toHaveBeenCalledWith('file:///a.mp4', 5000, {
        width: DEFAULT_FRAME_WIDTH,
        height: DEFAULT_FRAME_HEIGHT,
        quality: DEFAULT_FRAME_QUALITY,
      });
    });

    it('always sends an options object, even when none were supplied', async () => {
      await captureFrame('file:///a.mp4', 5000);
      const args = nativeCaptureFrame.mock.calls[0] as unknown[];
      // The codegen'd TurboModule signature is
      // (uri, positionMs, options, promise) — a missing 3rd argument is
      // an arity mismatch on some RN versions, not a clean null.
      expect(args).toHaveLength(3);
      expect(args[2]).toEqual(expect.any(Object));
    });

    it('only overrides the fields the caller actually names', async () => {
      await captureFrame('file:///a.mp4', 5000, { height: 720 });
      expect(nativeCaptureFrame).toHaveBeenCalledWith('file:///a.mp4', 5000, {
        width: DEFAULT_FRAME_WIDTH,
        height: 720,
        quality: DEFAULT_FRAME_QUALITY,
      });
    });

    it('forwards an explicit width of 0 (the aspect-preserving escape hatch)', async () => {
      await captureFrame('file:///portrait.mp4', 5000, { width: 0 });
      expect(nativeCaptureFrame).toHaveBeenCalledWith(
        'file:///portrait.mp4',
        5000,
        expect.objectContaining({ width: 0 }),
      );
    });

    it('floors a fractional positionMs before crossing the bridge', async () => {
      await captureFrame('file:///a.mp4', 1234.99);
      expect(nativeCaptureFrame).toHaveBeenCalledWith(
        'file:///a.mp4',
        1234,
        expect.any(Object),
      );
    });
  });

  describe('the defaults themselves', () => {
    it('uses a 16:9 box and a sane JPEG quality', () => {
      // 640x360 is exactly 16:9, so landscape sources scale without
      // distortion; quality 80 keeps a rail-sized frame in the tens of
      // kB rather than the hundreds.
      expect(DEFAULT_FRAME_WIDTH / DEFAULT_FRAME_HEIGHT).toBeCloseTo(16 / 9, 5);
      expect(DEFAULT_FRAME_HEIGHT).toBe(360);
      expect(DEFAULT_FRAME_QUALITY).toBe(80);
    });
  });
});