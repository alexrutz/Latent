import type { ParamValues } from '@latent/shared';

import { queueBatch } from '../routes/generate.js';
import type { AppContext } from '../routes/context.js';

/**
 * Queueing a prompt the chat produced.
 *
 * This used to happen in the browser, and it was the single most fragile thing
 * about the module. Accepting a proposal was three separate acts — resolve a
 * workflow, POST to `/api/generate`, POST the decision back to the chat — and a
 * tab frozen between the second and the third left the conversation holding a
 * proposal with no answer and a render nothing was waiting for. Most chat
 * templates refuse to continue from a tool call with no result, so the
 * conversation was simply finished.
 *
 * One act now, on the server: resolve, queue, record. Either all of it happened
 * or none of it did, and nothing in between depends on a page still being
 * alive.
 */

export interface QueuedPrompt {
  generationId: string | null;
  error: string | null;
}

/**
 * Which workflow a chat prompt runs through, and with what values.
 *
 * Three sources, in order of how specific they are. A workflow named on the
 * decision itself wins — that is the picker in the dialog, and it means "this
 * one, this time". Then the chat's own generation settings, which is what
 * Settings → Chat is for. Then whatever the workflow was last run with, which
 * is the honest default: it is what the Generate screen would do.
 *
 * Not the browser's form draft, which is what it used to be. That made the
 * chat's output depend on a screen nobody had opened, and it is not something
 * the server can see at all now that the server is the one queueing.
 */
export function resolveTarget(
  ctx: AppContext,
  forced?: string,
): { workflowId: string; values: ParamValues } | null {
  const settings = ctx.store.getSettings().chat.generation;
  const visible = ctx.store.listWorkflows().filter((workflow) => workflow.visible);
  if (visible.length === 0) return null;

  const wanted = forced || settings.workflowId || '';
  const id = wanted && visible.some((workflow) => workflow.id === wanted) ? wanted : visible[0]?.id;
  if (!id) return null;

  const detail = ctx.store.getWorkflow(id);
  if (!detail) return null;

  /*
   * The chat's stored values describe the graph they were set up for. Sending
   * them to a different one — because the dialog overrode the workflow, or
   * because the configured one has been deleted — would be filling in one
   * form's fields from another's.
   */
  const own = !forced && settings.workflowId !== '' && id === settings.workflowId;
  return {
    workflowId: id,
    values: own ? { ...detail.lastValues, ...settings.values } : { ...detail.lastValues },
  };
}

/**
 * Queue it exactly as the Generate screen would, and say what run it started.
 *
 * The same workflow, the same values, the same seed handling — accepting a
 * prompt here is not a different way of generating with different results. Only
 * the prompt fields are replaced.
 */
export async function queueChatPrompt(
  ctx: AppContext,
  prompt: string,
  options: { workflowId?: string; negativePrompt?: string } = {},
): Promise<QueuedPrompt> {
  const target = resolveTarget(ctx, options.workflowId);
  if (!target) {
    return {
      generationId: null,
      error: 'No workflow is switched on, so there is nothing to generate with.',
    };
  }

  const detail = ctx.store.getWorkflow(target.workflowId);
  if (!detail) return { generationId: null, error: 'That workflow is gone.' };

  const values = { ...target.values };
  for (const field of detail.schema.fields) {
    if (field.hidden) continue;
    if (field.role === 'prompt') values[field.id] = prompt;
    if (field.role === 'negative_prompt' && options.negativePrompt) {
      values[field.id] = options.negativePrompt;
    }
  }

  try {
    const queued = await queueBatch(ctx, {
      workflowId: target.workflowId,
      values,
      // A fresh seed every time, unless the workflow has none. A chat that
      // reproduced the same image for every accepted prompt would be a chat
      // whose pictures never changed.
      randomizeSeeds: true,
      lockedSeedFields: [],
      batchCount: 1,
    });

    if ('notFound' in queued) return { generationId: null, error: 'That workflow is gone.' };
    return {
      generationId: queued.generationIds[0] ?? null,
      error: queued.error ?? null,
    };
  } catch (cause) {
    return {
      generationId: null,
      error: cause instanceof Error ? cause.message : 'Could not queue that.',
    };
  }
}
