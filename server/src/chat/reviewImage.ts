import { mediaKindOf } from '@latent/shared';
import type { GenerationRecord } from '@latent/shared';

import type { AppContext } from '../routes/context.js';

/**
 * The picture a run produced, small enough to show a language model.
 *
 * Prefilling an image costs real time on a local model — a 1024² picture is on
 * the order of a thousand tokens before it says anything, and a 4000² output is
 * minutes — so what goes over is a copy scaled into a box, made by the same
 * renderer the viewer uses. The browser already does this for a photo attached
 * by hand; this is the same decision for a picture that never went near the
 * browser.
 */

/**
 * Longest side of the copy the model is shown.
 *
 * 768 is the size most vision encoders tile at, so a bigger one costs more and
 * shows the model nothing extra. Small enough that a phone-sized conversation
 * does not fill the context with one render.
 */
const REVIEW_EDGE = 768;

/** Above this, an undecodable original is left alone rather than sent whole. */
const MAX_RAW_BYTES = 4 * 1024 * 1024;

export interface ReviewImage {
  /** `data:image/png;base64,…`, ready to be a chat part. */
  dataUrl: string;
}

/**
 * A picture from a finished run, or nothing when there is not one to show.
 *
 * Nothing is a perfectly ordinary answer: the run failed, it was cancelled, it
 * produced a video whose poster nobody has captured yet, or the file has gone
 * with the instance that made it. Every one of those means the turn goes ahead
 * without a picture rather than not at all.
 */
export async function loadReviewImage(
  ctx: AppContext,
  generationId: string,
): Promise<ReviewImage | null> {
  const record: GenerationRecord | null = ctx.store.getGeneration(generationId);
  if (!record || record.status !== 'completed') return null;

  const image = record.images[0];
  if (!image) return null;

  /*
   * A video is shown by its poster, when there is one.
   *
   * Nothing here can decode an mp4, and the frame the browser captured while
   * playing it is a fair thing to judge a prompt by — one frame of a clip is
   * how anyone would look at it first. With no poster yet, there is nothing to
   * show and the turn goes ahead without one.
   */
  const row = ctx.store.findImage(image);
  if (mediaKindOf(image.filename) === 'video') {
    if (!row?.thumb_path) return null;
    const poster = await ctx.archive.read(row.thumb_path).catch(() => null);
    return poster ? { dataUrl: toDataUrl(poster, 'image/png') } : null;
  }

  /** The bytes, from wherever this picture lives. */
  const load = async (): Promise<Buffer | null> => {
    if (row?.archived_path) return ctx.archive.read(row.archived_path);
    if (image.type === 'import') return null;
    const upstream = await ctx.orchestrator.client.view(image);
    if (!upstream.body) return null;
    return Buffer.from(await upstream.arrayBuffer());
  };

  let original: Buffer | null;
  try {
    original = await load();
  } catch {
    // ComfyUI gone, archive locked, file swept. The turn still happens.
    return null;
  }
  if (!original) return null;

  const rendered = await ctx.views
    .render(`review:${generationId}/${image.filename}`, async () => original, {
      width: REVIEW_EDGE,
      height: REVIEW_EDGE,
    }, null)
    .catch(() => null);

  if (rendered) return { dataUrl: toDataUrl(rendered.data, rendered.contentType) };

  /*
   * Undecodable here — a JPEG, or a PNG shape the decoder does not handle.
   * Sending it as it is works and is what the browser would have done; sending
   * a twenty-megabyte one is not, so that is where this stops.
   */
  if (original.length > MAX_RAW_BYTES) return null;
  return { dataUrl: toDataUrl(original, guessType(image.filename)) };
}

function toDataUrl(bytes: Buffer, contentType: string): string {
  return `data:${contentType};base64,${bytes.toString('base64')}`;
}

function guessType(filename: string): string {
  return /\.jpe?g$/i.test(filename) ? 'image/jpeg' : 'image/png';
}
