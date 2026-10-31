import type { ApiWorkflow, InputSpec, NodeDef, ObjectInfo } from './comfyTypes.js';
import { isNodeLink } from './paramSchema.js';
import type { ParamField, ParamSchema, ParamValues } from './paramTypes.js';

/**
 * Running a workflow with some of its nodes bypassed.
 *
 * What the editor's Bypass does, done here so a phone can do it: the node is
 * left out of the run, and whatever it fed is handed what *it* was fed
 * instead — the LoRA loader skipped and the model going straight on, the
 * upscaler skipped and the picture going straight to the save. The rule for
 * which input stands in for which output is ComfyUI's own (the frontend's
 * `ExecutableNodeDTO._getBypassSlotIndex`), copied rather than approximated,
 * because a graph that rewires differently from the editor is a graph that
 * renders something different from what the same switch in the editor would.
 *
 * Like the "Use this picture" switch, it is a field of the form: stored in a
 * draft, saved in a preset, arranged and hidden like any other — and applied
 * to the graph on its way to ComfyUI, never to the stored workflow.
 */

/** The input name of the synthetic switch, appended to a node id. */
export const BYPASS_INPUT = '__bypass';

export function bypassFieldId(nodeId: string): string {
  return `${nodeId}.${BYPASS_INPUT}`;
}

export function isBypassField(field: { inputName: string }): boolean {
  return field.inputName === BYPASS_INPUT;
}

/**
 * Whether one slot type may connect to another, as LiteGraph decides it.
 *
 * Empty and `*` match anything; otherwise case-insensitive, and a
 * comma-separated list matches when any of its members does.
 */
export function typesConnect(a: string, b: string): boolean {
  if (!a || !b || a === '*' || b === '*') return true;
  const left = a
    .toLowerCase()
    .split(',')
    .map((part) => part.trim());
  const right = b
    .toLowerCase()
    .split(',')
    .map((part) => part.trim());
  return left.some((type) => right.includes(type));
}

/** A declared type as a string: a combo's option list is a `COMBO`. */
function typeOf(spec: InputSpec | string | string[] | undefined): string {
  if (Array.isArray(spec)) {
    const head = spec[0];
    if (Array.isArray(head)) return 'COMBO';
    return typeof head === 'string' ? head : '*';
  }
  return typeof spec === 'string' ? spec : '*';
}

/** A node's inputs in slot order, with their types. */
function inputSlots(definition: NodeDef): { name: string; type: string }[] {
  const required = definition.input?.required ?? {};
  const optional = definition.input?.optional ?? {};
  const order = definition.input_order;
  const names = [
    ...(order?.required ?? Object.keys(required)),
    ...(order?.optional ?? Object.keys(optional)),
  ];
  return names.map((name) => ({ name, type: typeOf(required[name] ?? optional[name]) }));
}

/** The output types of a node, in slot order. */
function outputTypes(definition: NodeDef): string[] {
  return (definition.output ?? []).map((type) => (Array.isArray(type) ? 'COMBO' : String(type)));
}

/**
 * Which input of a bypassed node stands in for one of its outputs.
 *
 * ComfyUI's rule, in its order: anything goes to the same slot (or the first);
 * otherwise the input in the same position if it fits both ways, then the
 * first input of exactly the wanted type, then the first that fits both ways.
 * `-1` when none fits, which leaves whatever it fed with nothing.
 */
export function bypassSlotIndex(
  inputs: { type: string }[],
  slot: number,
  outputType: string,
  wanted: string,
): number {
  if (wanted === '*' || wanted === '') return inputs.length > slot ? slot : 0;
  const opposite = inputs[slot];
  if (opposite && typesConnect(opposite.type, outputType) && typesConnect(opposite.type, wanted)) {
    return slot;
  }
  const exact = inputs.findIndex((input) => input.type === wanted);
  if (exact !== -1) return exact;
  return inputs.findIndex(
    (input) => typesConnect(input.type, outputType) && typesConnect(input.type, wanted),
  );
}

/**
 * The nodes that get a Bypass switch: all of them, as in ComfyUI's editor.
 *
 * It used to be only those that could pass something through, which left a
 * VAE decode, a save or a preview — anything whose output no input of its own
 * could stand in for — with no switch at all, and so no way to do from here
 * what the editor does to any node. Whether a particular bypass leaves the
 * graph runnable is `applyBypass`'s question, answered when it is used, with a
 * sentence naming the switch.
 *
 * `objectInfo` is no longer needed and is kept so callers need not change.
 */
export function bypassableNodes(workflow: ApiWorkflow, _objectInfo: ObjectInfo = {}): string[] {
  return Object.keys(workflow)
    .filter((nodeId) => workflow[nodeId]?.class_type)
    .sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
}

/**
 * The same switches, added to a schema stored before every node had one.
 *
 * Applied whenever a workflow is read, so a form saved by an older version
 * gains its switches without a rescan. A switch already there — with whatever
 * the form editor did to it — is left exactly as it is; a missing one goes
 * first among its node's advanced settings, or after everything for a node
 * that has none. Orders are fractional rather than renumbered, so nothing
 * else on the form moves.
 */
