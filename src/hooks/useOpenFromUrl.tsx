import {useCallback} from 'react';
import {useOpenWithResume} from './useOpenWithResume';

/**
 * V14 Phase 60: the deep-link helper hook.
 *
 * Apps that handle "open with" / Android Share Sheet / cold-start
 * deep links all converge on the same boilerplate:
 *
 *   1. Listen for `Linking.addEventListener('url', ...)`.
 *   2. On cold start, also call `Linking.getInitialURL()`.
 *   3. Filter for the URI schemes the app handles (typically
 *      `content://` and `file://` for shared media files).
 *   4. Derive a display title from the URI basename.
 *   5. Classify the file as audio or video (typically by extension).
 *   6. Forward to the player via `openPlayer({uri, title, type, ...})`.
 *
 * Before V14, every consumer wrote this glue themselves. The shape
 * was always the same; only the title-derivation heuristic and
 * the extension lists varied.
 *
 * `useOpenFromUrl` absorbs steps 3–6. The consumer still owns step
 * 1 + 2 (the `Linking` plumbing), but those are 4 lines of React
 * boilerplate that any RN dev can write. The type-classification
 * + title-derivation + openPlayer forwarding is the actual glue.
 *
 * @example
 * ```tsx
 * const openFromUrl = useOpenFromUrl();
 *
 * useEffect(() => {
 *   Linking.getInitialURL().then(url => url && openFromUrl(url));
 *   const sub = Linking.addEventListener('url', ({url}) => openFromUrl(url));
 *   return () => sub.remove();
 * }, [openFromUrl]);
 * ```
 */

/**
 * Audio file extensions (lowercase, no dot). Conservative list —
 * any consumer with a custom format can pass a `classifyType` prop
 * (TODO if needed; not in V14 spec).
 */
const AUDIO_EXTENSIONS = new Set([
  'mp3',
  'm4a',
  'm4b',
  'aac',
  'flac',
  'ogg',
  'opus',
  'wav',
  'wma',
  'aiff',
  'alac',
  'mp2',
  'amr',
  'ac3',
  'oga',
]);

/**
 * Video file extensions (lowercase, no dot). Same conservatism
 * as `AUDIO_EXTENSIONS`.
 */
const VIDEO_EXTENSIONS = new Set([
  'mp4',
  'm4v',
  'mkv',
  'webm',
  'avi',
  'mov',
  'wmv',
  'flv',
  'ts',
  'm2ts',
  'mpg',
  'mpeg',
  'vob',
  'ogv',
  '3gp',
  '3g2',
  'f4v',
  'mp2p',
]);

/**
 * Pull the extension off a URI basename. Strips any query string
 * or fragment first (so `foo.MP3?token=abc` returns `mp3`). Returns
 * an empty string if the basename has no extension.
 */
function getExtension(uri: string): string {
  const clean = uri.split('?')[0].split('#')[0];
  // Take the last path segment. Use both / and \\ separators so
  // file:// URIs from Windows-style paths still work.
  const basename = clean.split(/[/\\]/).pop() || '';
  const dot = basename.lastIndexOf('.');
  return dot >= 0 ? basename.slice(dot + 1).toLowerCase() : '';
}

/**
 * Classify a media URI as 'audio' or 'video' by file extension.
 * Unknown extensions default to 'video' — matches the SIMBA
 * consumer's pre-V14 convention. (The video default is permissive:
 * if we guess wrong, the player handles both via mpv. Defaulting
 * to audio would silently hide the surface for a video file.)
 */
function classifyMediaType(uri: string): 'audio' | 'video' {
  const ext = getExtension(uri);
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  if (AUDIO_EXTENSIONS.has(ext)) return 'audio';
  return 'video';
}

/**
 * Derive a human-readable display name from a URI. Strips the
 * file extension, URL-decodes the basename, and falls back to
 * 'Shared File' if the URI has no usable path component.
 */
function deriveDisplayName(uri: string): string {
  const clean = uri.split('?')[0].split('#')[0];
  const fileName = clean.split('/').pop() || 'Shared File';
  const noExt = fileName.replace(/\.[^.]+$/, '');
  try {
    return decodeURIComponent(noExt) || 'Shared File';
  } catch {
    // Malformed URI — fall back to the raw basename.
    return noExt || 'Shared File';
  }
}

/**
 * V14 Phase 60: the deep-link helper hook.
 *
 * Returns a stable callback that takes a URI string and, if the
 * URI looks like a sharable media file (`content://` or `file://`),
 * opens it in the player with a derived title + classified type.
 * Returns `false` for URIs the hook ignores (empty / wrong scheme).
 *
 * The returned callback composes with the nearest
 * `<PlayerResumeProvider>` (set up by `<SimbaPlayer>` in the
 * consumer's App root): the URI is passed as `resumeId` so the
 * consumer's bookmark lookup runs. If the URI has a saved
 * bookmark, playback resumes from that position; otherwise the
 * file plays from the start.
 */
export function useOpenFromUrl(): (uri: string) => Promise<boolean> {
  const openPlayer = useOpenWithResume();
  return useCallback(
    async (uri: string): Promise<boolean> => {
      // Defensive: empty / non-sharable URIs are no-ops.
      if (!uri) return false;
      if (!uri.startsWith('content://') && !uri.startsWith('file://')) {
        return false;
      }

      const title = deriveDisplayName(uri);
      const type = classifyMediaType(uri);

      // Pass the URI as `resumeId` so the consumer's bookmark
      // lookup runs. Shared content:// URIs are not in the
      // bookmark slice, so the lookup typically returns 0 (start
      // from the beginning). But if the user previously saved a
      // bookmark for the same URI, playback resumes from there.
      return openPlayer({
        uri,
        title,
        type,
        resumeId: uri,
      });
    },
    [openPlayer],
  );
}
