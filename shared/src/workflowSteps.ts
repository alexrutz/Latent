import { inputSlots } from './bypass.js';
import type { ApiWorkflow, NodeDef, ObjectInfo } from './comfyTypes.js';
import { isNodeLink } from './paramSchema.js';

/**
 * A workflow as the order it runs in.
 *
 * Every node goes into a step one past the latest of the nodes it reads from,
 * so step one is what needs nothing (loaders, empty latents), the last is what
 * saves, and everything a node needs has run in an earlier step. Read left to
 * right, that is the run; read top to bottom, a step is what could happen at
 * the same time. Pure, so it can be tested without a browser; the drawing is
 * `WorkflowSteps` in the web app.
 */

/** Types a value is typed into rather than wired, as the editor treats them. */
const WIDGET_TYPES = new Set(['INT', 'FLOAT', 'STRING', 'BOOLEAN', 'COMBO']);

export interface StepInput {
  name: string;
  type: string;
  /** What it is wired from. Absent for a socket left empty. */
  from?: { id: string; title: string; output: string };
}

export interface StepValue {
  name: string;
  value: string;
}

export interface StepNode {
  id: string;
  title: string;
  classType: string;
  /** Whether ComfyUI described this node. */
  known: boolean;
  inputs: StepInput[];
  values: StepValue[];
  /** The nodes that read from this one. */
  feeds: { id: string; title: string }[];
}

export interface WorkflowSteps {
  /** In run order; each step's nodes top to bottom. */
  steps: StepNode[][];
}

/** A value as it reads on one line of a card. */
function formatValue(value: unknown): string {
  if (typeof value === 'number') {
    return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)));
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function nodeTitle(workflow: ApiWorkflow, defs: ObjectInfo, id: string): string {
  const node = workflow[id];
  return node?._meta?.title || defs[node?.class_type ?? '']?.display_name || node?.class_type || id;
}

function outputName(def: NodeDef | undefined, slot: number): string {
  const named = def?.output_name?.[slot];
  if (named) return named;
  const type = def?.output?.[slot];
  if (type !== undefined) return Array.isArray(type) ? 'COMBO' : String(type);
  return `output ${slot + 1}`;
}

