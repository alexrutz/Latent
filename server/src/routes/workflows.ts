import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

import {
  applyOverrides,
  assertApiWorkflow,
  buildParamSchema,
  defaultValues,
  isUiWorkflow,
  uiToApiWorkflow,
  UiWorkflowError,
  WorkflowFormatError,
} from '@latent/shared';
import type {
  CreateWorkflowRequest,
  ObjectInfo,
  UpdateWorkflowRequest,
  WorkflowDetail,
} from '@latent/shared';

import type { AppContext } from './context.js';

/** Merge stored user overrides into the schema before it reaches the client. */
function withOverrides(detail: WorkflowDetail): WorkflowDetail {
  return { ...detail, schema: applyOverrides(detail.schema, detail.overrides) };
}

export function registerWorkflowRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/workflows', async () => ctx.store.listWorkflows());

  /**
   * Import every workflow saved in the ComfyUI installation.
   *
   * Imported hidden, so the generate picker stays short; Settings is where they
   * are switched on.
   */
  app.post('/api/workflows/scan', async () => ctx.workflowScanner.scan());

  app.get<{ Params: { id: string } }>('/api/workflows/:id', async (request, reply) => {
    const detail = ctx.store.getWorkflow(request.params.id);
    if (!detail) return reply.code(404).send({ error: 'Workflow not found' });
    return withOverrides(detail);
  });

  app.post<{ Body: CreateWorkflowRequest }>('/api/workflows', async (request, reply) => {
    const { name, graph } = request.body ?? {};

    if (typeof name !== 'string' || name.trim() === '') {
      return reply.code(400).send({ error: 'A workflow name is required' });
    }

    // Without object_info we can still build a usable schema (types inferred
    // from the literal values), so an offline ComfyUI doesn't block an import.
    let objectInfo: ObjectInfo = {};
    try {
      objectInfo = await ctx.orchestrator.objectInfo();
    } catch {
      app.log.warn('Importing a workflow without /object_info — ComfyUI is unreachable');
    }

    let parsedGraph;
    try {
      /*
       * A file saved by the editor rather than exported through "Save (API)"
       * is a different shape entirely. Converting it here means the file the
       * user actually has on disk is the file they can import.
       */
      parsedGraph = isUiWorkflow(graph)
        ? uiToApiWorkflow(graph, objectInfo)
        : assertApiWorkflow(graph);
    } catch (error) {
      if (error instanceof WorkflowFormatError || error instanceof UiWorkflowError) {
        return reply.code(400).send({ error: error.message });
      }
      throw error;
    }

    const schema = buildParamSchema(parsedGraph, objectInfo);
    const id = randomUUID();
    ctx.store.insertWorkflow({
      id,
      name: name.trim(),
      graph: parsedGraph,
      schema,
      lastValues: defaultValues(schema),
    });

    // If a previous install arranged this workflow's form, take that back
    // rather than making the user rebuild it after a clean start.
    ctx.stateFiles.adopt(id, name.trim());

    const detail = ctx.store.getWorkflow(id);
    return reply.code(201).send(detail ? withOverrides(detail) : null);
  });

  app.patch<{ Params: { id: string }; Body: UpdateWorkflowRequest }>(
    '/api/workflows/:id',
    async (request, reply) => {
      const existing = ctx.store.getWorkflow(request.params.id);
      if (!existing) return reply.code(404).send({ error: 'Workflow not found' });

      const { name, overrides, lastValues, visible } = request.body ?? {};
      if (name !== undefined && (typeof name !== 'string' || name.trim() === '')) {
        return reply.code(400).send({ error: 'Workflow name cannot be empty' });
      }

      ctx.store.updateWorkflow(request.params.id, {
        ...(name !== undefined ? { name: name.trim() } : {}),
        ...(overrides !== undefined ? { overrides } : {}),
        ...(lastValues !== undefined ? { lastValues } : {}),
      });
      if (typeof visible === 'boolean') ctx.store.setWorkflowVisible(request.params.id, visible);

      const detail = ctx.store.getWorkflow(request.params.id);
      return detail ? withOverrides(detail) : reply.code(404).send({ error: 'Workflow not found' });
    },
  );

  /**
   * Re-derive the schema from the current `/object_info`.
   *
   * Needed after installing a model or a custom node: the stored combo option
   * lists are a snapshot of what existed at import time. User overrides are
   * stored separately and survive untouched.
   */
  app.post<{ Params: { id: string } }>('/api/workflows/:id/rescan', async (request, reply) => {
    const existing = ctx.store.getWorkflow(request.params.id);
    if (!existing) return reply.code(404).send({ error: 'Workflow not found' });

    const objectInfo = await ctx.orchestrator.objectInfo(true);
    const schema = buildParamSchema(existing.graph, objectInfo);
    ctx.store.updateWorkflow(request.params.id, { schema });

    const detail = ctx.store.getWorkflow(request.params.id);
    return detail ? withOverrides(detail) : reply.code(404).send({ error: 'Workflow not found' });
  });

  app.delete<{ Params: { id: string } }>('/api/workflows/:id', async (request, reply) => {
    if (!ctx.store.getWorkflow(request.params.id)) {
      return reply.code(404).send({ error: 'Workflow not found' });
    }
    ctx.store.deleteWorkflow(request.params.id);
    return reply.code(204).send();
  });
}
