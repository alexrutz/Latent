import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

import type { CreatePresetRequest } from '@latent/shared';

import type { AppContext } from './context.js';

/**
 * Named parameter sets, per workflow.
 *
 * The problem they solve: changing five settings means opening five sheets, and
 * on a phone that is the difference between trying an idea and not bothering.
 * A preset applies the whole set in one tap.
 */
export function registerPresetRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get<{ Params: { workflowId: string } }>(
    '/api/workflows/:workflowId/presets',
    async (request, reply) => {
      if (!ctx.store.getWorkflow(request.params.workflowId)) {
        return reply.code(404).send({ error: 'Workflow not found' });
      }
      return ctx.store.listPresets(request.params.workflowId);
    },
  );

  app.post<{ Params: { workflowId: string }; Body: CreatePresetRequest }>(
    '/api/workflows/:workflowId/presets',
    async (request, reply) => {
      if (!ctx.store.getWorkflow(request.params.workflowId)) {
        return reply.code(404).send({ error: 'Workflow not found' });
      }

      const { name, values } = request.body ?? {};
      if (typeof name !== 'string' || name.trim() === '') {
        return reply.code(400).send({ error: 'Give the preset a name' });
      }
      if (!values || typeof values !== 'object') {
        return reply.code(400).send({ error: 'Missing values' });
      }

      // Saving over an existing name replaces it — that is what "save" means
      // when you have tweaked a preset and want to keep the tweak.
      const preset = ctx.store.upsertPreset(
        randomUUID(),
        request.params.workflowId,
        name,
        values,
      );
      return reply.code(201).send(preset);
    },
  );

  app.delete<{ Params: { id: string } }>('/api/presets/:id', async (request, reply) => {
    if (!ctx.store.getPreset(request.params.id)) {
      return reply.code(404).send({ error: 'Preset not found' });
    }
    ctx.store.deletePreset(request.params.id);
    return reply.code(204).send();
  });
}
