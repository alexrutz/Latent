import { inputSlots, typeOf } from './bypass.js';
import type { ApiWorkflow, NodeDef, ObjectInfo } from './comfyTypes.js';
import { isNodeLink } from './paramSchema.js';

/**
 * A workflow drawn the way ComfyUI's editor draws it.
 *
 * An API-format graph has no positions — the editor's layout is the one thing
 * the export throws away — so this lays the nodes out itself: left to right in
 * the order data flows, each node as the editor shows it, with its sockets down
 * the sides and its widgets underneath. Pure, so the arithmetic can be tested
 * without a browser; the drawing is `WorkflowGraph` in the web app.
 */

/** Sizes in the editor's own units, so a node here is the shape it is there. */
export const GRAPH_METRICS = {
  title: 30,
  slot: 20,
  widget: 22,
  pad: 8,
  gapX: 70,
  gapY: 28,
  minWidth: 190,
  maxWidth: 340,
} as const;

/** Types a value can be typed into rather than wired, as the editor treats them. */
const WIDGET_TYPES = new Set(['INT', 'FLOAT', 'STRING', 'BOOLEAN', 'COMBO']);

/** The dark palette's socket colours (ComfyUI_frontend `palettes/dark.json`). */
export const SLOT_COLORS: Record<string, string> = {
  CLIP: '#FFD500',
  CLIP_VISION: '#A8DADC',
  CLIP_VISION_OUTPUT: '#ad7452',
  CONDITIONING: '#FFA931',
  CONTROL_NET: '#6EE7B7',
  IMAGE: '#64B5F6',
  LATENT: '#FF9CF9',
  MASK: '#81C784',
  MODEL: '#B39DDB',
  STYLE_MODEL: '#C2FFAE',
  VAE: '#FF6E6E',
  NOISE: '#B0B0B0',
  GUIDER: '#66FFFF',
  SAMPLER: '#ECB4B4',
  SIGMAS: '#CDFFCD',
  TAESD: '#DCC274',
};

/** The editor's colour for a link of no particular type. */
export const DEFAULT_LINK_COLOR = '#9A9';

export function slotColor(type: string): string {
  return SLOT_COLORS[type.toUpperCase()] ?? DEFAULT_LINK_COLOR;
}

export interface GraphSlot {
  name: string;
  type: string;
}

export interface GraphInput extends GraphSlot {
  /** Where it is wired from, when it is wired. */
  link?: { from: string; slot: number };
}

export interface GraphWidget {
  name: string;
  /** The value as shown, already shortened to fit the node. */
  value: string;
}

export interface GraphNode {
  id: string;
  title: string;
  classType: string;
  /** Whether ComfyUI described this node; drawn plainer when it did not. */
  known: boolean;
  inputs: GraphInput[];
  outputs: GraphSlot[];
  widgets: GraphWidget[];
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface GraphLink {
  from: string;
  fromSlot: number;
  to: string;
  /** Index into the target's `inputs`, which is the socket it is drawn to. */
  toSlot: number;
  type: string;
}

export interface GraphView {
  nodes: GraphNode[];
  links: GraphLink[];
  width: number;
  height: number;
}

/** A widget value as the editor shows it: short, on one line. */
function formatValue(value: unknown): string {
  if (typeof value === 'number') {
    return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)));
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return value.replace(/\s+/g, ' ').trim();
  if (value === null || value === undefined) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** A rough width for text at the size nodes use, without a browser to ask. */
const textWidth = (text: string, size = 12) => text.length * size * 0.56;

function shorten(text: string, chars: number): string {
  if (chars <= 1) return '…';
  return text.length > chars ? `${text.slice(0, Math.max(1, chars - 1))}…` : text;
}

