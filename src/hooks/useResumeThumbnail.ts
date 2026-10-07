import {
  getMpvPlayerModule,
  type CaptureFrameOptions,
} from '../bridge/MpvPlayerModule';

/**
 * Default output geometry for [captureFrame].
 *
 * These are the values the NATIVE side substitutes when a field is
 * omitted (`MpvBridgeModule.kt`, `DEFAULT_FRAME_WIDTH` /
 * `DEFAULT_FRAME_HEIGHT` / `DEFAULT_FRAME_QUALITY`). They are
 * mirrored here so a consumer can display or assert on them without
 * hardcoding the same literals twice — if you change one, change
 * both.
 *
 * Why 640×360:
 *  - It is exactly 16:9, so the common case (film / TV / YouTube
 *    landscape video) is scaled without any aspect distortion.
 *  - 360 px tall is ~2.5× a 144 dp rail card at xxhdpi, so the
 *    JPEG stays crisp when the rail is scaled or cached by the
 *    image loader, without paying for full-HD frames.
 *  - ~230 kpx ≈ 25–40 kB at quality 80. A 50-item resume rail is
 *    ~2 MB on disk, which is why this is cheap enough to keep
 *    writing instead of evicting.
 *
 * Portrait (9:16) sources: pass `width: 0` to leave the width
 * unconstrained and let the platform keep the source aspect ratio,
 * rather than squashing the frame into a 16:9 box.
 */
export const DEFAULT_FRAME_WIDTH = 640;
export const DEFAULT_FRAME_HEIGHT = 360;
export const DEFAULT_FRAME_QUALITY = 80;

/**
 * Re-exported so a consumer only needs one import:
 *
 * ```ts
 * import {captureFrame, type CaptureFrameOptions} from '@simba-dev/react-native-media-player';
 * ```
 */
export type {CaptureFrameOptions};

/**
 * Error codes the wrapper and the native bridge both use. Kept in
 * sync with `MpvBridgeModule.captureFrame`'s `promise.reject`
 * calls — these are programmer errors, not media errors.
 */
const E_INVALID_URI = 'E_INVALID_URI';
const E_INVALID_POSITION = 'E_INVALID_POSITION';

/**
 * Extract a single video frame at `positionMs` and resolve the
 * absolute path of the JPEG written for it.
 *
 * ## What it is for
 *
 * The "frame at the position you left off" thumbnail — Continue
 * Watching rails, resume cards, scrub previews. It is deliberately
 * NOT built on the module's existing `captureThumbnail(uri)`:
 * that one only uses the URI to hash a filename and grabs whatever
 * mpv is displaying *right now*, so it needs an initialised player,
 * a loaded file, and it cannot target a position at all.
 * [captureFrame] needs none of that.
 *
 * ## Why it works without a player
 *
 * Natively this is
 * `MediaMetadataRetriever.getScaledFrameAtTime(timeUs, option,
 * dstWidth, dstHeight)` — Android's standard "make a thumbnail from
 * a data source" API. It opens the source itself (local path,
 * `file://`, or `http(s)` via range requests), so no decoder
 * instance, no playback, and no surface is involved. All the work
 * happens on a native background executor, never on the JS or UI
 * thread.
 *
 * ## `null` is a normal answer, not a failure
 *
 * The promise resolves `null` — it does NOT reject — for every
 * "there is no frame here" case: a live stream, an unsupported
 * container, an unreachable URL, a position past the end of the
 * file. That is the documented signal for "no thumbnail, fall back
 * to poster art", so a consumer can render a placeholder without a
 * `try`/`catch` and without a blank `<Image>`.
 *
 * Rejection is reserved for programmer error:
 *  - `E_INVALID_URI` — blank/whitespace-only `uri`
 *  - `E_INVALID_POSITION` — `positionMs` is `NaN`, `±Infinity`, or
 *    negative
 *
 * Both are checked here in JS before the bridge call (so the
 * contract also holds on a jest / Storybook / web host, where the
 * bridge is the no-op fallback) and again natively (so a caller
 * going straight at the bridge gets the same codes).
 *
 * ## Caching / output
 *
 * The JPEG lands in the app's **files** dir under
 * `simba-resume-thumbs/`, named from a hash of the URI plus the
 * position bucketed to 30 s. The URI is never used verbatim, so
 * `?`, `/` and `%` in a signed URL cannot break the path; the bucket
 * means repeated calls for "roughly where the user stopped"
 * overwrite one file instead of accumulating a new one.
 *
 * `filesDir` (not the cache dir) is deliberate: a cache-dir
 * thumbnail can be evicted at any moment, which would silently
 * blank a rail cell on the next cold start.
 *
 * @param uri `file://`, an absolute path, a `content://` URI, or an
 *   `http(s)` URL.
 * @param positionMs Position to grab, in milliseconds from the
 *   start of the media.
 * @param options Output geometry / JPEG quality. Every field is
 *   optional; omitted fields use the defaults above.
 * @returns Absolute path to the written JPEG, or `null` when no
 *   frame could be produced.
 *
 * @example
 * ```ts
 * const path = await captureFrame(episode.uri, resumePositionMs);
 * return path !== null ? {uri: `file://${path}`} : {uri: episode.poster};
 * ```
 */
export async function captureFrame(
  uri: string,
  positionMs: number,
  options?: CaptureFrameOptions,
): Promise<string | null> {
  if (typeof uri !== 'string' || uri.trim().length === 0) {
    throw Object.assign(new Error('captureFrame: uri must be a non-empty string'), {
      code: E_INVALID_URI,
    });
  }
  if (!Number.isFinite(positionMs) || positionMs < 0) {
    throw Object.assign(
      new Error(
        `captureFrame: positionMs must be a finite, non-negative number (got ${String(positionMs)})`,
      ),
      {code: E_INVALID_POSITION},
    );
  }

  const bridge = getMpvPlayerModule();
  // The options object is always sent, never omitted: the codegen'd
  // TurboModule signature is `(uri, positionMs, options, promise)`,
  // so an absent third argument is an arity mismatch on some RN
  // versions rather than a clean `null`. An empty object is free and
  // lets the native side apply the defaults.
  return bridge.captureFrame(uri, Math.floor(positionMs), {
    width: options?.width ?? DEFAULT_FRAME_WIDTH,
    height: options?.height ?? DEFAULT_FRAME_HEIGHT,
    quality: options?.quality ?? DEFAULT_FRAME_QUALITY,
  });
}