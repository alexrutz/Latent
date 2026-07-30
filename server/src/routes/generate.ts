import type { FastifyInstance } from 'fastify';

import {
  applyOverrides,
  applyParams,
  buildParamSummary,
  composeRandomPrompt,
  pickRandomBlocks,
} from '@latent/shared';
import type { GenerateRequest, GenerateResponse, ParamValues } from '@latent/shared';

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

    // Remember what the user last typed so the form reopens where they left it.
    // Deliberately the typed values, never a drawn prompt — otherwise the form
    // would fill with random text the next time it is opened.
    ctx.store.updateWorkflow(detail.id, { lastValues: values });

    /*
     * Random prompt mode.
     *
     * The draw happens here, once per queued item, because that is the only place
     * it can: a phone that queues eight and locks its screen must still get eight
     * different prompts. Doing it in the browser would send the same prompt eight
     * times, which is the opposite of the point.
     */
    const randomConfig = ctx.store.getRandomPromptConfig();
    const promptFields = schema.fields.filter(
      (field) => field.role === 'prompt' && !field.hidden,
    );
    const drawing = randomConfig.enabled && promptFields.length > 0;
    const blocks = drawing ? ctx.store.listPromptBlocks() : [];

    /**
     * Replace every positive prompt with a freshly drawn one.
     *
     * The draw is made *once* and applied to each prompt field, rather than drawn
     * per field: a base-and-refiner workflow has two prompt inputs describing one
     * picture, and giving them different modifiers would pull the render in two
     * directions. Each field keeps its own typed text as the base.
     */
    const drawPrompts = (base: ParamValues): ParamValues => {
      const first = promptFields[0];
      const primaryText = first ? String(base[first.id] ?? first.defaultValue ?? '') : '';
      const drawn = pickRandomBlocks(blocks, randomConfig, primaryText);
      // Nothing to add — an empty library, or a pool narrowed to nothing. Submit
      // what was typed rather than a blank prompt.
      if (drawn.length === 0) return base;

      const next: ParamValues = { ...base };
      for (const field of promptFields) {
        const typed = String(base[field.id] ?? field.defaultValue ?? '');
        next[field.id] = composeRandomPrompt(typed, drawn, randomConfig.keepTyped);
      }
      return next;
    };

    const generationIds: string[] = [];
    const promptIds: string[] = [];

    for (let i = 0; i < batchCount; i += 1) {
      const itemValues = drawing ? drawPrompts(values) : values;
      // Re-derived per item: with a drawn prompt the title differs each time, and
      // the title is what the gallery and queue show.
      const title = deriveTitle(schema, itemValues, detail.name);

      const { workflow, seeds } = applyParams(detail.graph, schema, itemValues, {
        randomizeSeeds: body.randomizeSeeds ?? false,
        lockedSeedFields: body.lockedSeedFields ?? [],
      });

      // Built per item, not once: each item in a batch gets its own seed, and
      // the seed is often the only thing distinguishing two queued jobs.
      const submitted = { ...itemValues, ...seeds };

      try {
        const result = await ctx.orchestrator.submit({
          graph: workflow,
          workflowId: detail.id,
          workflowName: detail.name,
          title,
          values: submitted,
          seeds,
          params: buildParamSummary(schema, submitted),
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
