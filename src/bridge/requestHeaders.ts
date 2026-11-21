/**
 * The JS->native encoding of a request-header map.
 *
 * WHY A JSON STRING
 * ---------------
 * The native side needs a header map, and the two lanes reach it by two
 * different routes: the video lane through a positional method argument,
 * the audio lane through the options object `startAudioPlayback` already
 * takes. A JSON string is the one shape that fits both without either side
 * having to agree on a bespoke wire format, and it is the same shape the
 * native side already speaks everywhere else in this module (the file info,
 * the video params and the playlist are all JSON strings).
 *
 * The values are UNTRUSTED: they come from a playlist a third party
 * publishes. The native side drops the control characters next to the
 * sink, and this side drops the entries that carry nothing.
 */
export function encodeRequestHeaders(
  headers?: Record<string, string>,
): string | undefined {
  if (!headers) return undefined;
  const out: Record<string, string> = {};
  for (const name of Object.keys(headers)) {
    const value = headers[name];
    if (typeof value !== 'string' || value.length === 0) continue;
    if (!name) continue;
    out[name] = value;
  }
  const names = Object.keys(out);
  if (names.length === 0) return undefined;
  return JSON.stringify(out);
}
