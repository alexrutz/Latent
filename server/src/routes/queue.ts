import type { FastifyInstance } from 'fastify';

import type { AppContext } from './context.js';

export function registerQueueRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/queue', async () => ctx.orchestrator.refreshQueue());

  /** Stop whatever is running right now. */
  app.post('/api/queue/interrupt', async (_request, reply) => {
    await ctx.orchestrator.interrupt();
    return reply.code(204).send();
  });

  /**
   * Cancel one job. If it is already running this interrupts it; if it is still
   * pending it is removed from the queue. ComfyUI has no reorder API, so
   * delete and clear are the only queue edits available.
   */
  app.delete<{ Params: { promptId: string } }>('/api/queue/:promptId', async (request, reply) => {
    await ctx.orchestrator.cancel(request.params.promptId);
    return reply.code(204).send();
  });

  app.delete('/api/queue', async (_request, reply) => {
    await ctx.orchestrator.clearQueue();
    return reply.code(204).send();
  });
}
