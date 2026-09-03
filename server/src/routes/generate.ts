import type { FastifyInstance } from 'fastify';

import {
  appendAlwaysBlocks,
  applyModelServer,
  applyOverrides,
  applyImageOff,
  applyParams,
  imageOffNodes,
  applyPresetActive,
  applyPresetChat,
  applySystemPrompts,
  buildParamSummary,
  composeRandomPrompt,
  drawRandomParams,
  findEditOrigins,
  pickRandomBlocks,
} from '@latent/shared';
import type {
  GenerateRequest,
  GenerateResponse,
  ModelServerTarget,
  ObjectInfo,
  ParamValues,
} from '@latent/shared';

import { ComfyError } from '../comfy/client.js';
import { deriveTitle, type AppContext } from './context.js';

const MAX_BATCH_COUNT = 32;

export interface QueueBatchResult {
  generationIds: string[];
  promptIds: string[];
  /** Set when the batch stopped early; earlier items are still queued. */
  error?: string;
}

/**
 * Queue one batch, drawing the prompt and the varied parameters per item.
 *
 * A function rather than only a route handler because the endless mode submits
 * exactly this, unattended, and it has to draw a *fresh* prompt each time — a
 * second copy of this logic would drift from the first the day either changes.
 */
export async function queueBatch(
  ctx: AppContext,
  body: GenerateRequest,
): Promise<QueueBatchResult | { notFound: true }> {
  const detail = ctx.store.getWorkflow(body.workflowId);
  if (!detail) return { notFound: true };
  return runBatch(ctx, detail, body);
}

/** The batch itself, once the workflow has been found. */
async function runBatch(
  ctx: AppContext,
  detail: NonNullable<ReturnType<AppContext['store']['getWorkflow']>>,
  body: GenerateRequest,
): Promise<QueueBatchResult> {
  const values = body.values ?? {};
  /*
   * The preset-chat node's slots are named in the form, so the schema it
   * implies depends on the values that came with the request — and it has to be
   * the *same* reshaping the form did, or a system prompt that filled a slot
   * named "Rewrite" on screen would land nowhere here. The overrides go on top,
   * so a label typed in the form editor still wins over the slot's name.
   */
  const schema = applyOverrides(applyPresetChat(detail.schema, values), detail.overrides);
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
    (field) =>
      field.role === 'prompt' &&
      !field.hidden &&
      // Explicitly held back in the Random tab. The heuristics decide what
      // counts as a prompt, and this is how the user overrules them.
      !randomConfig.excludedPromptFields.includes(field.id),
  );
  const drawingPrompt = randomConfig.enabled && promptFields.length > 0;
  const drawingParams = randomConfig.enabled && randomConfig.params.length > 0;
  const blocks = drawingPrompt ? ctx.store.listPromptBlocks() : [];

  /**
   * Replace every positive prompt with a freshly drawn one.
   *
   * The draw is made *once* and applied to each prompt field, rather than drawn
   * per field: a base-and-refiner workflow has two prompt inputs describing one
   * picture, and giving them different modifiers would pull the render in two
   * directions. Each field keeps its own typed text as the base.
   */
  /*
   * The phrases that go on everything, applied whether or not the draw is on.
   *
   * A quality tail or a house style is not variation — it is part of what you
   * always ask for, and having to re-tap it before every render is exactly the
   * tedium prompt blocks exist to remove.
   */
  const applyAlways = (base: ParamValues): ParamValues => {
    if (randomConfig.alwaysBlockIds.length === 0 || promptFields.length === 0) return base;
    const library = blocks.length > 0 ? blocks : ctx.store.listPromptBlocks();

    const next: ParamValues = { ...base };
    for (const field of promptFields) {
      const current = String(base[field.id] ?? field.defaultValue ?? '');
      next[field.id] = appendAlwaysBlocks(current, library, randomConfig);
    }
    return next;
  };

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

  /*
   * The collected instructions go in here, at submit time.
   *
   * Not when the form is filled: a system prompt is edited in one place and has
   * to reach every route into a generation — this form, the chat, endless mode —
   * without any of them re-saving anything. Read once per batch rather than per
   * item, because nothing draws or varies them.
   */
  const systemPrompts = ctx.store.listSystemPrompts();

  /*
   * And the model server the chat is talking to, for any llama-server node.
   *
   * Those nodes carry the address as a widget, so it is baked into the
   * workflow — fine until the server is a rented box, whose address changes
   * every time one is started. Following that by hand means opening every
   * workflow that mentions it and editing the same field again, when Latent
   * already knows where the server is: the chat is talking to it.
   *
   * Applied to the copy being submitted rather than to the stored graph, which
   * also keeps the token out of a file that holds widget values in plain text.
   */
  const active = ctx.store.getActiveConnection('llama');
  const modelServer: ModelServerTarget | null = active
    ? {
        url: active.url,
        authMode: active.authMode,
        username: active.username,
        secret: active.secret,
      }
    : null;

  /*
   * The node definitions, for deciding whether a picture may be unplugged.
   *
   * Fetched once for the whole batch and cached upstream. A ComfyUI that cannot
   * be reached gives nothing rather than failing the request: without the
   * definitions the switch still unplugs, and a workflow that turns out to need
   * the picture is refused by ComfyUI instead of by us — a worse message, but
   * only in the case where nothing was going to run anyway.
   */
  const objectInfo = await ctx.orchestrator.objectInfo().catch(() => ({}) as ObjectInfo);

  for (let i = 0; i < batchCount; i += 1) {
    let itemValues = applySystemPrompts(
      schema,
      applyAlways(drawingPrompt ? drawPrompts(values) : values),
      systemPrompts,
    );

    /*
     * Parameter variation, drawn per item like the prompt. Applied after the
     * prompt so a rule can never be overwritten by it, and before `applyParams`
     * so the drawn value is what actually reaches the graph.
     */
    if (drawingParams) {
      itemValues = { ...itemValues, ...drawRandomParams(schema, randomConfig.params) };
    }

    // Last, because a drawn value could have moved the picker: the preset-chat
    // node rejects an `active` that names no live slot, and it does so after
    // the job has been queued.
    itemValues = applyPresetActive(schema, itemValues);

    // Re-derived per item: with a drawn prompt the title differs each time, and
    // the title is what the gallery and queue show.
    const title = deriveTitle(schema, itemValues, detail.name);

    const { workflow, seeds } = applyParams(detail.graph, schema, itemValues, {
      randomizeSeeds: body.randomizeSeeds ?? false,
      lockedSeedFields: body.lockedSeedFields ?? [],
    });

    /*
     * The model server goes into the graph, not into the values: `submitted`
     * is recorded in the gallery and kept as the workflow's last values, and a
     * token has no business in either.
     */
    const graph = applyModelServer(workflow, modelServer);

    /*
     * Pictures the form switched off never reach ComfyUI.
     *
     * After the values are applied, because that is when the switches are
     * known, and before submitting, because the point is that the link is not
     * in the graph that goes over the wire.
     */
    const withoutPictures = applyImageOff(graph, imageOffNodes(schema, itemValues), objectInfo);
    if (withoutPictures.error) {
      // The same shape as a submit failure: whatever was already queued stays
      // queued, and the message says why the rest stopped.
      return { generationIds, promptIds, error: withoutPictures.error };
    }

    // Built per item, not once: each item in a batch gets its own seed, and
    // the seed is often the only thing distinguishing two queued jobs.
    const submitted = { ...itemValues, ...seeds };

    try {
      const result = await ctx.orchestrator.submit({
        graph: withoutPictures.workflow,
        workflowId: detail.id,
        workflowName: detail.name,
        title,
        values: submitted,
        seeds,
        params: buildParamSummary(schema, submitted),
        /*
         * Which picture this edit started from, settled here rather than in the
         * gallery. The answer comes from a node's title, and by the time
         * anybody opens the result the workflow may have been re-titled or
         * deleted — the same reason `params` is recorded at submit time.
         */
        origins: findEditOrigins(schema, submitted),
      });
      generationIds.push(result.generationId);
      promptIds.push(result.promptId);
    } catch (error) {
      // Partial success is real: earlier items in the batch are already
      // queued, so report them alongside the failure rather than pretending
      // nothing happened.
      const message = describeSubmitError(error);
      if (generationIds.length > 0) {
        return {
          generationIds,
          promptIds,
          error: `Queued ${generationIds.length} of ${batchCount}. ${message}`,
        };
      }
      return { generationIds, promptIds, error: message };
    }
  }

  return { generationIds, promptIds };
}

