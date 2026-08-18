import type { ApiWorkflow, ObjectInfo, WidgetValue } from './comfyTypes.js';

/**
 * Converting ComfyUI's *editor* format into the API format Latent runs.
 *
 * The two are different files. "Export (API)" produces the flat
 * `{ nodeId: { class_type, inputs } }` graph the `/prompt` endpoint takes;
 * everything ComfyUI saves by itself — including every workflow already sitting
 * in `user/default/workflows` — is the editor's own format, which describes
 * nodes, links and a *positional* list of widget values with no field names in
 * it at all.
 *
 * Reading a folder of workflows without asking anyone to re-export them means
 * doing that mapping here: `/object_info` says which inputs a node has and in
 * what order, and the positional list is walked against it.
 */

interface UiLink {
  0: number; // link id
  1: number; // origin node id
  2: number; // origin output slot
  3: number; // target node id
  4: number; // target input slot
  5: string; // type
}

interface UiInput {
  name: string;
  type: string;
  link: number | null;
  /** Present when a widget was converted into an input socket. */
  widget?: { name: string };
}

interface UiNode {
  id: number;
  type: string;
  title?: string;
  /** 0 normal, 2 muted, 4 bypassed. */
  mode?: number;
  inputs?: UiInput[];
  widgets_values?: unknown;
}

export interface UiWorkflow {
  nodes: UiNode[];
  links?: (UiLink | number[])[];
  [key: string]: unknown;
}

/** True for a file that is ComfyUI's editor format rather than an API export. */
export function isUiWorkflow(value: unknown): value is UiWorkflow {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { nodes?: unknown };
  return Array.isArray(candidate.nodes);
}

export class UiWorkflowError extends Error {
  override name = 'UiWorkflowError';
}

/**
 * Node types that carry no work and are dropped rather than converted.
 *
 * Notes are comments; a reroute is wiring, already followed through above; a
 * primitive node is the editor's way of typing a value into somebody else's
 * widget, and by this point that value has been read from the widget itself.
 */
const DECORATIVE = new Set(['Note', 'MarkdownNote', 'Reroute', 'PrimitiveNode']);
/** The extra widget ComfyUI adds after a seed, which the API format has no field for. */
const SEED_CONTROLS = new Set(['fixed', 'increment', 'decrement', 'randomize']);

/**
 * Turn an editor-format workflow into the API format.
 *
 * Throws rather than guessing when a node's type is unknown to this ComfyUI:
 * a graph with a silently dropped node produces a confusing failure at submit
 * time, and "this workflow needs a node you do not have" is a far better thing
 * to be told while importing.
 */
export function uiToApiWorkflow(ui: UiWorkflow, objectInfo: ObjectInfo): ApiWorkflow {
  const links = new Map<number, { origin: number; slot: number }>();
  for (const raw of ui.links ?? []) {
    const link = raw as unknown as UiLink;
    if (typeof link[0] !== 'number') continue;
    links.set(link[0], { origin: link[1], slot: link[2] });
  }

  const byId = new Map<number, UiNode>();
  for (const node of ui.nodes) byId.set(node.id, node);

  /*
   * Reroutes are wiring, not work: they take one input and hand it on. The API
   * format has no equivalent, so a link that arrives at one is followed back to
   * whatever actually produces the value.
   */
  const resolve = (origin: number, slot: number, depth = 0): { origin: number; slot: number } => {
    const node = byId.get(origin);
    if (!node || depth > 16) return { origin, slot };
    if (node.type !== 'Reroute') return { origin, slot };

    const upstream = node.inputs?.[0]?.link;
    if (upstream === null || upstream === undefined) return { origin, slot };
    const next = links.get(upstream);
    return next ? resolve(next.origin, next.slot, depth + 1) : { origin, slot };
  };

  const api: ApiWorkflow = {};
  const missing = new Set<string>();

  for (const node of ui.nodes) {
    // Muted and bypassed nodes are switched off in the editor; ComfyUI's own
    // API export leaves them out too.
    if (node.mode === 2 || node.mode === 4) continue;
    if (DECORATIVE.has(node.type)) continue;

    const definition = objectInfo[node.type];
    if (!definition) {
      missing.add(node.type);
      continue;
    }

    const inputs: Record<string, WidgetValue | [string, number]> = {};
    const connected = new Set<string>();

    for (const input of node.inputs ?? []) {
      if (input.link === null || input.link === undefined) continue;
      const link = links.get(input.link);
      if (!link) continue;
      const source = resolve(link.origin, link.slot);
      inputs[input.name] = [String(source.origin), source.slot];
      connected.add(input.name);
    }

    assignWidgets(node, definition, inputs, connected);

    api[String(node.id)] = {
      class_type: node.type,
      inputs,
      _meta: { title: node.title ?? definition.display_name ?? node.type },
    };
  }

  if (missing.size > 0) {
    throw new UiWorkflowError(
      `This workflow uses nodes this ComfyUI does not have: ${[...missing].join(', ')}`,
    );
  }
  if (Object.keys(api).length === 0) {
    throw new UiWorkflowError('That workflow has no runnable nodes in it.');
  }

  /*
   * A graph with nothing that saves or previews an image produces no output at
   * all, and ComfyUI rejects it. Catching that here means the message names the
   * problem instead of arriving as a validation error at the first submit.
   */
  const produces = Object.values(api).some(
    (node) => objectInfo[node.class_type]?.output_node === true,
  );
  if (!produces) {
    throw new UiWorkflowError('That workflow has no output node — nothing in it saves an image.');
  }

  return api;
}

