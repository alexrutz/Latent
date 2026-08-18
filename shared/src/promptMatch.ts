import type { ApiWorkflow, WidgetValue } from './comfyTypes.js';
import type { ParamSchema, ParamValues } from './paramTypes.js';

export interface WorkflowCandidate {
  id: string;
  name: string;
  graph: ApiWorkflow;
  schema: ParamSchema;
}

export interface PromptMatch {
  workflowId: string;
  workflowName: string;
  values: ParamValues;
  /** Share of the workflow's nodes the image's graph agrees with, 0..1. */
  score: number;
}

/** Below this the graphs are simply different workflows. */
const MIN_SCORE = 0.8;

/**
 * Work out which stored workflow produced an image, from the graph in its
 * metadata, and read the settings back out.
 *
 * ComfyUI writes the API-format graph into every PNG it saves, which is enough
 * to answer "make another one like this" for a picture Latent never generated —
 * an image imported from an output folder is otherwise a dead end, no matter how
 * carefully the workflow that made it was set up here.
 *
 * Matching is by node id *and* class type. Ids are stable within a workflow and
 * survive an export, and requiring the class to agree stops a graph that happens
 * to number its nodes the same way from being mistaken for this one. Extra nodes
 * in the image's graph are fine: it may have been saved from a larger workflow
 * that this one is a subset of.
 */
export function matchPrompt(
  prompt: ApiWorkflow,
  candidates: WorkflowCandidate[],
): PromptMatch | null {
  let best: PromptMatch | null = null;

  for (const candidate of candidates) {
    const ids = Object.keys(candidate.graph);
    if (ids.length === 0) continue;

    let agreed = 0;
    for (const id of ids) {
      if (prompt[id]?.class_type === candidate.graph[id]?.class_type) agreed += 1;
    }

    const score = agreed / ids.length;
    if (score < MIN_SCORE) continue;
    if (best && score <= best.score) continue;

    best = {
      workflowId: candidate.id,
      workflowName: candidate.name,
      score,
      values: valuesFromPrompt(candidate.schema, prompt),
    };
  }

  return best;
}

/**
 * Read a schema's fields out of a graph.
 *
 * Only literal widget values: an input wired to another node is `[nodeId, slot]`
 * in the API format, and putting that in a form field would show `4,0` where a
 * checkpoint name belongs.
 */
export function valuesFromPrompt(schema: ParamSchema, prompt: ApiWorkflow): ParamValues {
  const values: ParamValues = {};

  for (const field of schema.fields) {
    const node = prompt[field.nodeId];
    if (!node) continue;
    const value = node.inputs?.[field.inputName];
    if (isWidgetValue(value)) values[field.id] = value;
  }

  return values;
}

function isWidgetValue(value: unknown): value is WidgetValue {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

/**
 * The graph an image carries, if it carries one.
 *
 * ComfyUI stores it under `prompt`; some forks and custom savers use different
 * keys, so the value is validated by shape rather than trusted by name.
 */
export function parsePromptMetadata(text: Record<string, string>): ApiWorkflow | null {
  for (const key of ['prompt', 'Prompt', 'api_prompt']) {
    const raw = text[key];
    if (!raw) continue;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isApiWorkflow(parsed)) return parsed;
    } catch {
      // Not JSON, or not ours.
    }
  }
  return null;
}

function isApiWorkflow(value: unknown): value is ApiWorkflow {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const entries = Object.values(value as Record<string, unknown>);
  if (entries.length === 0) return false;

  return entries.every(
    (entry) =>
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as { class_type?: unknown }).class_type === 'string',
  );
}