export function withBypassSwitches(schema: ParamSchema, workflow: ApiWorkflow): ParamSchema {
  const have = new Set(schema.fields.filter(isBypassField).map((field) => field.nodeId));
  const missing = bypassableNodes(workflow).filter((nodeId) => !have.has(nodeId));
  if (missing.length === 0) return schema;

  const advanced = schema.fields.filter((field) => field.group === 'advanced');
  let tail = advanced.reduce((max, field) => Math.max(max, field.order), -1);
  const added = missing.map((nodeId) => {
    const node = workflow[nodeId]!;
    const own = advanced.filter((field) => field.nodeId === nodeId);
    const order = own.length > 0 ? Math.min(...own.map((field) => field.order)) - 0.5 : ++tail;
    const title = node._meta?.title || own[0]?.nodeTitle || node.class_type || nodeId;
    return bypassField(nodeId, title, node.class_type, node._meta?.bypassed === true, order);
  });
  return { ...schema, fields: [...schema.fields, ...added] };
}

/** The switch, as a field of the form. */
export function bypassField(
  nodeId: string,
  nodeTitle: string,
  classType: string,
  bypassed: boolean,
  order: number,
): ParamField {
  return {
    id: bypassFieldId(nodeId),
    nodeId,
    inputName: BYPASS_INPUT,
    classType,
    nodeTitle,
    label: 'Bypass',
    role: 'other',
    control: 'boolean',
    // Off, unless the node was bypassed in the editor when it was imported.
    defaultValue: bypassed,
    group: 'advanced',
    order,
    hidden: false,
    unknownNodeType: false,
  };
}

/** The nodes a set of form values has bypassed. Absent means the default. */
export function bypassedNodes(schema: ParamSchema, values: ParamValues): string[] {
  return schema.fields
    .filter((field) => isBypassField(field) && (values[field.id] ?? field.defaultValue) === true)
    .map((field) => field.nodeId);
}

export interface BypassResult {
  workflow: ApiWorkflow;
  /** Why it could not be done, said in terms of the switch that caused it. */
  error?: string;
}

/**
 * Cut the bypassed nodes out of a graph on its way to ComfyUI, rewiring
 * around them.
 *
 * Each input that read from a bypassed node reads from what that node was
 * given instead, through any number of bypassed nodes in a row. Where the
 * stand-in is a value rather than a link — a widget, not a socket — the value
 * itself is passed, as the editor does. Where nothing fits, the input is left
 * unconnected; if the node needs it, that is said here, naming the switch,
 * rather than left to ComfyUI's validation error about an input.
 */
export function applyBypass(
  workflow: ApiWorkflow,
  bypassedIds: Iterable<string>,
  objectInfo: ObjectInfo = {},
): BypassResult {
  const bypassed = new Set([...bypassedIds].map(String).filter((id) => id in workflow));
  if (bypassed.size === 0) return { workflow };

  type Resolved = { link: [string, number] } | { value: unknown } | null;

  const resolve = (nodeId: string, slot: number, wanted: string, seen: Set<string>): Resolved => {
    if (!bypassed.has(nodeId)) return { link: [nodeId, slot] };
    if (seen.has(nodeId)) return null;
    const node = workflow[nodeId];
    if (!node) return null;
    const definition = objectInfo[node.class_type];
    if (!definition) {
      /*
       * A node ComfyUI does not describe — a custom node that is not
       * installed, or definitions that could not be fetched. Without types,
       * the link in the same position stands in, or the first one: what the
       * editor's rule comes to for a node whose inputs and outputs line up,
       * which pass-through nodes nearly always do.
       */
      const links = Object.values(node.inputs ?? {}).filter(isNodeLink);
      const link = links[slot] ?? links[0];
      if (!link) return null;
      return resolve(String(link[0]), Number(link[1]), wanted, new Set([...seen, nodeId]));
    }

    const inputs = inputSlots(definition);
    const index = bypassSlotIndex(inputs, slot, outputTypes(definition)[slot] ?? '*', wanted);
    const input = inputs[index];
    if (!input) return null;
    const value = node.inputs?.[input.name];
    if (isNodeLink(value)) {
      return resolve(String(value[0]), Number(value[1]), wanted, new Set([...seen, nodeId]));
    }
    return value === undefined ? null : { value };
  };

  const next: ApiWorkflow = structuredClone(workflow);
  for (const [nodeId, node] of Object.entries(next)) {
    if (bypassed.has(nodeId) || !node?.inputs) continue;
    const definition = objectInfo[node.class_type];
    for (const [name, value] of Object.entries(node.inputs)) {
      if (!isNodeLink(value) || !bypassed.has(String(value[0]))) continue;
      const wanted = typeOf(
        definition?.input?.required?.[name] ?? definition?.input?.optional?.[name],
      );
      const resolved = resolve(String(value[0]), Number(value[1]), wanted, new Set());
      if (resolved && 'link' in resolved) node.inputs[name] = resolved.link;
      else if (resolved) node.inputs[name] = resolved.value;
      else {
        delete node.inputs[name];
        if (definition?.input?.required && name in definition.input.required) {
          const skipped = workflow[String(value[0])];
          const title = skipped?._meta?.title || skipped?.class_type || String(value[0]);
          const consumer = node._meta?.title || node.class_type;
          return {
            workflow,
            error:
              `Bypassing "${title}" leaves ${consumer} without its '${name}': nothing it was given ` +
              'can stand in for it. Switch the bypass off, or bypass the node after it as well.',
          };
        }
      }
    }
  }

  for (const id of bypassed) delete next[id];

  const produces = Object.values(next).some(
    (node) => objectInfo[node.class_type]?.output_node === true,
  );
  const producedBefore = Object.values(workflow).some(
    (node) => objectInfo[node.class_type]?.output_node === true,
  );
  if (producedBefore && !produces) {
    return {
      workflow,
      error:
        'With those nodes bypassed nothing is left that saves a picture. Switch one of them back on.',
    };
  }

  return { workflow: next };
}
