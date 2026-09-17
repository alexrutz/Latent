import type { FastifyInstance } from 'fastify';

import type { ComfyImageRef, GalleryPage, GallerySort } from '@latent/shared';

import { readImageSize } from '../images/png.js';
import { VaultLockedError } from '../vault.js';

import type { AppContext } from './context.js';

/** Anything else in the query string is somebody's typo, not a third ordering. */
const SORTS = new Set<GallerySort>(['newest', 'oldest', 'rating']);

/**
 * A poster is a still at thumbnail size, not a picture in its own right.
 *
 * 512 pixels on the long side as a PNG is tens of kilobytes; this leaves room
 * for a generous encoder and refuses anything that is plainly not a thumbnail.
 */
const MAX_POSTER_BYTES = 2 * 1024 * 1024;
/** Base64 costs a third more, and the body carries a little JSON besides. */
const POSTER_BODY_LIMIT = 4 * 1024 * 1024;

export function registerGalleryRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get<{
    Querystring: {
      cursor?: string;
      limit?: string;
      workflowId?: string;
      minRating?: string;
      sort?: string;
    };
  }>('/api/gallery', async (request) => {
    const limit = Number(request.query.limit ?? 30);
    const minRating = Number(request.query.minRating ?? 0);
    const sort = request.query.sort as GallerySort | undefined;
    const page = ctx.store.listGenerations({
      limit: Number.isFinite(limit) ? limit : 30,
      cursor: request.query.cursor ?? null,
      workflowId: request.query.workflowId ?? null,
      minRating: Number.isFinite(minRating) ? minRating : 0,
      sort: sort && SORTS.has(sort) ? sort : 'newest',
    });
    return page satisfies GalleryPage;
  });

  app.get<{ Params: { id: string } }>('/api/gallery/:id', async (request, reply) => {
    const record = ctx.store.getGeneration(request.params.id);
    if (!record) return reply.code(404).send({ error: 'Generation not found' });
    return record;
  });

  /**
   * Rate an image, and archive it.
   *
   * The archiving is the substance of this endpoint, not a side effect: a rated
   * image is one the user wants to keep, and keeping it means holding the bytes
   * locally rather than a reference into a rented machine's filesystem.
   */
  app.put<{ Params: { id: string }; Body: { image?: ComfyImageRef & { id?: number }; rating?: number } }>(
    '/api/gallery/:id/rating',
    async (request, reply) => {
      const record = ctx.store.getGeneration(request.params.id);
      if (!record) return reply.code(404).send({ error: 'Generation not found' });

      const { image, rating } = request.body ?? {};
      if (!image?.filename) return reply.code(400).send({ error: 'Which image?' });
      if (typeof rating !== 'number' || rating < 0 || rating > 5) {
        return reply.code(400).send({ error: 'Rating must be between 0 and 5' });
      }

      const row = ctx.store.findImage(image, record.id);
      if (!row) return reply.code(404).send({ error: 'That image is not in the gallery' });

      ctx.store.setImageRating(row.id, rating);

      if (rating > 0 && !row.archived_path) {
        if (!ctx.vault.isUnlocked) {
          return reply.code(423).send({ error: new VaultLockedError().message, locked: true });
        }
        try {
          await ctx.archive.capture(ctx.orchestrator.client, row.id, image);
        } catch (error) {
          // The rating is saved either way — losing the star because the box
          // went away would be the worst of both worlds. Say what happened.
          app.log.warn({ err: error }, 'Could not archive a rated image');
          return reply.code(207).send({
            ...ctx.store.getGeneration(request.params.id),
            warning:
              'Rating saved, but the image could not be copied locally — ComfyUI did not answer. ' +
              'It will not survive that instance being destroyed.',
          });
        }
      }

      // Rating back to zero deliberately keeps the file: a mis-tap should not
      // silently delete a picture. Settings has an explicit prune action.
      return ctx.store.getGeneration(request.params.id);
    },
  );

  /**
   * Manually override how many grid cells an image occupies.
   *
   * The automatic size follows the picture's aspect ratio, which is right most
   * of the time; this is for the times it isn't — a favourite you want bigger,
   * or a near-square image you would rather have small.
   */
  app.put<{
    Params: { id: string };
    Body: { image?: ComfyImageRef & { id?: number }; span?: { cols: number; rows: number } | null };
  }>('/api/gallery/:id/tile', async (request, reply) => {
    const { image, span } = request.body ?? {};
    if (!image?.filename) return reply.code(400).send({ error: 'Which image?' });

    const row = ctx.store.findImage(image, request.params.id);
    if (!row) return reply.code(404).send({ error: 'That image is not in the gallery' });

    if (span && (span.cols < 1 || span.cols > 4 || span.rows < 1 || span.rows > 4)) {
      return reply.code(400).send({ error: 'A tile can span 1 to 4 cells' });
    }

    ctx.store.setImageTileSpan(row.id, span ?? null);
    return ctx.store.getGeneration(request.params.id);
  });

  /**
   * Record an image's pixel size, measured by the browser when it first loads.
   *
   * The grid needs the aspect ratio to shape a tile *before* the image arrives,
   * or the layout jumps as each thumbnail loads. ComfyUI never tells us the
   * size, so the first client to see an image reports it back.
   */
  app.put<{ Body: { image?: ComfyImageRef & { id?: number }; width?: number; height?: number } }>(
    '/api/images/dimensions',
    async (request, reply) => {
      const { image, width, height } = request.body ?? {};
      if (!image?.filename) return reply.code(400).send({ error: 'Which image?' });
      if (!width || !height || width < 1 || height < 1 || width > 30000 || height > 30000) {
        return reply.code(400).send({ error: 'Implausible dimensions' });
      }

      const row = ctx.store.findImage(image);
      if (!row) return reply.code(404).send({ error: 'That image is not in the gallery' });
      // Never overwrite what we measured ourselves while archiving.
      if (row.width && row.height) return reply.code(204).send();

      ctx.store.setImageDimensions(row.id, Math.round(width), Math.round(height));
      return reply.code(204).send();
    },
  );

  /**
   * A frame of a video, sent back by the browser that decoded it.
   *
   * Nothing on this server can open an mp4 — there is no ffmpeg here and no
   * pure-JavaScript decoder worth having — so a video would have no thumbnail
   * at all, and every grid tile showing one would have to load the clip itself.
   * The browser is already decoding it to play it, so it grabs one frame and
   * posts it here, and from then on the video has a still like everything else.
   *
   * Sent as a data URL because that is what a canvas produces; the alternative
   * is a multipart upload of a 40 kB PNG, which is more machinery for the same
   * bytes. Refused unless it really is a PNG of a sane size — this is an
   * endpoint that writes a file, and it takes its input from a browser.
   */
  app.put<{
    Body: {
      image?: ComfyImageRef & { id?: number };
      /** `data:image/png;base64,…` */
      poster?: string;
      durationMs?: number;
    };
  }>('/api/images/poster', { bodyLimit: POSTER_BODY_LIMIT }, async (request, reply) => {
    const { image, poster, durationMs } = request.body ?? {};
    if (!image?.filename) return reply.code(400).send({ error: 'Which video?' });

    const row = ctx.store.findImage(image);
    if (!row) return reply.code(404).send({ error: 'That video is not in the gallery' });

    if (typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs > 0) {
      ctx.store.setImageDuration(row.id, Math.min(durationMs, 24 * 60 * 60 * 1000));
    }

    // Already has one: a second client watching the same clip must not rewrite
    // the poster, and saying so costs nothing.
    if (row.thumb_path) return reply.code(204).send();
    if (!poster) return reply.code(204).send();

    const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(poster.trim());
    if (!match?.[1]) return reply.code(400).send({ error: 'A poster must be a base64 PNG' });

    const bytes = Buffer.from(match[1], 'base64');
    if (bytes.length === 0 || bytes.length > MAX_POSTER_BYTES) {
      return reply.code(413).send({ error: 'That poster is too large' });
    }
    const size = readImageSize(bytes);
    if (!size) return reply.code(400).send({ error: 'That poster is not a readable PNG' });

    if (!ctx.vault.isUnlocked) {
      return reply.code(423).send({ error: new VaultLockedError().message, locked: true });
    }

    await ctx.archive.storePoster(row.id, bytes, size);
    return reply.code(204).send();
  });

  /**
   * Keep a picture without passing judgement on it.
   *
   * Rating is an opinion, and requiring one for every image you want to survive
   * the automatic cleanup is the wrong price. This makes the same promise a
   * rating does — copied into the local archive, never swept — and says nothing
   * about quality.
   */
  app.put<{ Params: { id: string }; Body: { image?: ComfyImageRef & { id?: number }; kept?: boolean } }>(
    '/api/gallery/:id/keep',
    async (request, reply) => {
      const record = ctx.store.getGeneration(request.params.id);
      if (!record) return reply.code(404).send({ error: 'Generation not found' });

      const { image, kept = true } = request.body ?? {};
      if (!image?.filename) return reply.code(400).send({ error: 'Which image?' });

      const row = ctx.store.findImage(image, record.id);
      if (!row) return reply.code(404).send({ error: 'That image is not in the gallery' });

      ctx.store.setImageKept(row.id, kept);

      if (kept && !row.archived_path) {
        if (!ctx.vault.isUnlocked) {
          return reply.code(423).send({ error: new VaultLockedError().message, locked: true });
        }
        try {
          await ctx.archive.capture(ctx.orchestrator.client, row.id, image);
        } catch (error) {
          app.log.warn({ err: error }, 'Could not archive a kept image');
          return reply.code(207).send({
            ...ctx.store.getGeneration(request.params.id),
            warning:
              'Kept, but the image could not be copied locally — ComfyUI did not answer. ' +
              'It will not survive that instance being destroyed.',
          });
        }
      }

      return ctx.store.getGeneration(request.params.id);
    },
  );

  /**
   * Removes the record from Latent's history only. The image files stay in
   * ComfyUI's output directory — deleting a user's files from a phone tap is
   * not this app's call to make.
   */
  app.delete<{ Params: { id: string } }>('/api/gallery/:id', async (request, reply) => {
    const record = ctx.store.getGeneration(request.params.id);
    if (!record) return reply.code(404).send({ error: 'Generation not found' });

    // The local copies are ours, though, and leaving them behind would be a
    // slow leak of exactly the bytes the user just said they did not want.
    for (const image of record.images) {
      const row = ctx.store.findImage(image, record.id);
      if (row) await ctx.archive.forget(row.id, row);
    }

    ctx.store.deleteGeneration(request.params.id);
    return reply.code(204).send();
  });

  /**
   * Delete one picture out of a run rather than the whole thing.
   *
   * A batch of four with one good frame is the normal case; being able to
   * remove only the three misses is what keeps the gallery worth scrolling.
   */
  app.delete<{ Params: { id: string }; Querystring: { filename?: string; subfolder?: string; type?: string } }>(
    '/api/gallery/:id/image',
    async (request, reply) => {
      const record = ctx.store.getGeneration(request.params.id);
      if (!record) return reply.code(404).send({ error: 'Generation not found' });

      const { filename, subfolder = '', type = 'output' } = request.query ?? {};
      if (!filename) return reply.code(400).send({ error: 'Which image?' });

      const row = ctx.store.findImage({ filename, subfolder, type }, record.id);
      if (!row || row.generation_id !== record.id) {
        return reply.code(404).send({ error: 'That image is not in this run' });
      }

      await ctx.archive.forget(row.id, row);
      ctx.store.deleteImage(row.id);

      // A run with nothing left in it is not a gallery entry any more.
      const remaining = ctx.store.getGeneration(record.id);
      if (remaining && remaining.images.length === 0) {
        ctx.store.deleteGeneration(record.id);
        return reply.code(204).send();
      }
      return remaining;
    },
  );
}
