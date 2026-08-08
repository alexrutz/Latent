import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

import type { ComfyImageRef, CreateFavoriteRequest, Favorite, FavoriteSort } from '@latent/shared';

import type { AppContext } from './context.js';

const SORTS = new Set<FavoriteSort>(['rating', 'newest', 'oldest']);

/**
 * Favourites: kept images plus the settings that produced them.
 *
 * The purpose is "make more like this". So a favourite stores a *snapshot* of
 * the parameters rather than a reference to the gallery entry — deleting the
 * original, or the workflow, must not quietly empty the thing you saved.
 */
/**
 * Keep one picture, with the settings that made it.
 *
 * A function rather than only a route body because the parameter study needs
 * exactly this and nothing about it is specific to the gallery — a second copy
 * would be a second place to remember that favouriting has to archive, and it
 * would drift the first time either changed.
 *
 * `created` is false when there already was one, which makes tapping the star
 * twice harmless rather than a duplicate — and lets the route answer 200
 * rather than 201, so a client can tell the two apart.
 */
export async function keepAsFavorite(
  app: FastifyInstance,
  ctx: AppContext,
  input: { generationId: string; image: ComfyImageRef; note?: string | null },
): Promise<{ favorite: Favorite; created: boolean } | null> {
  const generation = ctx.store.getGeneration(input.generationId);
  if (!generation) return null;

  const row = ctx.store.findImage(input.image, input.generationId);
  if (!row) return null;

  const existing = ctx.store.findFavoriteByImage(row.id);
  if (existing) return { favorite: existing, created: false };

  /*
   * A favourite is only useful if the picture is still there later, so
   * favouriting archives the image exactly as rating does. Otherwise the
   * favourites tab would fill with dead references the moment the rented
   * instance went away.
   */
  if (!row.archived_path) {
    try {
      await ctx.archive.capture(ctx.orchestrator.client, row.id, input.image);
    } catch (error) {
      app.log.warn({ err: error }, 'Could not archive an image while favouriting it');
    }
  }

  const id = randomUUID();
  ctx.store.insertFavorite({
    id,
    imageId: row.id,
    generationId: input.generationId,
    workflowId: generation.workflowId,
    title: generation.title,
    note: input.note?.trim() || null,
    values: generation.values,
    image:
      ctx.store.getGeneration(input.generationId)?.images.find(
        (candidate) =>
          candidate.filename === input.image.filename &&
          candidate.subfolder === (input.image.subfolder ?? '') &&
          candidate.type === (input.image.type ?? 'output'),
      ) ?? null,
  });

  const favorite = ctx.store.getFavorite(id);
  return favorite ? { favorite, created: true } : null;
}

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

    if (!ctx.store.getGeneration(generationId)) {
      return reply.code(404).send({ error: 'Generation not found' });
    }

    const kept = await keepAsFavorite(app, ctx, { generationId, image, note });
    if (!kept) return reply.code(404).send({ error: 'That image is not in the gallery' });
    return reply.code(kept.created ? 201 : 200).send(kept.favorite);
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
   * Fetch the picture for a favourite that never got one.
   *
   * The copy made at favouriting time can fail — ComfyUI busy, the connection
   * dropped — and it was only logged, which left a favourite that looked fine
   * until the instance holding the picture went away. This is the second
   * chance, and it only works while the source is still reachable, so the
   * failure has to say that rather than "something went wrong".
   */
  app.post<{ Params: { id: string } }>('/api/favorites/:id/archive', async (request, reply) => {
    const favorite = ctx.store.getFavorite(request.params.id);
    if (!favorite) return reply.code(404).send({ error: 'No such favourite' });
    if (favorite.archived) return reply.send(favorite);
    if (!favorite.image) {
      return reply.code(409).send({ error: 'That favourite has no image to fetch.' });
    }

    const row = ctx.store.findImage(favorite.image, favorite.generationId ?? undefined);
    if (!row) {
      return reply.code(409).send({
        error: 'That picture is no longer in the gallery, so there is nothing left to copy.',
      });
    }

    try {
      await ctx.archive.capture(ctx.orchestrator.client, row.id, favorite.image);
    } catch (error) {
      app.log.warn({ err: error }, 'Could not archive a favourite on request');
      return reply.code(502).send({
        error:
          'ComfyUI could not give us that picture. It only works while the instance that ' +
          'made it is still reachable and still has the file.',
      });
    }

    return reply.send(ctx.store.getFavorite(request.params.id));
  });

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
