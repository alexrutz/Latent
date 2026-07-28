import type { FastifyInstance } from 'fastify';

import { applyOverrides, applyParams } from '@latent/shared';
import type { GenerateRequest, GenerateResponse } from '@latent/shared';

import { ComfyError } from '../comfy/client.js';
import { deriveTitle, type AppContext } from './context.js';

const MAX_BATCH_COUNT = 32;

export function registerGenerateRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post<{ Body: GenerateRequest }>('/api/generate', async (request, reply) => {
    const body = request.body ?? ({} as GenerateRequest);
    const detail = ctx.store.getWorkflow(body.workflowId);
    if (!detail) return reply.code(404).send({ error: 'Workflow not found' });

    const schema = applyOverrides(detail.schema, detail.overrides);
    const values = body.values ?? {};
    const batchCount = Math.min(Math.max(Math.floor(body.batchCount ?? 1) || 1, 1), MAX_BATCH_COUNT);
    const title = deriveTitle(schema, values, detail.name);

    // Remember what the user last typed so the form reopens where they left it.
    ctx.store.updateWorkflow(detail.id, { lastValues: values });

    const generationIds: string[] = [];
    const promptIds: string[] = [];

    for (let i = 0; i < batchCount; i += 1) {
      const { workflow, seeds } = applyParams(detail.graph, schema, values, {
        randomizeSeeds: body.randomizeSeeds ?? false,
        lockedSeedFields: body.lockedSeedFields ?? [],
      });

      try {
        const result = await ctx.orchestrator.submit({
          graph: workflow,
          workflowId: detail.id,
          workflowName: detail.name,
          title,
          values: { ...values, ...seeds },
          seeds,
        });
        generationIds.push(result.generationId);
        promptIds.push(result.promptId);
      } catch (error) {
        // Partial success is real: earlier items in the batch are already
        // queued, so report them alongside the failure rather than pretending
        // nothing happened.
        const message = describeSubmitError(error);
        if (generationIds.length > 0) {
          return reply.code(207).send({
            generationIds,
            promptIds,
            error: `Queued ${generationIds.length} of ${batchCount}. ${message}`,
          });
        }
        return reply.code(502).send({ error: message });
      }
    }

    const response: GenerateResponse = { generationIds, promptIds };
    return reply.code(202).send(response);
  });
}

/**
 * ComfyUI rejects an invalid graph with a structured `node_errors` payload.
 * Surface the first concrete problem instead of a bare 400.
 */
function describeSubmitError(error: unknown): string {
  if (error instanceof ComfyError) {
    const detail = error.detail as
      | {
          error?: { message?: string; details?: string };
          node_errors?: Record<string, { errors?: { message?: string; details?: string }[] }>;
        }
      | undefined;

    const nodeErrors = detail?.node_errors ?? {};
    for (const [nodeId, node] of Object.entries(nodeErrors)) {
      const first = node.errors?.[0];
      if (first?.message) {
        return `Node ${nodeId}: ${first.message}${first.details ? ` (${first.details})` : ''}`;
      }
    }

    if (detail?.error?.message) {
      return `${detail.error.message}${detail.error.details ? ` — ${detail.error.details}` : ''}`;
    }
    return error.message;
  }

  return error instanceof Error ? error.message : 'Failed to submit the prompt to ComfyUI';
}
