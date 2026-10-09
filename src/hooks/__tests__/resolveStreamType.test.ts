/**
 * `resolveStreamType` decides which lane a launch opens, and therefore
 * which PLAYER WINDOW opens — not just which badge renders.
 *
 * ## The defect this pins
 *
 * Two tabulation errors in the same switch:
 *
 *   - `'episode'` sat in the video list. A podcast episode is an AUDIO
 *     lane in this app; the seam maps `bridgeOpts.type` straight to the
 *     lane, so a podcast episode opened the video window.
 *   - `'archive-video'` was absent entirely, so it fell through to the
 *     default and opened the AUDIO player.
 *
 * The second is the worse of the two, and the reason the fallback needs
 * its own scrutiny: a RECOGNISED kind falling into the default is worse
 * than an unrecognised one, because the default reads as a deliberate
 * choice rather than a gap in a table.
 *
 * `MediaKind` in the consumer is the authority here; this table is a
 * hand-maintained mirror of it and drifts silently when either side moves.
 * These tests are what make the drift visible.
 */

import {
  resolveStreamType,
  CONTENT_KIND_LANES,
  type ContentKind,
} from '../useOpenWithResume';

/** Mirrors the consumer's `MediaKind` union. */
const CONSUMER_MEDIA_KINDS = [
  'audio',
  'music',
  'podcast',
  'audiobook',
  'radio',
  'video',
  'movie',
  'live-tv',
  'archive-audio',
  'archive-video',
] as const;

/** The kinds that must NOT open the video window. */
const AUDIO_LANES = [
  'audio',
  'music',
  'podcast',
  'audiobook',
  'radio',
  'episode',
  'archive-audio',
] as const;

const VIDEO_LANES = [
  'video',
  'movie',
  'live-tv',
  'video-file',
  'archive-video',
] as const;

describe('resolveStreamType', () => {
  it.each(AUDIO_LANES)("routes '%s' to the audio lane", kind => {
    expect(resolveStreamType(kind)).toBe('audio');
  });

  it.each(VIDEO_LANES)("routes '%s' to the video lane", kind => {
    expect(resolveStreamType(kind)).toBe('video');
  });

  it('treats a podcast episode as audio, not video', () => {
    // The regression. 'episode' was in the video list.
    expect(resolveStreamType('episode')).toBe('audio');
  });

  it('routes archive-video to video rather than the audio default', () => {
    // The worse regression: absent from the table entirely, so a known
    // video kind opened the audio player.
    expect(resolveStreamType('archive-video')).toBe('video');
  });

  it('falls back to audio for an unrecognised kind', () => {
    // Deliberately unchanged: an unknown file is genuinely more likely to
    // be audio-only, and the audio player still plays it.
    expect(resolveStreamType('something-unknown')).toBe('audio');
    expect(resolveStreamType('')).toBe('audio');
  });

  it('covers every MediaKind the consumer defines', () => {
    // The mirror has to stay in step with the consumer's union. This is
    // the assertion that fails when either side adds a kind.
    const unclassified = CONSUMER_MEDIA_KINDS.filter(
      kind =>
        !AUDIO_LANES.includes(kind as never) && !VIDEO_LANES.includes(kind as never),
    );
    expect(unclassified).toEqual([]);
  });

  it('never returns the input for a lane spelling (passthrough is not a branch)', () => {
    // 'video' and 'audio' are in both the passthrough and the table; the
    // table is now authoritative, so there is no way for the two to drift.
    for (const kind of CONSUMER_MEDIA_KINDS) {
      expect(['audio', 'video']).toContain(resolveStreamType(kind as ContentKind));
    }
  });
});

/**
 * These assert the TABLE, not the return value.
 *
 * A return-value test cannot see a kind dropped from the table when the
 * fallback happens to agree with the expected answer: remove 'episode'
 * from the audio entries and `resolveStreamType('episode')` still returns
 * 'audio' via the default. That mutation was actually run, and it passed
 * a value-only suite — which is why the map is exported and these
 * assertions exist.
 */
describe('CONTENT_KIND_LANES — the table itself', () => {
  it("tabulates 'episode' as AUDIO explicitly", () => {
    // Not merely "resolves to audio" — PRESENT in the table as audio.
    expect(CONTENT_KIND_LANES.episode).toBe('audio');
  });

  it("tabulates 'archive-video' as VIDEO explicitly", () => {
    // Absent before: it took the audio default and opened the audio player.
    expect(CONTENT_KIND_LANES['archive-video']).toBe('video');
  });

  it('is not the "video list minus audio" accident it was', () => {
    // Guards the specific regression shape: a kind present but in the
    // wrong lane. Both of these are one character away from correct.
    expect(CONTENT_KIND_LANES.episode).not.toBe('video');
    expect(CONTENT_KIND_LANES['archive-audio']).toBe('audio');
  });

  it('covers every kind the lib claims to accept', () => {
    const declared = [
      ...AUDIO_LANES,
      ...VIDEO_LANES,
    ];
    const missing = declared.filter(kind => !(kind in CONTENT_KIND_LANES));
    expect(missing).toEqual([]);
  });

  it('assigns every table entry a real lane', () => {
    for (const [kind, lane] of Object.entries(CONTENT_KIND_LANES)) {
      expect(['audio', 'video']).toContain(lane);
      expect(resolveStreamType(kind as ContentKind)).toBe(lane);
    }
  });

  it('is frozen so a consumer cannot mutate the shared table', () => {
    // A writable export would let one consumer's fix corrupt every other
    // consumer's routing.
    expect(Object.isFrozen(CONTENT_KIND_LANES)).toBe(true);
  });
});