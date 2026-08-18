import type { ParamSchema, ParamValues } from './paramTypes.js';

/**
 * The multi-preset chat node, as a form rather than as a graph node.
 *
 * `LlamaServerPresetChat` from [comfyllama](https://github.com/alexrutz/comfyllama)
 * carries six system prompts in one node and switches between them with an
 * `active` dropdown. Two things about it are decided by *values* rather than by
 * the node definition, which is all `/object_info` — and therefore all a form
 * built from it — can see:
 *
 * - The dropdown lists whatever the slots were renamed to, not `Preset 1…6`.
 *   In ComfyUI a small web extension rewrites the list; there is no extension
 *   here, so a picker built from the definition offers names that no longer
 *   mean anything.
 * - `slot_count` decides how many slots exist. The rest are hidden, and
 *   choosing one of them is an error the node raises by name.
 *
 * So the schema is reshaped against the values in hand, on both sides: the form
 * shows the right choices, and the submit path sees the same labels — which is
 * what lets a saved system prompt reach a slot named after it, through the
 * ordinary name matching rather than through a second mechanism.
 */

export const PRESET_CHAT_CLASS = 'LlamaServerPresetChat';

/** As many system prompts as the node has room for. */
export const PRESET_MAX_SLOTS = 6;

/** The choice that hands the prompt through without asking the model. */
export const PRESET_PASSTHROUGH = 'passthrough';

/** What the node accepts as "don't run a system prompt at all". */
const PASSTHROUGH_ALIASES = new Set([PRESET_PASSTHROUGH, 'none', 'off', 'bypass', 'direct']);

/** What a slot is called when it has not been renamed. */
export function defaultSlotName(index: number): string {
  return `Preset ${index}`;
}

/** Read a node's value, falling back to what the workflow was exported with. */
function valueOf(
  schema: ParamSchema,
  values: ParamValues,
  nodeId: string,
  inputName: string,
): string {
  const id = `${nodeId}.${inputName}`;
  const current = values[id];
  if (current !== undefined && current !== null) return String(current);

  const field = schema.fields.find((candidate) => candidate.id === id);
  return field?.defaultValue === undefined || field.defaultValue === null
    ? ''
    : String(field.defaultValue);
}

/** How many slots this node is offering, clamped the way the node clamps it. */
export function slotCountOf(schema: ParamSchema, values: ParamValues, nodeId: string): number {
  const raw = Number(valueOf(schema, values, nodeId, 'slot_count'));
  if (!Number.isFinite(raw)) return 1;
  return Math.max(1, Math.min(Math.floor(raw), PRESET_MAX_SLOTS));
}

/** The names of the slots in use, in order, blank ones falling back. */
export function slotNames(schema: ParamSchema, values: ParamValues, nodeId: string): string[] {
  const count = slotCountOf(schema, values, nodeId);
  return Array.from({ length: count }, (_, at) => {
    const name = valueOf(schema, values, nodeId, `name_${at + 1}`).trim();
    return name || defaultSlotName(at + 1);
  });
}

/** True while this field's label is still the one derived from its input name. */
function unnamed(label: string, inputName: string): boolean {
  const derived = inputName.replace(/[_-]+/g, ' ').trim().toLowerCase();
  return label.trim().toLowerCase() === derived;
}

/** Every preset-chat node in the schema, so a caller can walk them. */
export function presetChatNodeIds(schema: ParamSchema): string[] {
  return [
    ...new Set(
      schema.fields.filter((field) => field.classType === PRESET_CHAT_CLASS).map((f) => f.nodeId),
    ),
  ];
}

/**
 * Reshape a schema for the preset-chat nodes in it.
 *
 * Returns the schema untouched when there are none, so callers can use the
 * result unconditionally.
 */
export function applyPresetChat(schema: ParamSchema, values: ParamValues): ParamSchema {
  const nodeIds = presetChatNodeIds(schema);
  if (nodeIds.length === 0) return schema;

  const perNode = new Map(
    nodeIds.map((nodeId) => [
      nodeId,
      { names: slotNames(schema, values, nodeId), count: slotCountOf(schema, values, nodeId) },
    ]),
  );

  const fields = schema.fields.map((field) => {
    if (field.classType !== PRESET_CHAT_CLASS) return field;
    const node = perNode.get(field.nodeId);
    if (!node) return field;

    if (field.inputName === 'active') {
      return { ...field, options: [PRESET_PASSTHROUGH, ...node.names], numericOptions: false };
    }

    const slot = /^(name|system|model)_(\d+)$/.exec(field.inputName);
    if (!slot) return field;

    const index = Number(slot[2]);
    // Above `slot_count` the node ignores them, and the ComfyUI extension hides
    // them. Twelve dead text boxes is most of a phone screen.
    if (index > node.count) return { ...field, hidden: true };

    /*
     * The system prompt is labelled with the slot's own name. It reads the way
     * the node does — and it means a saved system prompt called "Rewrite"
     * fills the slot called "Rewrite", through the same name matching every
     * other text field uses. An explicit rename in the form editor wins.
     *
     * Only the system prompt. `model_N` is a text field too, so naming it
     * after the slot would put a saved system prompt called "Rewrite" into the
     * slot's *model* box — the matching cannot tell the two apart, and the one
     * that should win is obvious.
     */
    if (slot[1] === 'system' && unnamed(field.label, field.inputName)) {
      return { ...field, label: node.names[index - 1] ?? field.label };
    }
    return field;
  });

  return { ...schema, fields };
}

/**
 * The choice to submit, given what the picker was left on.
 *
 * A slot that has been renamed, or put out of reach by a smaller `slot_count`,
 * leaves the stored value naming something that no longer exists — and the node
 * answers that with an error rather than a picture. Falling back to
 * `passthrough` is the one choice that always means something.
 */
export function resolveActive(
  schema: ParamSchema,
  values: ParamValues,
  nodeId: string,
  active: string,
): string {
  const label = (active ?? '').trim();
  if (label === '' || PASSTHROUGH_ALIASES.has(label.toLowerCase())) return PRESET_PASSTHROUGH;

  const names = slotNames(schema, values, nodeId);
  const match = names.find((name) => name.toLowerCase() === label.toLowerCase());
  if (match) return match;

  /*
   * A trailing number still resolves, which is what the node itself does — it
   * is how `Preset 3` keeps working when the slots have been renamed but the
   * stored value has not caught up.
   */
  const digits = /(\d+)\s*$/.exec(label);
  const at = digits ? Number(digits[1]) : 0;
  if (at >= 1 && at <= names.length) return names[at - 1]!;

  return PRESET_PASSTHROUGH;
}

/**
 * Settle every preset-chat node's `active` value against its slot names.
 *
 * Run on the way to the graph, not while typing: this is the step that turns a
 * picker left on a slot that has since been renamed into something the node
 * will accept, instead of a run that fails after the queue has taken it.
 * Returns the same object when nothing needed settling.
 */
export function applyPresetActive(schema: ParamSchema, values: ParamValues): ParamValues {
  const nodeIds = presetChatNodeIds(schema);
  if (nodeIds.length === 0) return values;

  let next: ParamValues | null = null;
  for (const nodeId of nodeIds) {
    const id = `${nodeId}.active`;
    if (!schema.fields.some((field) => field.id === id)) continue;

    const current = valueOf(schema, values, nodeId, 'active');
    const resolved = resolveActive(schema, values, nodeId, current);
    if (resolved === current) continue;
    next ??= { ...values };
    next[id] = resolved;
  }
  return next ?? values;
}
