import type { ParamField, ParamSchema, ParamValues } from './paramTypes.js';
import type { SystemPrompt } from './apiTypes.js';

/**
 * Filling a workflow's text inputs from the collected system prompts.
 *
 * The instructions a workflow needs — how a captioner should describe a
 * picture, how an Ollama node should rewrite a prompt — used to live inside the
 * graph, where they are invisible and can only be changed by opening ComfyUI and
 * exporting the workflow again. This is the way out: name a system prompt after
 * the input it belongs in, and the text is put there when the job is submitted.
 *
 * Matching is by name, deliberately. An id would be exact and useless: the point
 * is that the same instructions reach the same field in five different
 * workflows, none of which know anything about each other, and a name is the
 * only thing they can agree on.
 */

/** Names compare without case or surrounding space; nothing else is normalised. */
function key(name: string): string {
  return name.trim().toLowerCase();
}

/** Text inputs are the only ones instructions could go in. */
export function acceptsSystemPrompt(field: ParamField): boolean {
  return field.control === 'text' || field.control === 'textarea';
}

/**
 * The prompt that belongs in this field, if any.
 *
 * Three names are tried, most specific first. The label is what the user sees
 * and can rename in the form editor, so it wins; the node's title is next,
 * because titling a node is how the same thing is said in ComfyUI; the raw input
 * name is the fallback that needs no setting up at all.
 */
export function matchSystemPrompt(
  field: ParamField,
  prompts: SystemPrompt[],
): SystemPrompt | null {
  if (!acceptsSystemPrompt(field)) return null;

  const byName = new Map(prompts.map((prompt) => [key(prompt.name), prompt]));
  for (const candidate of [field.label, field.nodeTitle, field.inputName]) {
    const found = byName.get(key(candidate ?? ''));
    if (found) return found;
  }
  return null;
}

/**
 * Every field a system prompt would fill, as a lookup for the form.
 *
 * The Generate screen uses this to say where a value is coming from instead of
 * offering a box whose contents are about to be replaced.
 */
export function systemPromptFields(
  schema: ParamSchema,
  prompts: SystemPrompt[],
): Record<string, SystemPrompt> {
  const out: Record<string, SystemPrompt> = {};
  if (prompts.length === 0) return out;

  for (const field of schema.fields) {
    const match = matchSystemPrompt(field, prompts);
    if (match) out[field.id] = match;
  }
  return out;
}

/**
 * Put the collected instructions into the values about to be submitted.
 *
 * Applied server-side, at submit time, so it holds for every route into a
 * generation — the form, the chat, endless mode — and so that editing a prompt
 * changes what the next run does without anything having to be re-saved. An
 * empty prompt is skipped rather than blanking the field: "I have not written
 * this yet" should leave the workflow's own default alone.
 */
export function applySystemPrompts(
  schema: ParamSchema,
  values: ParamValues,
  prompts: SystemPrompt[],
): ParamValues {
  if (prompts.length === 0) return values;

  let next: ParamValues | null = null;
  for (const field of schema.fields) {
    const match = matchSystemPrompt(field, prompts);
    if (!match || match.text.trim() === '') continue;
    if (values[field.id] === match.text) continue;
    next ??= { ...values };
    next[field.id] = match.text;
  }

  return next ?? values;
}