/** One node's sockets and widgets, before it is placed. */
function describe(id: string, workflow: ApiWorkflow, defs: ObjectInfo): Omit<GraphNode, 'x' | 'y'> {
  const node = workflow[id]!;
  const def: NodeDef | undefined = defs[node.class_type];
  const values = node.inputs ?? {};
  const inputs: GraphInput[] = [];
  const widgets: { name: string; raw: string }[] = [];
  const seen = new Set<string>();

  const place = (name: string, type: string) => {
    seen.add(name);
    const value = values[name];
    if (isNodeLink(value)) {
      inputs.push({ name, type, link: { from: String(value[0]), slot: Number(value[1]) } });
    } else if (WIDGET_TYPES.has(type) || (type === '*' && value !== undefined)) {
      if (value !== undefined) widgets.push({ name, raw: formatValue(value) });
    } else {
      // A socket left empty: still drawn, as the editor draws it.
      inputs.push({ name, type });
    }
  };

  if (def) for (const slot of inputSlots(def)) place(slot.name, slot.type);
  // Anything the graph has that the definition does not (or every input, for
  // a node ComfyUI does not describe).
  for (const name of Object.keys(values)) if (!seen.has(name)) place(name, '*');

  let outputs: GraphSlot[];
  if (def?.output) {
    outputs = def.output.map((type, index) => {
      const kind = Array.isArray(type) ? 'COMBO' : String(type);
      return { name: def.output_name?.[index] ?? kind, type: kind };
    });
  } else {
    // Undescribed: as many outputs as anything reads, typed by what reads them.
    const used = new Map<number, string>();
    for (const other of Object.values(workflow)) {
      const otherDef = defs[other?.class_type ?? ''];
      for (const [name, value] of Object.entries(other?.inputs ?? {})) {
        if (!isNodeLink(value) || String(value[0]) !== id) continue;
        const spec = otherDef?.input?.required?.[name] ?? otherDef?.input?.optional?.[name];
        used.set(Number(value[1]), spec ? typeOf(spec) : '*');
      }
    }
    const count = used.size === 0 ? 0 : Math.max(...used.keys()) + 1;
    outputs = Array.from({ length: count }, (_, index) => {
      const type = used.get(index) ?? '*';
      return { name: type === '*' ? `output ${index + 1}` : type, type };
    });
  }

  const title = node._meta?.title || def?.display_name || node.class_type || id;

  // Wide enough for the title and the longest row, within the editor's range.
  const rows = Math.max(inputs.length, outputs.length);
  let width = textWidth(title, 13) + 50;
  for (let row = 0; row < rows; row += 1) {
    width = Math.max(
      width,
      textWidth(inputs[row]?.name ?? '', 11) + textWidth(outputs[row]?.name ?? '', 11) + 60,
    );
  }
  for (const widget of widgets)
    width = Math.max(width, textWidth(`${widget.name}  ${widget.raw}`, 11) + 50);
  width = Math.round(Math.min(GRAPH_METRICS.maxWidth, Math.max(GRAPH_METRICS.minWidth, width)));

  const fitted = widgets.map((widget) => {
    const room = Math.floor((width - 50) / (11 * 0.56)) - widget.name.length - 2;
    return { name: widget.name, value: shorten(widget.raw, room) };
  });

  const height =
    GRAPH_METRICS.title +
    rows * GRAPH_METRICS.slot +
    fitted.length * GRAPH_METRICS.widget +
    GRAPH_METRICS.pad;

  return {
    id,
    title,
    classType: node.class_type,
    known: def !== undefined,
    inputs,
    outputs,
    widgets: fitted,
    width,
    height,
  };
}

/** The vertical middle of a node's socket row. */
export function slotY(node: Pick<GraphNode, 'y'>, index: number): number {
  return node.y + GRAPH_METRICS.title + index * GRAPH_METRICS.slot + GRAPH_METRICS.slot / 2;
}

/**
 * Lay a workflow out, left to right.
 *
 * Each node goes one column past the furthest of the nodes it reads from, so
 * every link runs forwards — loaders on the left, the save on the right, as a
 * tidy editor graph usually is. Within a column, each node is put level with
 * what it reads from (or, for the first column, with what reads it), then
 * pushed down only as far as it must be to clear the one above; two passes of
 * that straighten most links.
 */