export function registerGenerateRoutes(app: FastifyInstance, ctx: AppContext): void {
  /**
   * Endless generation: the settings the next run will use.
   *
   * `PUT` rather than `POST` because it is a setting, not an action — sending
   * it twice leaves the same state, and while it is running it queues nothing
   * by itself. The runner does that, when the queue drains.
   */
  app.get('/api/generate/endless', async () => ctx.endless.state);

  app.put<{ Body: GenerateRequest & { enabled?: boolean } }>(
    '/api/generate/endless',
    async (request, reply) => {
      const body = request.body ?? ({} as GenerateRequest & { enabled?: boolean });
      const enabled = body.enabled !== false;

      if (enabled && !ctx.store.getWorkflow(body.workflowId)) {
        return reply.code(404).send({ error: 'Workflow not found' });
      }
      const { enabled: _ignored, ...setup } = body;
      return ctx.endless.set(setup, enabled);
    },
  );

  app.post<{ Body: GenerateRequest }>('/api/generate', async (request, reply) => {
    const body = request.body ?? ({} as GenerateRequest);
    const detail = ctx.store.getWorkflow(body.workflowId);
    if (!detail) return reply.code(404).send({ error: 'Workflow not found' });

    /*
     * Make room first, when that is what Generate is set to do.
     *
     * Before submitting, not after: clearing afterwards would race the new
     * items into the same queue it is about to empty. `replace` also stops the
     * one in flight, because waiting out a picture you already know is wrong is
     * exactly the complaint this setting answers.
     */
    const policy = ctx.store.getSettings().queuePolicy;
    if (policy !== 'append') {
      try {
        await ctx.orchestrator.clearQueue();
        if (policy === 'replace') await ctx.orchestrator.interrupt();
      } catch (error) {
        app.log.warn({ err: error }, 'Could not clear the queue before generating');
      }
    }

    const outcome = await runBatch(ctx, detail, body);

    if (outcome.error) {
      // Partial success is real: earlier items are already queued, so report
      // them alongside the failure rather than pretending nothing happened.
      if (outcome.generationIds.length > 0) return reply.code(207).send(outcome);
      return reply.code(502).send({ error: outcome.error });
    }

    const response: GenerateResponse = {
      generationIds: outcome.generationIds,
      promptIds: outcome.promptIds,
    };
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
