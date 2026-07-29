import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

import type { CreateLayoutRequest, FieldOverrides } from '@latent/shared';

import type { AppContext } from './context.js';

/**
 * Named arrangements of a workflow's form.
 *
 * A workflow used to have exactly one set of field overrides, so arranging the
 * form for one way of working destroyed the arrangement you had for another —
 * a stripped-down layout for quick drafts and a full one for careful work could
 * not coexist. Layouts are switchable snapshots of that arrangement.
 *
 * The workflow's own `overrides` remain the live, editable state; activating a
 * layout copies its overrides into that state, and saving copies them back out.
 */
export function registerLayoutRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get<{ Params: { workflowId: string } }>(
    '/api/workflows/:workflowId/layouts',
    async (request, reply) => {
      if (!ctx.store.getWorkflow(request.params.workflowId)) {
        return reply.code(404).send({ error: 'Workflow not found' });
      }
      return ctx.store.listLayouts(request.params.workflowId);
    },
  );

  app.post<{ Params: { workflowId: string }; Body: CreateLayoutRequest }>(
    '/api/workflows/:workflowId/layouts',
    async (request, reply) => {
      const workflow = ctx.store.getWorkflow(request.params.workflowId);
      if (!workflow) return reply.code(404).send({ error: 'Workflow not found' });

      const { name, overrides } = request.body ?? {};
      if (typeof name !== 'string' || name.trim() === '') {
        return reply.code(400).send({ error: 'Give the layout a name' });
      }

      // Default to snapshotting what is on screen right now — that is what
      // "save this layout" means to the person tapping the button.
      const snapshot: FieldOverrides = overrides ?? workflow.overrides;

      const layout = ctx.store.upsertLayout(
        randomUUID(),
        request.params.workflowId,
        name,
        snapshot,
      );
      // A newly saved layout becomes the active one; otherwise saving would
      // appear to do nothing.
      ctx.store.activateLayout(request.params.workflowId, layout.id);

      return reply.code(201).send(ctx.store.getLayout(layout.id));
    },
  );

  /** Switch to a layout, applying its overrides to the live form. */
  app.post<{ Params: { workflowId: string; id: string } }>(
    '/api/workflows/:workflowId/layouts/:id/activate',
    async (request, reply) => {
      const layout = ctx.store.getLayout(request.params.id);
      if (!layout || layout.workflowId !== request.params.workflowId) {
        return reply.code(404).send({ error: 'Layout not found' });
      }

      ctx.store.activateLayout(request.params.workflowId, layout.id);
      ctx.store.updateWorkflow(request.params.workflowId, { overrides: layout.overrides });

      return ctx.store.listLayouts(request.params.workflowId);
    },
  );

  /**
   * Deleting the active layout leaves the form exactly as it looks now — it just
   * stops being a saved arrangement. Silently reverting the form would be a
   * surprising amount of destruction for a delete button.
   */
  app.delete<{ Params: { workflowId: string; id: string } }>(
    '/api/workflows/:workflowId/layouts/:id',
    async (request, reply) => {
      const layout = ctx.store.getLayout(request.params.id);
      if (!layout || layout.workflowId !== request.params.workflowId) {
        return reply.code(404).send({ error: 'Layout not found' });
      }
      ctx.store.deleteLayout(layout.id);
      return reply.code(204).send();
    },
  );
}