/**
 * Walk the positional widget list against the node's declared inputs.
 *
 * The editor stores widget values as a bare array in input order, so the only
 * way to know that `20` is `steps` is to know what came before it. Two things
 * make that walk non-obvious: an input that was dragged out into a socket is
 * absent from the array, and a seed contributes *two* entries because ComfyUI
 * puts its "after generate" control next to it.
 */
function assignWidgets(
  node: UiNode,
  definition: ObjectInfo[string],
  inputs: Record<string, WidgetValue | [string, number]>,
  connected: Set<string>,
): void {
  const values = node.widgets_values;

  // Some nodes save widgets by name; nothing to walk in that case.
  if (values && !Array.isArray(values) && typeof values === 'object') {
    for (const [name, value] of Object.entries(values as Record<string, unknown>)) {
      if (!connected.has(name) && isWidgetValue(value)) inputs[name] = value;
    }
    return;
  }
  if (!Array.isArray(values)) return;

  let index = 0;
  const specs = {
    ...(definition.input?.required ?? {}),
    ...(definition.input?.optional ?? {}),
  };

  for (const [name, spec] of Object.entries(specs)) {
    if (!isWidgetInput(spec)) continue;
    if (connected.has(name)) continue;

    /*
     * The positional list can be shorter than the node's declared widgets.
     *
     * It happens whenever a node keeps a widget its own JavaScript manages —
     * the LoRA managers and the Ollama nodes both do — and the editor stores
     * that value somewhere other than `widgets_values`. Stopping there left the
     * remaining inputs out of the graph altogether, and ComfyUI rejects a
     * prompt with a required input missing. The declared default is not
     * necessarily what the user had, but it is a value, and the alternative is
     * a workflow that cannot run at all.
     */
    if (index >= values.length) {
      const fallback = declaredDefault(spec);
      if (fallback !== undefined) inputs[name] = fallback;
      continue;
    }

    const value = values[index];
    index += 1;
    if (isWidgetValue(value)) inputs[name] = value;
    else {
      const fallback = declaredDefault(spec);
      if (fallback !== undefined) inputs[name] = fallback;
    }

    // The control that follows a seed: consume it so the next widget lines up.
    const options = Array.isArray(spec) ? (spec[1] as Record<string, unknown> | undefined) : undefined;
    const hasControl = options?.control_after_generate === true || name === 'seed' || name === 'noise_seed';
    if (hasControl && typeof values[index] === 'string' && SEED_CONTROLS.has(values[index] as string)) {
      index += 1;
    }
  }
}

/**
 * The value `/object_info` says an input takes when nothing else says otherwise.
 *
 * A combo without an explicit default takes its first option, which is what
 * ComfyUI's own editor shows when it places the node.
 */
function declaredDefault(spec: unknown): WidgetValue | undefined {
  if (!Array.isArray(spec)) return undefined;
  const type = spec[0];
  const options = spec[1] as Record<string, unknown> | undefined;

  const declared = options?.default;
  if (isWidgetValue(declared)) return declared;

  if (Array.isArray(type)) {
    const first = type[0];
    return isWidgetValue(first) ? first : undefined;
  }
  if (type === 'STRING') return '';
  if (type === 'INT' || type === 'FLOAT') return 0;
  if (type === 'BOOLEAN') return false;
  return undefined;
}

/**
 * Whether an input is a widget the editor stores a value for, rather than a
 * socket another node plugs into.
 *
 * A combo is declared as a list of options; everything else is a type name, and
 * only the primitive ones are widgets — `MODEL` or `LATENT` is a connection.
 */
function isWidgetInput(spec: unknown): boolean {
  if (!Array.isArray(spec)) return false;
  const type = spec[0];
  if (Array.isArray(type)) return true;
  return type === 'INT' || type === 'FLOAT' || type === 'STRING' || type === 'BOOLEAN';
}

function isWidgetValue(value: unknown): value is WidgetValue {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}
