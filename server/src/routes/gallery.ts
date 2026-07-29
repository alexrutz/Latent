import type { FastifyInstance } from 'fastify';

import type { ComfyImageRef, GalleryPage } from '@latent/shared';

import type { AppContext } from './context.js';

export function registerGalleryRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get<{
    Querystring: { cursor?: string; limit?: string; workflowId?: string; minRating?: string };
  }>('/api/gallery', async (request) => {
    const limit = Number(request.query.limit ?? 30);
    const minRating = Number(request.query.minRating ?? 0);
    const page = ctx.store.listGenerations({
      limit: Number.isFinite(limit) ? limit : 30,
      cursor: request.query.cursor ?? null,
      workflowId: request.query.workflowId ?? null,
      minRating: Number.isFinite(minRating) ? minRating : 0,
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
  app.put<{ Params: { id: string }; Body: { image?: ComfyImageRef; rating?: number } }>(
    '/api/gallery/:id/rating',
    async (request, reply) => {
      const record = ctx.store.getGeneration(request.params.id);
      if (!record) return reply.code(404).send({ error: 'Generation not found' });

      const { image, rating } = request.body ?? {};
      if (!image?.filename) return reply.code(400).send({ error: 'Which image?' });
      if (typeof rating !== 'number' || rating < 0 || rating > 5) {
        return reply.code(400).send({ error: 'Rating must be between 0 and 5' });
      }

      const row = ctx.store.findImage(image);
      if (!row) return reply.code(404).send({ error: 'That image is not in the gallery' });

      ctx.store.setImageRating(row.id, rating);

      if (rating > 0 && !row.archived_path) {
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
   * Removes the record from Latent's history only. The image files stay in
   * ComfyUI's output directory — deleting a user's files from a phone tap is
   * not this app's call to make.
   */
  app.delete<{ Params: { id: string } }>('/api/gallery/:id', async (request, reply) => {
    if (!ctx.store.getGeneration(request.params.id)) {
      return reply.code(404).send({ error: 'Generation not found' });
    }
    ctx.store.deleteGeneration(request.params.id);
    return reply.code(204).send();
  });
}
