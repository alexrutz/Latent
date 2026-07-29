import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

import type { CreateFavoriteRequest, FavoriteSort } from '@latent/shared';

import type { AppContext } from './context.js';

const SORTS = new Set<FavoriteSort>(['rating', 'newest', 'oldest']);

/**
 * Favourites: kept images plus the settings that produced them.
 *
 * The purpose is "make more like this". So a favourite stores a *snapshot* of
 * the parameters rather than a reference to the gallery entry — deleting the
 * original, or the workflow, must not quietly empty the thing you saved.
 */
export function registerFavoriteRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get<{ Querystring: { sort?: string } }>('/api/favorites', async (request) => {
    const requested = request.query.sort as FavoriteSort | undefined;
    return ctx.store.listFavorites(requested && SORTS.has(requested) ? requested : 'rating');
  });

  app.post<{ Body: CreateFavoriteRequest }>('/api/favorites', async (request, reply) => {
    const { generationId, image, note } = request.body ?? {};
    if (!generationId || !image?.filename) {
      return reply.code(400).send({ error: 'Which image?' });
    }

    const generation = ctx.store.getGeneration(generationId);
    if (!generation) return reply.code(404).send({ error: 'Generation not found' });

    const row = ctx.store.findImage(image);
    if (!row) return reply.code(404).send({ error: 'That image is not in the gallery' });

    const existing = ctx.store.findFavoriteByImage(row.id);
    if (existing) return reply.code(200).send(existing);

    /*
     * A favourite is only useful if the picture is still there later, so
     * favouriting archives the image exactly as rating does. Otherwise the
     * favourites tab would fill with dead references the moment the rented
     * instance went away.
     */
    if (!row.archived_path) {
      try {
        await ctx.archive.capture(ctx.orchestrator.client, row.id, image);
      } catch (error) {
        app.log.warn({ err: error }, 'Could not archive an image while favouriting it');
      }
    }

    const id = randomUUID();
    ctx.store.insertFavorite({
      id,
      imageId: row.id,
      generationId,
      workflowId: generation.workflowId,
      title: generation.title,
      note: note?.trim() || null,
      values: generation.values,
      image: ctx.store.getGeneration(generationId)?.images.find(
        (candidate) =>
          candidate.filename === image.filename &&
          candidate.subfolder === (image.subfolder ?? '') &&
          candidate.type === (image.type ?? 'output'),
      ) ?? null,
    });

    return reply.code(201).send(ctx.store.getFavorite(id));
  });

  app.patch<{ Params: { id: string }; Body: { rating?: number; note?: string | null } }>(
    '/api/favorites/:id',
    async (request, reply) => {
      if (!ctx.store.getFavorite(request.params.id)) {
        return reply.code(404).send({ error: 'Favourite not found' });
      }

      const { rating, note } = request.body ?? {};
      if (rating !== undefined && (typeof rating !== 'number' || rating < 0 || rating > 5)) {
        return reply.code(400).send({ error: 'Rating must be between 0 and 5' });
      }

      ctx.store.updateFavorite(request.params.id, { rating, note });
      return ctx.store.getFavorite(request.params.id);
    },
  );

  /**
   * Removing a favourite leaves the archived image alone. The gallery rating is
   * a separate decision, and silently deleting a picture because someone
   * un-starred it here would be the wrong kind of surprise.
   */
  app.delete<{ Params: { id: string } }>('/api/favorites/:id', async (request, reply) => {
    if (!ctx.store.getFavorite(request.params.id)) {
      return reply.code(404).send({ error: 'Favourite not found' });
    }
    ctx.store.deleteFavorite(request.params.id);
    return reply.code(204).send();
  });
}
