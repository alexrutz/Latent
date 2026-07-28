import type { FastifyInstance } from 'fastify';

import type { GalleryPage } from '@latent/shared';

import type { AppContext } from './context.js';

export function registerGalleryRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get<{ Querystring: { cursor?: string; limit?: string; workflowId?: string } }>(
    '/api/gallery',
    async (request) => {
      const limit = Number(request.query.limit ?? 30);
      const page = ctx.store.listGenerations({
        limit: Number.isFinite(limit) ? limit : 30,
        cursor: request.query.cursor ?? null,
        workflowId: request.query.workflowId ?? null,
      });
      return page satisfies GalleryPage;
    },
  );

  app.get<{ Params: { id: string } }>('/api/gallery/:id', async (request, reply) => {
    const record = ctx.store.getGeneration(request.params.id);
    if (!record) return reply.code(404).send({ error: 'Generation not found' });
    return record;
  });

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
