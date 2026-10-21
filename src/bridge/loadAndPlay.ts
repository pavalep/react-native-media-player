import {
  applyForceMediaTitle,
  applyStartPosition,
  type MpvPlayerModuleBridge,
} from './MpvPlayerModule';

/**
 * Feed a launch payload to mpv: title, file, resume position, play.
 *
 * This is the **load lifecycle**, extracted so that every entry point runs
 * the identical sequence. It used to live inline in `useLaunchPlayback`,
 * where it was unreachable from any other caller — which is why
 * `usePlayerActivity.openPlayer` grew its own separate `startActivity`
 * path instead of reusing it. Two implementations of "play this media"
 * is two orderings to keep in sync, and the one that drifts is the one
 * that leaves a file playing under the wrong title.
 *
 * ## The ordering is load-bearing
 *
 * 1. `force-media-title` is read by mpv **at load time**. Set after
 *    `loadFile`, it applies to the next file instead of this one, and the
 *    header shows a signed CDN token or a filename.
 * 2. The start position is written to mpv's `start` option **before** the
 *    load, and it is therefore part of the load — not a `seek` command
 *    issued after it. mpv refuses a seek until the file has opened (it
 *    accepts seeks only once playback is initialised), so `loadfile` +
 *    `seek` in the same tick dropped the seek on the floor and the resume
 *    silently played from 0:00. See `applyStartPosition` for the full
 *    reasoning and the mpv sources behind it.
 * 3. `play` last. A launch means "play this" — the way to ask for
 *    something paused is `pause()` afterwards, never a launch that
 *    silently loads and sits there.
 *
 * ## What this deliberately does NOT do
 *
 * It does not size, show, or position the video surface. Presentation has
 * exactly one owner (the consumer's surface controller), and a second
 * owner would be the same "two things resize the surface" defect that
 * produced the black-screen bugs this architecture was rebuilt to remove.
 * This function loads media; something else decides where it appears.
 *
 * It is also **lane-agnostic**: audio playback goes through this exact
 * path and has no surface at all. That is why the surface check lives in
 * `usePlayerActivity.openPlayer` (which knows it was asked for *video*)
 * rather than here.
 *
 * `startPositionMs` is authored in milliseconds because that is what
 * every launch payload carries; mpv's `start` option speaks seconds, mpv's
 * own unit. The conversion happens here so no caller can get it wrong.
 *
 * Synchronous by design: the underlying bridge methods are fire-and-forget
 * (`setProperty`, `loadFile`, `play` all return `void`). A load failure
 * is not observable at this layer at all — it surfaces through mpv's own
 * `file-loaded` / `end-file` events, which the consumer's state layer
 * already observes. Returning a Promise here would promise a resolution
 * that does not correspond to anything.
 */
export function loadAndPlay(
  bridge: MpvPlayerModuleBridge,
  payload: { uri: string; title?: string; startPositionMs?: number },
): void {
  const {uri, title, startPositionMs = 0} = payload;
  const startPositionSec = startPositionMs > 0 ? startPositionMs / 1000 : 0;

  applyForceMediaTitle(bridge, title);
  applyStartPosition(bridge, startPositionSec);
  bridge.loadFile(uri);
  bridge.play();
}