export function graphView(workflow: ApiWorkflow, defs: ObjectInfo = {}): GraphView {
  const ids = Object.keys(workflow)
    .filter((id) => workflow[id]?.class_type)
    .sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
  const described = new Map(ids.map((id) => [id, describe(id, workflow, defs)]));

  const sources = new Map<string, string[]>();
  const targets = new Map<string, string[]>();
  for (const id of ids) {
    for (const input of described.get(id)!.inputs) {
      const from = input.link?.from;
      if (!from || !described.has(from)) continue;
      sources.set(id, [...(sources.get(id) ?? []), from]);
      targets.set(from, [...(targets.get(from) ?? []), id]);
    }
  }

  // Column: one past the deepest source. A cycle (never valid in ComfyUI, but
  // not this function's to reject) is cut where it is found.
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const depthOf = (id: string): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const from = sources.get(id) ?? [];
    const value = from.length === 0 ? 0 : Math.max(...from.map(depthOf)) + 1;
    visiting.delete(id);
    depth.set(id, value);
    return value;
  };
  ids.forEach(depthOf);

  const columnCount = ids.length === 0 ? 0 : Math.max(...ids.map((id) => depth.get(id)!)) + 1;
  const columns: string[][] = Array.from({ length: columnCount }, () => []);
  for (const id of ids) columns[depth.get(id)!]!.push(id);

  const y = new Map<string, number>();
  const centre = (id: string) => y.get(id)! + described.get(id)!.height / 2;

  /** Put a column's nodes as near their wanted heights as they will go. */
  const settle = (column: string[], wanted: (id: string) => number | undefined) => {
    const desired = column.map((id, index) => {
      const want = wanted(id);
      return {
        id,
        top: want === undefined ? (y.get(id) ?? index * 100) : want - described.get(id)!.height / 2,
      };
    });
    desired.sort((a, b) => a.top - b.top);
    let floor = -Infinity;
    for (const entry of desired) {
      const top = Math.max(entry.top, floor);
      y.set(entry.id, top);
      floor = top + described.get(entry.id)!.height + GRAPH_METRICS.gapY;
    }
  };

  const average = (values: number[]) =>
    values.length === 0 ? undefined : values.reduce((sum, value) => sum + value, 0) / values.length;

  // First column stacked in id order; everything else level with its sources.
  let floor = 0;
  for (const id of columns[0] ?? []) {
    y.set(id, floor);
    floor += described.get(id)!.height + GRAPH_METRICS.gapY;
  }
  const forward = () => {
    for (let column = 1; column < columnCount; column += 1) {
      settle(columns[column]!, (id) =>
        average((sources.get(id) ?? []).filter((s) => y.has(s)).map(centre)),
      );
    }
  };
  forward();
  // Then the first column level with what reads it, and the rest again.
  if (columnCount > 1) {
    settle(columns[0]!, (id) =>
      average((targets.get(id) ?? []).filter((t) => y.has(t)).map(centre)),
    );
    forward();
  }

  // Columns as wide as their widest node.
  const xs: number[] = [];
  let x = 0;
  for (const column of columns) {
    xs.push(x);
    x += Math.max(...column.map((id) => described.get(id)!.width)) + GRAPH_METRICS.gapX;
  }

  const top = ids.length === 0 ? 0 : Math.min(...ids.map((id) => y.get(id)!));
  const nodes: GraphNode[] = ids.map((id) => ({
    ...described.get(id)!,
    x: xs[depth.get(id)!]!,
    y: y.get(id)! - top,
  }));

  const byId = new Map(nodes.map((node) => [node.id, node]));
  const links: GraphLink[] = [];
  for (const node of nodes) {
    node.inputs.forEach((input, index) => {
      if (!input.link) return;
      const source = byId.get(input.link.from);
      if (!source) return;
      const type = source.outputs[input.link.slot]?.type ?? input.type;
      links.push({
        from: source.id,
        fromSlot: input.link.slot,
        to: node.id,
        toSlot: index,
        type: type === '*' ? input.type : type,
      });
    });
  }

  return {
    nodes,
    links,
    width: Math.max(0, ...nodes.map((node) => node.x + node.width)),
    height: Math.max(0, ...nodes.map((node) => node.y + node.height)),
  };
}

/**
 * Node definitions trimmed to what drawing and bypassing need.
 *
 * A checkpoint loader's definition lists every checkpoint on the machine and a
 * LoRA loader's every LoRA — megabytes, on a big install, for a picker this
 * view never shows. The list becomes empty, which still reads as a combo.
 */
export function trimDefinitions(workflow: ApiWorkflow, objectInfo: ObjectInfo): ObjectInfo {
  const out: ObjectInfo = {};
  for (const node of Object.values(workflow)) {
    const def = objectInfo[node?.class_type ?? ''];
    if (!def || out[node.class_type]) continue;
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
    out[node.class_type] = {
      input: {
        required: trimGroup(def.input?.required),
        optional: trimGroup(def.input?.optional),
      },
      input_order: def.input_order,
      output: def.output,
      output_name: def.output_name,
      output_node: def.output_node,
      display_name: def.display_name,
    };
  }
  return out;
}
