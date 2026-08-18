/**
 * What a produced file *is*, as far as anything downstream is concerned.
 *
 * A workflow ending in `SaveVideo`, `SaveWEBM` or VHS's `Video Combine` leaves
 * an mp4 or a webm where a picture used to be, and almost every decision after
 * that point differs: it cannot be resized by the still-image renderer, it must
 * be streamed in ranges rather than sent whole, it plays rather than draws, and
 * it has no business being handed to an img2img graph.
 *
 * Decided by the file's own extension rather than by which key ComfyUI filed it
 * under. Node packs disagree about that key — core uses `images` even for a
 * video, VideoHelperSuite uses `gifs`, others `videos` — and the extension is
 * the one thing all of them are honest about.
 */
export type MediaKind = 'image' | 'video';

/** Containers a browser plays in a `<video>` element. */
const VIDEO_EXTENSIONS = new Set(['mp4', 'm4v', 'webm', 'mkv', 'mov', 'ogv', 'avi']);

/**
 * Moving pictures that are still *images* to a browser.
 *
 * A GIF from a video workflow animates inside an `<img>`; handing it to a
 * `<video>` element shows nothing at all. So it counts as a video for
 * everything about handling — no still-image resizing, no img2img — and as an
 * image for how it is put on screen. See `playsInVideoElement`.
 */
const ANIMATED_IMAGE_EXTENSIONS = new Set(['gif', 'apng']);

/** The extension, lowercased, without the dot. */
export function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  if (dot < 0 || dot === filename.length - 1) return '';
  return filename.slice(dot + 1).toLowerCase();
}

/** Whether this file moves, by name alone. */
export function mediaKindOf(filename: string): MediaKind {
  const extension = extensionOf(filename);
  return VIDEO_EXTENSIONS.has(extension) || ANIMATED_IMAGE_EXTENSIONS.has(extension)
    ? 'video'
    : 'image';
}

/** True for the containers that need a `<video>` element rather than an `<img>`. */
export function playsInVideoElement(filename: string): boolean {
  return VIDEO_EXTENSIONS.has(extensionOf(filename));
}

/**
 * A media kind from whatever the node told us, name first.
 *
 * VideoHelperSuite reports `format: 'video/h264-mp4'` beside the file, which is
 * the fallback for a container whose extension we do not recognise — a `.mkv`
 * from some custom saver is still a video even if this list has never heard of
 * it.
 */
export function mediaKindFor(filename: string, format?: string | null): MediaKind {
  if (mediaKindOf(filename) === 'video') return 'video';
  if (format && /^video\//i.test(format)) return 'video';
  return 'image';
}

/** The MIME type to serve a file as, by extension. */
export function contentTypeOf(filename: string): string {
  switch (extensionOf(filename)) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'webp':
      return 'image/webp';
    case 'gif':
      return 'image/gif';
    case 'apng':
      return 'image/apng';
    case 'mp4':
    case 'm4v':
      return 'video/mp4';
    case 'webm':
      return 'video/webm';
    case 'mkv':
      return 'video/x-matroska';
    case 'mov':
      return 'video/quicktime';
    case 'ogv':
      return 'video/ogg';
    case 'avi':
      return 'video/x-msvideo';
    case 'png':
    default:
      return 'image/png';
  }
}

/**
 * `1:07`, for a badge on a thumbnail.
 *
 * Seconds are what a short clip is measured in — a video workflow produces four
 * to ten of them — so under a minute this is `6s` rather than `0:06`, which
 * reads as a stopwatch nobody started.
 */
export function formatDuration(ms: number | null | undefined): string | null {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return null;
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/**
 * Node classes that end a graph in a moving picture.
 *
 * Used to tell, before anything has been rendered, that a workflow is a video
 * workflow — which is how the picker can say so and how the form knows that
 * "length" is a duration rather than one more number. Matched as prefixes
 * because node packs suffix their classes freely (`VHS_VideoCombine`,
 * `SaveWEBM`, `SaveVideo`, `CreateVideo`…).
 */
const VIDEO_OUTPUT_PATTERNS = [
  /^SaveVideo/i,
  /^SaveWEBM/i,
  /^SaveAnimated/i,
  /^CreateVideo/i,
  /^VHS_VideoCombine/i,
  /VideoCombine/i,
  /^SaveAnimatedWEBP/i,
];

export function isVideoOutputClass(classType: string): boolean {
  return VIDEO_OUTPUT_PATTERNS.some((pattern) => pattern.test(classType));
}

/** Whether a graph, as submitted, ends in a video rather than a picture. */
export function producesVideo(graph: Record<string, { class_type?: string }>): boolean {
  return Object.values(graph ?? {}).some((node) =>
    typeof node?.class_type === 'string' ? isVideoOutputClass(node.class_type) : false,
  );
}
