import type { AppSettings, ParamValues, WorkflowDetail } from '@latent/shared';

import { api } from '../api/client';
import { useFormDrafts } from '../state/formDraft';

/**
 * Queueing a prompt the chat produced, in one place.
 *
 * It used to live only in the tool dialog, which was fine while every accepted
 * prompt went through a dialog somebody was looking at. It stopped being fine
 * the moment the app started accepting prompts on its own: a wandering run's
 * queueing happened inside a component, so switching to another tab unmounted
 * the screen, the dialog never mounted, and the loop stopped without a word.
 *
 * So the work is here, as functions. The dialog calls them with what its hooks
 * already know; the store calls them with what it fetches. Neither is the
 * authority on how a prompt is queued — this is.
 */

/** What a queued prompt needs to know beyond the words themselves. */
export interface QueueTarget {
  detail: WorkflowDetail;
  /**
   * The form's own state for that workflow, or the chat's stored values.
   *
   * Whichever it is, the point is the same: accepting a prompt here is not a
   * different way of generating with different results — same workflow, same
   * values, same seed handling, only the prompt fields replaced.
   */
  draft?: { values?: ParamValues; lockedSeeds?: string[]; batchCount?: number };
  /** True when the values came from the chat's settings rather than the form. */
  ownSettings: boolean;
}

/**
 * Which workflow an accepted prompt runs through, and with what.
 *
 * `forced` is a wandering run's own choice, which beats the chat's — the graph
 * you iterate with is often the slow one, and a run that goes all evening wants
 * the fast one. `null` means there is nothing to generate with at all.
 */
export async function resolveTarget(
  settings: AppSettings | null,
  forced?: string,
): Promise<QueueTarget | null> {
  const preferred = forced || settings?.chat.generation.workflowId || '';
  const workflows = await api.listWorkflows().catch(() => []);
  const visible = workflows.filter((workflow) => workflow.visible);
  if (visible.length === 0) return null;

  const fallback = localStorage.getItem('latent.lastWorkflowId') ?? visible[0]?.id ?? null;
  const wanted = preferred !== '' ? preferred : fallback;
  const id = wanted && visible.some((workflow) => workflow.id === wanted) ? wanted : visible[0]?.id;
  if (!id) return null;

  const detail = await api.getWorkflow(id);
  // Not for a forced workflow: the chat's stored values describe the graph it
  // was set up for, and this is a different one.
  const ownSettings = !forced && preferred !== '' && id === preferred;

  return {
    detail,
    ownSettings,
    draft: ownSettings
      ? {
          values: { ...detail.lastValues, ...settings?.chat.generation.values },
          lockedSeeds: [],
          batchCount: 1,
        }
      : useFormDrafts.getState().drafts[id],
  };
}

/**
 * Queue it exactly as the Generate screen would, and say what run it started.
 *
 * The first of the batch: the transcript shows the whole run from it.
 */
export async function queuePrompt(
  target: QueueTarget,
  prompt: string,
  negativePrompt?: string,
): Promise<string | null> {
  const { detail, draft, ownSettings } = target;

  const values = { ...draft?.values };
  for (const field of detail.schema.fields) {
    if (field.hidden) continue;
    if (field.role === 'prompt') values[field.id] = prompt;
    if (field.role === 'negative_prompt' && negativePrompt) values[field.id] = negativePrompt;
  }

  const lockedSeeds = draft?.lockedSeeds ?? [];
  const queued = await api.generate({
    workflowId: detail.id,
    values,
    randomizeSeeds: detail.schema.fields.some(
      (field) => field.role === 'seed' && !lockedSeeds.includes(field.id),
    ),
    lockedSeedFields: lockedSeeds,
    batchCount: draft?.batchCount ?? 1,
  });

  // Only when the form is what ran. Writing the chat's own values into the form
  // would change what Generate does next, which is not what was asked.
  if (!ownSettings) useFormDrafts.getState().patch(detail.id, { values });

  return queued.generationIds[0] ?? null;
}
