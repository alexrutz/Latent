import type { GenerationImage } from '@latent/shared';

import { api } from '../api/client';

/**
 * A still for a video, taken by the only thing here that can decode one.
 *
 * The server has no ffmpeg and no business having one — Latent runs beside
 * ComfyUI, not instead of it — so a rendered clip would have no thumbnail at
 * all, and every gallery tile showing one would have to load the clip itself to
 * show anything. The browser is already decoding the video in order to play it,
 * so the frame it is showing is free: grab it, send it once, and from then on
 * the video has a still like every other output.
 *
 * Deliberately fire-and-forget, exactly like the dimension reporting beside it:
 * this is an optimisation for the *next* visit, and a failure must never
 * surface as an error over a clip that is playing perfectly.
 */

/** Longest side of a poster. Matches the archive's own thumbnails. */
const POSTER_SIZE = 384;

/**
 * What this page has already sent, kept apart on purpose.
 *
 * A video reports its duration the moment its metadata lands and its first
 * frame some time after that — often only once it starts playing. Tracking one
 * "done" flag for both meant whichever arrived first claimed the video, and the
 * poster was never sent.
 *
 * Module-level, because the viewer is mounted and unmounted constantly and
 * re-sending on every reopen is pure waste on a mobile connection.
 */
const postered = new Set<string>();
const timed = new Set<string>();

/** What identifies this video across mounts — its row when it has one. */
function keyOf(image: GenerationImage): string {
  return typeof image.id === 'number'
    ? `id:${image.id}`
    : `${image.type}/${image.subfolder}/${image.filename}`;
}

/** The element's current frame, scaled down, as a PNG data URL. */
function grabFrame(source: HTMLVideoElement | HTMLImageElement): string | null {
  const width =
    source instanceof HTMLVideoElement ? source.videoWidth : source.naturalWidth;
  const height =
    source instanceof HTMLVideoElement ? source.videoHeight : source.naturalHeight;
  if (!width || !height) return null;

  const scale = Math.min(1, POSTER_SIZE / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));

  const context = canvas.getContext('2d');
  if (!context) return null;

  try {
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/png');
  } catch {
    // A tainted canvas. Same origin here, so this should not happen — but a
    // failed poster must never break playback.
    return null;
  }
}

/**
 * Send this video's poster, once, along with how long it runs.
 *
 * Safe to call on every frame event: the first call for a given video wins and
 * every later one returns immediately.
 */
export function reportPoster(
  image: GenerationImage,
  /**
   * An `<audio>` element is here for its duration alone: it has no frame, so
   * `grabFrame` is never reached for one.
   */
  source: HTMLVideoElement | HTMLImageElement | HTMLAudioElement,
  /** Called once the server has it, so the grid can stop showing a plate. */
  onStored?: () => void,
): void {
  const key = keyOf(image);

  /*
   * There has to be a frame to copy.
   *
   * `loadedmetadata` gives the dimensions and the duration but not a picture,
   * and drawing the element then produces a black rectangle — which would be
   * filed as this clip's poster forever.
   */
  const decoded =
    source instanceof HTMLVideoElement
      ? source.readyState >= 2
      : source instanceof HTMLImageElement
        ? source.complete
        : false;
  // `decoded` is only ever true for the two elements that have a frame, so an
  // audio element never reaches the canvas.
  const poster =
    !image.hasThumbnail && !postered.has(key) && decoded
      ? grabFrame(source as HTMLVideoElement | HTMLImageElement)
      : null;

  const duration =
    source instanceof HTMLMediaElement &&
    Number.isFinite(source.duration) &&
    source.duration > 0 &&
    !timed.has(key)
      ? Math.round(source.duration * 1000)
      : undefined;

  if (!poster && !duration) return;

  if (poster) postered.add(key);
  if (duration) timed.add(key);

  void api
    .reportPoster(image, poster, duration)
    .then(() => {
      if (poster) onStored?.();
    })
    .catch(() => {
      // Allow another attempt on the next load rather than never trying again.
      if (poster) postered.delete(key);
      if (duration) timed.delete(key);
    });
}