export function workflowSteps(workflow: ApiWorkflow, defs: ObjectInfo = {}): WorkflowSteps {
  const ids = Object.keys(workflow)
    .filter((id) => workflow[id]?.class_type)
    .sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
  const present = new Set(ids);

  const sources = new Map<string, string[]>();
  const feeds = new Map<string, string[]>();
  const nodes = new Map<string, StepNode>();

  for (const id of ids) {
    const node = workflow[id]!;
    const def = defs[node.class_type];
    const inputs: StepInput[] = [];
    const values: StepValue[] = [];
    const seen = new Set<string>();

    const place = (name: string, type: string) => {
      seen.add(name);
      const value = node.inputs?.[name];
      if (isNodeLink(value)) {
        const from = String(value[0]);
        if (present.has(from)) {
          sources.set(id, [...(sources.get(id) ?? []), from]);
          if (!(feeds.get(from) ?? []).includes(id))
            feeds.set(from, [...(feeds.get(from) ?? []), id]);
        }
        inputs.push({
          name,
          type,
          from: {
            id: from,
            title: nodeTitle(workflow, defs, from),
            output: outputName(defs[workflow[from]?.class_type ?? ''], Number(value[1])),
          },
        });
      } else if (value !== undefined && (WIDGET_TYPES.has(type) || type === '*')) {
        values.push({ name, value: formatValue(value) });
      } else if (value === undefined && !WIDGET_TYPES.has(type) && type !== '*') {
        inputs.push({ name, type });
      }
    };
    if (def) for (const slot of inputSlots(def)) place(slot.name, slot.type);
    for (const name of Object.keys(node.inputs ?? {})) if (!seen.has(name)) place(name, '*');

    nodes.set(id, {
      id,
      title: nodeTitle(workflow, defs, id),
      classType: node.class_type,
      known: def !== undefined,
      inputs,
      values,
      feeds: [],
    });
  }
  for (const [id, node] of nodes) {
    node.feeds = (feeds.get(id) ?? []).map((target) => ({
      id: target,
      title: nodes.get(target)!.title,
    }));
  }

  // The step: one past the latest source. A cycle (never valid in ComfyUI) is
  // cut where it is found rather than recursed into forever.
  const step = new Map<string, number>();
  const visiting = new Set<string>();
  const stepOf = (id: string): number => {
    const known = step.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const from = sources.get(id) ?? [];
    const value = from.length === 0 ? 0 : Math.max(...from.map(stepOf)) + 1;
    visiting.delete(id);
    step.set(id, value);
    return value;
  };
  ids.forEach(stepOf);

  const count = ids.length === 0 ? 0 : Math.max(...ids.map((id) => step.get(id)!)) + 1;
  const columns: string[][] = Array.from({ length: count }, () => []);
  for (const id of ids) columns[step.get(id)!]!.push(id);

  /*
   * Within a step, a node goes level with what it reads from — the average
   * position of its sources — so related nodes sit at the same height across
   * steps and the eye can follow a chain sideways. The first step is then put
   * in the order of what reads it, and the rest settled again.
   */
  const position = new Map<string, number>();
  const place = (column: string[]) => column.forEach((id, index) => position.set(id, index));
  const average = (values: number[]) =>
    values.length === 0
      ? Number.POSITIVE_INFINITY
      : values.reduce((a, b) => a + b, 0) / values.length;
  const settle = (column: string[], related: (id: string) => string[]) => {
    const keyed = column.map((id, index) => ({
      id,
      key: average(
        related(id)
          .filter((other) => position.has(other))
          .map((other) => position.get(other)!),
      ),
      index,
    }));
    keyed.sort((a, b) => a.key - b.key || a.index - b.index);
    column.splice(0, column.length, ...keyed.map((entry) => entry.id));
    place(column);
  };
  place(columns[0] ?? []);
  const forward = () => {
    for (let index = 1; index < count; index += 1)
      settle(columns[index]!, (id) => sources.get(id) ?? []);
  };
  forward();
  if (count > 1) {
    settle(columns[0]!, (id) => feeds.get(id) ?? []);
    forward();
  }

  return { steps: columns.map((column) => column.map((id) => nodes.get(id)!)) };
}

/**
 * Node definitions trimmed to what the view and the bypass check need.
 *
 * A checkpoint loader's definition lists every checkpoint on the machine and a
 * LoRA loader's every LoRA — megabytes, on a big install, for a picker this
 * view never shows. The list becomes empty, which still reads as a combo.
 */
export function trimDefinitions(workflow: ApiWorkflow, objectInfo: ObjectInfo): ObjectInfo {
  type Group = NonNullable<NodeDef['input']>['required'];
  const trimSpec = (spec: unknown): unknown => {
    if (!Array.isArray(spec)) return spec;
    // The old form: the options are the type.
    if (Array.isArray(spec[0])) return [[], ...spec.slice(1)];
    // The newer form: `["COMBO", { options: [...] }]`.
    const config = spec[1] as Record<string, unknown> | undefined;
    if (spec[0] === 'COMBO' && config && 'options' in config) {
      return [spec[0], { ...config, options: [] }, ...spec.slice(2)];
    }
    return spec;
  };
  const trimGroup = (group: Group): Group =>
    group
      ? (Object.fromEntries(
          Object.entries(group).map(([name, spec]) => [name, trimSpec(spec)]),
        ) as Group)
      : undefined;

  const out: ObjectInfo = {};
  for (const node of Object.values(workflow)) {
    const def = objectInfo[node?.class_type ?? ''];
    if (!def || out[node.class_type]) continue;
    out[node.class_type] = {
      input: { required: trimGroup(def.input?.required), optional: trimGroup(def.input?.optional) },
      input_order: def.input_order,
      output: def.output,
      output_name: def.output_name,
      output_node: def.output_node,
      display_name: def.display_name,
    };
  }
  return out;
}
