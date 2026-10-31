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
  const left = a.toLowerCase().split(',').map((part) => part.trim());
  const right = b.toLowerCase().split(',').map((part) => part.trim());
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
 * The nodes worth a Bypass switch.
 *
 * Those that can pass something through — an output that one of their own
 * inputs could stand in for — and whose output something actually reads. A
 * VAE decode turns a latent into a picture and has no picture to hand on, so
 * bypassing it could only break the graph; a LoRA loader hands its model and
 * clip straight on. And always the ones that were bypassed in the editor, so
 * they can be switched back on.
 */
export function bypassableNodes(workflow: ApiWorkflow, objectInfo: ObjectInfo): string[] {
  const consumed = new Map<string, Set<number>>();
  for (const node of Object.values(workflow)) {
    for (const value of Object.values(node?.inputs ?? {})) {
      if (!isNodeLink(value)) continue;
      const source = String(value[0]);
      if (!consumed.has(source)) consumed.set(source, new Set());
      consumed.get(source)!.add(Number(value[1]));
    }
  }

  const out: string[] = [];
  for (const [nodeId, node] of Object.entries(workflow)) {
    if (node?._meta?.bypassed) {
      out.push(nodeId);
      continue;
    }
    const definition = objectInfo[node?.class_type ?? ''];
    if (!definition) continue;
    const slots = consumed.get(nodeId);
    if (!slots) continue;
    const inputs = inputSlots(definition).filter((input) => input.type !== 'COMBO');
    const outputs = outputTypes(definition);
    const passes = [...slots].some((slot) => {
      const type = outputs[slot];
      return type !== undefined && inputs.some((input) => typesConnect(input.type, type) && type !== '*');
    });
    if (passes) out.push(nodeId);
  }
  return out.sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
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
    const definition = node ? objectInfo[node.class_type] : undefined;
    if (!node || !definition) return null;

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
      const wanted = typeOf(definition?.input?.required?.[name] ?? definition?.input?.optional?.[name]);
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

  const produces = Object.values(next).some((node) => objectInfo[node.class_type]?.output_node === true);
  const producedBefore = Object.values(workflow).some(
    (node) => objectInfo[node.class_type]?.output_node === true,
  );
  if (producedBefore && !produces) {
    return {
      workflow,
      error: 'With those nodes bypassed nothing is left that saves a picture. Switch one of them back on.',
    };
  }

  return { workflow: next };
}
