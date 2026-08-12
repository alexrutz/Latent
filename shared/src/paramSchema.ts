import type {
  ApiWorkflow,
  ApiWorkflowNode,
  ComboChoices,
  InputOptions,
  InputSpec,
  NodeLink,
  ObjectInfo,
  WidgetValue,
} from './comfyTypes.js';
import { hasLoraTags } from './loraTags.js';
import type {
  ControlKind,
  FieldOverrides,
  ParamField,
  ParamGroup,
  ParamRole,
  ParamSchema,
  ParamValues,
} from './paramTypes.js';

/* ------------------------------------------------------------------ */
/* Low-level helpers                                                   */
/* ------------------------------------------------------------------ */

/** A node input is a *link* when it is `[nodeId, slotIndex]`. Links aren't editable. */
export function isNodeLink(value: unknown): value is NodeLink {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    (typeof value[0] === 'string' || typeof value[0] === 'number') &&
    typeof value[1] === 'number'
  );
}

function isWidgetValue(value: unknown): value is WidgetValue {
  const t = typeof value;
  return t === 'string' || t === 'number' || t === 'boolean' || value === null;
}

function specType(spec: InputSpec | undefined): string | ComboChoices | undefined {
  return spec?.[0];
}

function specOptions(spec: InputSpec | undefined): InputOptions {
  const opts = spec && spec.length > 1 ? (spec as [unknown, InputOptions])[1] : undefined;
  return opts && typeof opts === 'object' ? opts : {};
}

/** Look up an input's spec across required/optional (ignoring hidden inputs). */
function findInputSpec(
  objectInfo: ObjectInfo,
  classType: string,
  inputName: string,
): InputSpec | undefined {
  const def = objectInfo[classType];
  if (!def?.input) return undefined;
  return def.input.required?.[inputName] ?? def.input.optional?.[inputName];
}

/**
 * ComfyUI advertises huge seed ranges (up to 2^64-1) that JavaScript numbers
 * cannot represent. Clamp anything beyond the safe integer range.
 */
function safeNumber(n: number | undefined): number | undefined {
  if (n === undefined || !Number.isFinite(n)) return undefined;
  if (n > Number.MAX_SAFE_INTEGER) return Number.MAX_SAFE_INTEGER;
  if (n < -Number.MAX_SAFE_INTEGER) return -Number.MAX_SAFE_INTEGER;
  return n;
}

/* ------------------------------------------------------------------ */
/* Workflow format validation                                          */
/* ------------------------------------------------------------------ */

export class WorkflowFormatError extends Error {
  override name = 'WorkflowFormatError';
}

/**
 * Accepts a parsed JSON blob and asserts it is an API-format workflow.
 *
 * The most common mistake by far is exporting the *UI* format ("Workflow >
 * Export") instead of "Export (API)" / "Save (API Format)". That file has a
 * `nodes` array and a `links` array, so we detect it and say exactly what to do
 * rather than failing with a confusing type error later.
 */
export function assertApiWorkflow(input: unknown): ApiWorkflow {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new WorkflowFormatError('That file is not a ComfyUI workflow (expected a JSON object).');
  }

  const obj = input as Record<string, unknown>;

  if (Array.isArray(obj.nodes) && ('links' in obj || 'last_node_id' in obj)) {
    throw new WorkflowFormatError(
      'This is a UI-format workflow. In ComfyUI use "Workflow → Export (API)" ' +
        '(older builds: enable Dev Mode, then "Save (API Format)") and import that file instead.',
    );
  }

  // Some exports wrap the graph, e.g. `{ "prompt": { ... } }`.
  const unwrapped =
    'prompt' in obj && obj.prompt && typeof obj.prompt === 'object' && !Array.isArray(obj.prompt)
      ? (obj.prompt as Record<string, unknown>)
      : obj;

  const entries = Object.entries(unwrapped);
  if (entries.length === 0) {
    throw new WorkflowFormatError('That workflow is empty.');
  }

  for (const [nodeId, node] of entries) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
      throw new WorkflowFormatError(`Node "${nodeId}" is malformed.`);
    }
    const n = node as Record<string, unknown>;
    if (typeof n.class_type !== 'string') {
      throw new WorkflowFormatError(
        `Node "${nodeId}" has no class_type — this does not look like an API-format workflow.`,
      );
    }
    if (n.inputs !== undefined && (typeof n.inputs !== 'object' || n.inputs === null)) {
      throw new WorkflowFormatError(`Node "${nodeId}" has malformed inputs.`);
    }
  }

  return unwrapped as unknown as ApiWorkflow;
}

/* ------------------------------------------------------------------ */
/* Role detection                                                      */
/* ------------------------------------------------------------------ */

const SEED_INPUTS = new Set(['seed', 'noise_seed', 'rand_seed']);
const MODEL_INPUTS = new Set([
  'ckpt_name',
  'unet_name',
  'model_name',
  'model',
  'diffusion_model',
  'gguf_name',
]);
const LORA_INPUTS = new Set(['lora_name', 'lora_1', 'lora_2']);
const VAE_INPUTS = new Set(['vae_name']);

/** Nodes whose text inputs are prompt candidates even without a positive/negative link. */
function isTextEncodeClass(classType: string): boolean {
  return /CLIPTextEncode|TextEncode|PromptEncode/i.test(classType);
}

function isImageLoaderInput(classType: string, inputName: string, options: InputOptions): boolean {
  if (options.image_upload === true) return true;
  return /^(LoadImage|LoadImageMask|ImageOnlyCheckpointLoader)/i.test(classType)
    ? inputName === 'image'
    : false;
}

/**
 * Walk backwards from a conditioning input to the text nodes that feed it.
 *
 * A `positive` input rarely points straight at a CLIPTextEncode — it often goes
 * through ConditioningCombine, ControlNetApply, FluxGuidance and friends. We
 * follow links backwards (bounded, cycle-safe) and collect every node with an
 * editable text input we reach.
 */
function findTextSources(workflow: ApiWorkflow, startNodeId: string, maxDepth = 6): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const queue: { id: string; depth: number }[] = [{ id: startNodeId, depth: 0 }];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    if (seen.has(current.id) || current.depth > maxDepth) continue;
    seen.add(current.id);

    const node = workflow[current.id];
    if (!node) continue;

    /*
     * A node that has said what it is does not get guessed about. `Lora Input`
     * sits in the conditioning chain like a prompt node and is not one, and the
     * same goes for a LoRA loader whatever it is titled.
     */
    const claimed = TITLE_ROLES[(node._meta?.title ?? '').trim().toLowerCase()];
    const hasEditableText =
      claimed !== 'lora_text' &&
      !isLoraNodeClass(node.class_type) &&
      Object.entries(node.inputs ?? {}).some(
        ([name, value]) => typeof value === 'string' && (name === 'text' || name === 'prompt'),
      );
    if (hasEditableText) {
      found.push(current.id);
      // Keep walking: ConditioningCombine can merge two prompt nodes.
    }

    for (const value of Object.values(node.inputs ?? {})) {
      if (isNodeLink(value)) {
        queue.push({ id: String(value[0]), depth: current.depth + 1 });
      }
    }
  }

  return found;
}

interface PromptClassification {
  positive: Set<string>;
  negative: Set<string>;
}

/**
 * Classify text-producing nodes as positive or negative prompts.
 *
 * Primary signal: which sampler input they feed (`positive` vs `negative`).
 * Fallback for architectures with no negative input (Flux, SD3 in some
 * configurations): a lone text node is the positive prompt; with exactly two,
 * an empty one is the negative.
 */
function classifyPrompts(workflow: ApiWorkflow): PromptClassification {
  const positive = new Set<string>();
  const negative = new Set<string>();

  for (const node of Object.values(workflow)) {
    for (const [inputName, value] of Object.entries(node.inputs ?? {})) {
      if (!isNodeLink(value)) continue;
      const sourceId = String(value[0]);
      if (inputName === 'positive') {
        for (const id of findTextSources(workflow, sourceId)) positive.add(id);
      } else if (inputName === 'negative') {
        for (const id of findTextSources(workflow, sourceId)) negative.add(id);
      }
    }
  }

  // A node reached from both sides (e.g. one prompt wired to both) is ambiguous;
  // treat it as positive so the user still gets a prompt box.
  for (const id of positive) negative.delete(id);

  if (positive.size === 0) {
    const textNodes = Object.entries(workflow).filter(
      ([, node]) =>
        isTextEncodeClass(node.class_type) &&
        Object.entries(node.inputs ?? {}).some(
          ([name, value]) => typeof value === 'string' && (name === 'text' || name === 'prompt'),
        ),
    );

    if (textNodes.length === 1) {
      positive.add(textNodes[0]![0]);
    } else if (textNodes.length === 2) {
      const empty = textNodes.filter(([, node]) =>
        Object.entries(node.inputs ?? {}).some(
          ([name, value]) =>
            (name === 'text' || name === 'prompt') && typeof value === 'string' && value.trim() === '',
        ),
      );
      if (empty.length === 1) {
        const negId = empty[0]![0];
        negative.add(negId);
        for (const [id] of textNodes) if (id !== negId) positive.add(id);
      } else {
        // Can't tell them apart — offer both as prompts rather than guessing wrong.
        for (const [id] of textNodes) positive.add(id);
      }
    }
  }

  return { positive, negative };
}

/**
 * Titles that say outright what a node is for.
 *
 * Every heuristic in this file is an inference from class names, input names
 * and wiring, and inference has a ceiling: a workflow can always be built in a
 * way none of it anticipates. A title is not an inference. Name the node
 * `Prompt` and that input *is* the prompt, whatever it is wired to and whatever
 * the node is called; name one `Lora Input` and it is the LoRA field. The
 * heuristics still run for every workflow that says nothing.
 */
const TITLE_ROLES: Record<string, ParamRole> = {
  prompt: 'prompt',
  'negative prompt': 'negative_prompt',
  'lora input': 'lora_text',
};

/** Input names that hold a node's own text, as opposed to a wired value. */
const TEXT_INPUTS = new Set(['text', 'prompt', 'string', 'value']);

/** The role a node's title claims, if it claims one. */
export function roleFromTitle(nodeTitle: string, inputName: string): ParamRole | null {
  if (!TEXT_INPUTS.has(inputName)) return null;
  return TITLE_ROLES[nodeTitle.trim().toLowerCase()] ?? null;
}

/**
 * A node whose job is loading LoRAs.
 *
 * It matters because several of them carry a *text* input — trigger words, a
 * tag string, a note about what the LoRA expects — and that text is not the
 * description of the picture. Treating it as the prompt put it under the prompt
 * box and, worse, handed it to the random draw, which would then overwrite a
 * LoRA's trigger words with a landscape.
 */
function isLoraNodeClass(classType: string): boolean {
  return /lora/i.test(classType);
}

/**
 * A text field that carries `<lora:name:0.8>` tags, or is named for LoRAs.
 *
 * These get a structured editor instead of a text box — typing tags by hand on a
 * phone is the single most tedious thing about driving a LoRA-heavy workflow.
 */
function isLoraTextInput(inputName: string, literal: WidgetValue): boolean {
  if (typeof literal !== 'string') return false;
  if (hasLoraTags(literal)) return true;
  return /lora/i.test(inputName);
}

function detectRole(
  classType: string,
  inputName: string,
  options: InputOptions,
  nodeId: string,
  prompts: PromptClassification,
  literal: WidgetValue,
  nodeTitle: string,
): ParamRole {
  // A title that says what the node is beats everything below it.
  const claimed = roleFromTitle(nodeTitle, inputName);
  if (claimed) return claimed;

  // Before either prompt check: a LoRA loader's own text is trigger words or a
  // tag string, not the description of the picture. Deliberately only `text`
  // and `prompt` — `lora_name` is a combo of installed files and stays one.
  if (isLoraNodeClass(classType) && (inputName === 'text' || inputName === 'prompt')) {
    return 'lora_text';
  }

  if ((inputName === 'text' || inputName === 'prompt') && prompts.negative.has(nodeId)) {
    return 'negative_prompt';
  }
  if ((inputName === 'text' || inputName === 'prompt') && prompts.positive.has(nodeId)) {
    return 'prompt';
  }
  if (isImageLoaderInput(classType, inputName, options)) return 'image_input';
  if (SEED_INPUTS.has(inputName)) return 'seed';
  if (inputName === 'steps') return 'steps';
  if (inputName === 'cfg' || inputName === 'guidance' || inputName === 'cfg_scale') return 'cfg';
  if (inputName === 'sampler_name') return 'sampler';
  if (inputName === 'scheduler') return 'scheduler';
  if (inputName === 'denoise') return 'denoise';
  if (inputName === 'width') return 'width';
  if (inputName === 'height') return 'height';
  if (inputName === 'aspect_ratio') return 'aspect_ratio';
  if (inputName === 'megapixels') return 'megapixels';
  if (inputName === 'batch_size') return 'batch_size';
  if (LORA_INPUTS.has(inputName)) return 'lora';
  if (VAE_INPUTS.has(inputName)) return 'vae';
  if (MODEL_INPUTS.has(inputName)) return 'model';
  // Checked after the combo-backed LoRA inputs above, so a real `lora_name`
  // dropdown stays a dropdown and only free text falls through to here.
  if (isLoraTextInput(inputName, literal)) return 'lora_text';
  return 'other';
}

/** Roles shown on the main screen, in the order they appear. */
const MAIN_ROLE_ORDER: ParamRole[] = [
  'prompt',
  'negative_prompt',
  'lora_text',
  'image_input',
  'model',
  'lora',
  'width',
  'height',
  'aspect_ratio',
  'megapixels',
  'batch_size',
  'steps',
  'cfg',
  'sampler',
  'scheduler',
  'denoise',
  'seed',
];

/* ------------------------------------------------------------------ */
/* Control typing                                                      */
/* ------------------------------------------------------------------ */

interface TypedControl {
  control: ControlKind;
  options?: string[];
  numericOptions?: boolean;
  min?: number;
  max?: number;
  step?: number;
  multiline?: boolean;
}

/** Derive the control from `/object_info`, falling back to the literal's own type. */
function typeControl(
  spec: InputSpec | undefined,
  options: InputOptions,
  literal: WidgetValue,
  role: ParamRole,
): TypedControl {
  const type = specType(spec);

  if (Array.isArray(type)) {
    /*
     * A combo's choices are usually strings, but they are allowed to be
     * numbers — `divisible_by: ([8, 16, 32, 64], …)`. Dropping those left the
     * field with no choices at all, which reads exactly like the dynamic
     * combos some nodes declare empty, so the picker turned into a free-text
     * box. They are shown as text and converted back on the way out.
     */
    const usable = type.filter(
      (value): value is string | number => typeof value === 'string' || typeof value === 'number',
    );
    const numericOptions = usable.length > 0 && usable.every((v) => typeof v === 'number');
    const opts = usable.map(String);
    // An image combo on LoadImage is really a file picker.
    if (role === 'image_input') return { control: 'image', options: opts };
    return { control: 'combo', options: opts, numericOptions };
  }

  switch (type) {
    case 'INT':
      return {
        control: 'int',
        min: safeNumber(options.min),
        max: safeNumber(options.max),
        step: safeNumber(options.step) ?? 1,
      };
    case 'FLOAT':
      return {
        control: 'float',
        min: safeNumber(options.min),
        max: safeNumber(options.max),
        step: safeNumber(options.step) ?? 0.1,
      };
    case 'BOOLEAN':
      return { control: 'boolean' };
    case 'STRING':
      return options.multiline
        ? { control: 'textarea', multiline: true }
        : { control: 'text' };
    default:
      break;
  }

  // Unknown node type (or a custom type): infer from the value we were given.
  if (role === 'image_input') return { control: 'image' };
  if (typeof literal === 'boolean') return { control: 'boolean' };
  if (typeof literal === 'number') {
    return Number.isInteger(literal) ? { control: 'int', step: 1 } : { control: 'float', step: 0.1 };
  }
  if (role === 'prompt' || role === 'negative_prompt') {
    return { control: 'textarea', multiline: true };
  }
  if (typeof literal === 'string' && literal.length > 60) {
    return { control: 'textarea', multiline: true };
  }
  return { control: 'text' };
}

/* ------------------------------------------------------------------ */
/* Practical slider ranges                                             */
/* ------------------------------------------------------------------ */

/**
 * The range each role is actually used in, as opposed to what the node will
 * tolerate.
 *
 * ComfyUI reports `steps: 1..10000` and `cfg: 0..100`. Mapped onto a phone-width
 * slider that is roughly 40 steps per pixel — you cannot select 25. These bounds
 * are what the slider spans; the true `/object_info` limits still apply to typed
 * input and are reachable via the UI's full-range toggle.
 */
const PRACTICAL_RANGES: Partial<Record<ParamRole, [number, number]>> = {
  steps: [1, 60],
  cfg: [1, 20],
  denoise: [0, 1],
  width: [256, 2048],
  height: [256, 2048],
  // 0.26 MP is SD1.5's native size, 1.0 SDXL's and Flux's; past 4 the node is
  // being asked for something no consumer card renders in one pass.
  megapixels: [0.25, 4],
  batch_size: [1, 8],
};

/** Inputs recognised by name rather than role, mostly on custom nodes. */
const PRACTICAL_RANGES_BY_NAME: Record<string, [number, number]> = {
  strength_model: [-1, 2],
  strength_clip: [-1, 2],
  strength: [-1, 2],
  guidance: [0, 10],
  shift: [1, 12],
  start_at_step: [0, 60],
  end_at_step: [0, 60],
};

interface SoftRange {
  softMin?: number;
  softMax?: number;
}

function deriveSoftRange(
  role: ParamRole,
  inputName: string,
  control: ControlKind,
  hardMin: number | undefined,
  hardMax: number | undefined,
  defaultValue: WidgetValue,
): SoftRange {
  if (control !== 'int' && control !== 'float') return {};
  // A seed has no meaningful "usual range" — it gets a dice button, not a slider.
  if (role === 'seed') return {};

  const preset = PRACTICAL_RANGES[role] ?? PRACTICAL_RANGES_BY_NAME[inputName];
  let softMin: number;
  let softMax: number;

  if (preset) {
    [softMin, softMax] = preset;
  } else {
    const hardSpan = hardMin !== undefined && hardMax !== undefined ? hardMax - hardMin : Infinity;
    // A range that is already tight enough to aim at needs no help.
    if (hardSpan <= 100) return {};

    // Nothing recognised: centre a workable window on the exported default, which
    // is by definition a value that made sense for this workflow.
    const base = typeof defaultValue === 'number' && Number.isFinite(defaultValue) ? defaultValue : 1;
    const spread = Math.max(Math.abs(base) * 2, control === 'int' ? 10 : 1);
    softMin = base - spread;
    softMax = base + spread;
  }

  // Never widen past what the node accepts.
  if (hardMin !== undefined) softMin = Math.max(softMin, hardMin);
  if (hardMax !== undefined) softMax = Math.min(softMax, hardMax);
  if (!(softMax > softMin)) return {};

  return { softMin, softMax };
}

/* ------------------------------------------------------------------ */
/* Labels                                                              */
/* ------------------------------------------------------------------ */

const ROLE_LABELS: Partial<Record<ParamRole, string>> = {
  prompt: 'Prompt',
  negative_prompt: 'Negative prompt',
  image_input: 'Input image',
  model: 'Model',
  lora: 'LoRA',
  lora_text: 'LoRAs',
  vae: 'VAE',
  width: 'Width',
  height: 'Height',
  aspect_ratio: 'Aspect ratio',
  megapixels: 'Megapixels',
  batch_size: 'Batch size',
  steps: 'Steps',
  cfg: 'CFG',
  sampler: 'Sampler',
  scheduler: 'Scheduler',
  denoise: 'Denoise',
  seed: 'Seed',
};

function humanise(name: string): string {
  const spaced = name.replace(/[_-]+/g, ' ').trim();
  if (!spaced) return name;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function nodeTitleOf(node: ApiWorkflowNode, objectInfo: ObjectInfo): string {
  return (
    node._meta?.title?.trim() ||
    objectInfo[node.class_type]?.display_name?.trim() ||
    node.class_type
  );
}

/* ------------------------------------------------------------------ */
/* Schema construction                                                 */
/* ------------------------------------------------------------------ */

/** How an image is encoded before being sent — meaningless without one. */
const IMAGE_ENCODING_INPUTS = new Set(['image_max_size', 'image_quality']);

/**
 * A control for an image the node has not been given.
 *
 * comfyllama's chat nodes each grew an optional `image` alongside a size and a
 * quality, so any of them can be multimodal. The two knobs are widgets and are
 * therefore exported whether or not anything is wired to `image` — which on a
 * text-only chat node is two settings that cannot affect the result, on a form
 * where a screenful is four of them.
 */
function idleImageControl(node: { inputs?: Record<string, unknown> }, inputName: string): boolean {
  if (!IMAGE_ENCODING_INPUTS.has(inputName)) return false;
  return !isNodeLink(node.inputs?.image);
}

/**
 * Turn an API-format workflow into a mobile form definition.
 *
 * Pure: no I/O, no randomness. Every editable input becomes a field — nothing is
 * ever dropped. Recognised roles go to the main screen in a fixed order,
 * everything else lands in Advanced where the user can promote it.
 */
export function buildParamSchema(workflow: ApiWorkflow, objectInfo: ObjectInfo = {}): ParamSchema {
  const prompts = classifyPrompts(workflow);
  const fields: ParamField[] = [];
  const outputNodeIds: string[] = [];
  const missingNodeTypes = new Set<string>();

  // Stable iteration: ComfyUI node ids are numeric strings.
  const nodeIds = Object.keys(workflow).sort((a, b) => {
    const na = Number(a);
    const nb = Number(b);
    if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
    return a.localeCompare(b);
  });

  for (const nodeId of nodeIds) {
    const node = workflow[nodeId];
    if (!node) continue;

    const def = objectInfo[node.class_type];
    const unknownNodeType = def === undefined;
    if (unknownNodeType) missingNodeTypes.add(node.class_type);

    if (def?.output_node === true || /^(SaveImage|PreviewImage|SaveAnimated)/i.test(node.class_type)) {
      outputNodeIds.push(nodeId);
    }

    const nodeTitle = nodeTitleOf(node, objectInfo);

    for (const [inputName, value] of Object.entries(node.inputs ?? {})) {
      if (isNodeLink(value)) continue; // wired from another node
      if (!isWidgetValue(value)) continue; // object/array payloads aren't form-editable

      const spec = findInputSpec(objectInfo, node.class_type, inputName);
      // Known node, but the input isn't in its definition — a stale export or a
      // hidden input. Keep it, typed from its literal value.
      const options = specOptions(spec);
      const role = detectRole(
        node.class_type,
        inputName,
        options,
        nodeId,
        prompts,
        value,
        nodeTitle,
      );
      const typed = typeControl(spec, options, value, role);
      const soft = deriveSoftRange(role, inputName, typed.control, typed.min, typed.max, value);

      const mainIndex = MAIN_ROLE_ORDER.indexOf(role);
      const group: ParamGroup = mainIndex >= 0 ? 'main' : 'advanced';

      fields.push({
        id: `${nodeId}.${inputName}`,
        nodeId,
        inputName,
        classType: node.class_type,
        nodeTitle,
        label: ROLE_LABELS[role] ?? humanise(inputName),
        role,
        control: typed.control,
        defaultValue: value,
        ...(typed.options ? { options: typed.options } : {}),
        ...(typed.numericOptions ? { numericOptions: true } : {}),
        ...(typed.min !== undefined ? { min: typed.min } : {}),
        ...(typed.max !== undefined ? { max: typed.max } : {}),
        ...(soft.softMin !== undefined ? { softMin: soft.softMin } : {}),
        ...(soft.softMax !== undefined ? { softMax: soft.softMax } : {}),
        ...(typed.step !== undefined ? { step: typed.step } : {}),
        ...(typed.multiline ? { multiline: true } : {}),
        ...(typeof options.tooltip === 'string' ? { tooltip: options.tooltip } : {}),
        group,
        // `control_after_generate` is ComfyUI's own seed-randomiser widget; our
        // seed control replaces it, so hide it rather than showing a duplicate.
        hidden: inputName === 'control_after_generate' || idleImageControl(node, inputName),
        order: group === 'main' ? mainIndex : fields.length,
        unknownNodeType,
      });
    }
  }

  // Renumber so main fields follow MAIN_ROLE_ORDER and advanced keeps graph order.
  const main = fields.filter((f) => f.group === 'main').sort((a, b) => a.order - b.order);
  const advanced = fields.filter((f) => f.group === 'advanced').sort((a, b) => a.order - b.order);
  main.forEach((f, i) => (f.order = i));
  advanced.forEach((f, i) => (f.order = i));

  // Disambiguate duplicate labels (two KSamplers both offering "Steps").
  labelDuplicates(main);
  labelDuplicates(advanced);

  return {
    version: 1,
    fields: [...main, ...advanced],
    outputNodeIds,
    capabilities: {
      img2img: fields.some((f) => f.role === 'image_input' && !f.hidden),
      seeded: fields.some((f) => f.role === 'seed' && !f.hidden),
    },
    missingNodeTypes: [...missingNodeTypes].sort(),
  };
}

/** Two fields with the same label get their node title appended. */
function labelDuplicates(fields: ParamField[]): void {
  const counts = new Map<string, number>();
  for (const f of fields) counts.set(f.label, (counts.get(f.label) ?? 0) + 1);
  for (const f of fields) {
    if ((counts.get(f.label) ?? 0) > 1) f.label = `${f.label} · ${f.nodeTitle}`;
  }
}

/* ------------------------------------------------------------------ */
/* Overrides                                                           */
/* ------------------------------------------------------------------ */

/**
 * Apply the user's form customisations on top of a freshly derived schema.
 *
 * Kept separate from `buildParamSchema` so we can re-scan a workflow (after the
 * ComfyUI server's model lists change, say) without losing hand-tuned labels.
 */
export function applyOverrides(schema: ParamSchema, overrides: FieldOverrides = {}): ParamSchema {
  const fields = schema.fields.map((field) => {
    const o = overrides[field.id];
    if (!o) return { ...field };
    return {
      ...field,
      ...(o.label !== undefined ? { label: o.label } : {}),
      ...(o.group !== undefined ? { group: o.group } : {}),
      ...(o.hidden !== undefined ? { hidden: o.hidden } : {}),
      ...(o.order !== undefined ? { order: o.order } : {}),
      ...(o.inputMode !== undefined ? { inputMode: o.inputMode } : {}),
      ...(o.points !== undefined ? { points: o.points } : {}),
      ...(o.width !== undefined ? { width: o.width } : {}),
    };
  });

  fields.sort((a, b) => {
    if (a.group !== b.group) return a.group === 'main' ? -1 : 1;
    return a.order - b.order;
  });

  return {
    ...schema,
    fields,
    capabilities: {
      img2img: fields.some((f) => f.role === 'image_input' && !f.hidden),
      seeded: fields.some((f) => f.role === 'seed' && !f.hidden),
    },
  };
}

/** Every field's default, i.e. the values the workflow was exported with. */
export function defaultValues(schema: ParamSchema): ParamValues {
  const values: ParamValues = {};
  for (const field of schema.fields) values[field.id] = field.defaultValue;
  return values;
}

/* ------------------------------------------------------------------ */
/* Applying values back onto the graph                                 */
/* ------------------------------------------------------------------ */

export interface ApplyParamsOptions {
  /** Replace every unlocked seed field with a fresh random value. */
  randomizeSeeds?: boolean;
  /** Field ids whose seed must be kept exactly as given. */
  lockedSeedFields?: string[];
  /** Injectable for deterministic tests. */
  random?: () => number;
}

export interface ApplyParamsResult {
  workflow: ApiWorkflow;
  /** Seeds actually submitted, so the gallery can record what produced an image. */
  seeds: Record<string, number>;
}

/** Coerce a form value to the type the graph expects for that field. */
function coerce(field: ParamField, value: WidgetValue): WidgetValue {
  switch (field.control) {
    case 'int': {
      const n = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(n)) return field.defaultValue;
      let rounded = Math.round(n);
      if (field.min !== undefined) rounded = Math.max(field.min, rounded);
      if (field.max !== undefined) rounded = Math.min(field.max, rounded);
      return rounded;
    }
    case 'float': {
      const n = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(n)) return field.defaultValue;
      let clamped = n;
      if (field.min !== undefined) clamped = Math.max(field.min, clamped);
      if (field.max !== undefined) clamped = Math.min(field.max, clamped);
      return clamped;
    }
    case 'boolean':
      if (typeof value === 'boolean') return value;
      return value === 'true' || value === 1;
    case 'combo': {
      if (value === null || value === undefined) return field.defaultValue;
      // A combo of numbers is shown as text and has to go back as a number:
      // the node compares against its own list, where `8` is not `"8"`.
      if (field.numericOptions) {
        const n = Number(value);
        return Number.isFinite(n) ? n : field.defaultValue;
      }
      return String(value);
    }
    case 'image':
    case 'text':
    case 'textarea':
    default:
      return value === null || value === undefined ? field.defaultValue : String(value);
  }
}

/** A random seed within the field's range, capped to JS-safe integers. */
function randomSeed(field: ParamField, random: () => number): number {
  const min = field.min !== undefined ? Math.max(0, field.min) : 0;
  const max = field.max !== undefined ? Math.min(field.max, Number.MAX_SAFE_INTEGER) : 0xffffffff;
  const span = Math.max(1, Math.min(max - min, Number.MAX_SAFE_INTEGER));
  return min + Math.floor(random() * span);
}

/**
 * Produce the graph to submit: the stored workflow with the user's values
 * written back into it. The stored workflow is never mutated.
 */
export function applyParams(
  workflow: ApiWorkflow,
  schema: ParamSchema,
  values: ParamValues,
  options: ApplyParamsOptions = {},
): ApplyParamsResult {
  const { randomizeSeeds = false, lockedSeedFields = [], random = Math.random } = options;
  const locked = new Set(lockedSeedFields);

  const next: ApiWorkflow = structuredClone(workflow);
  const seeds: Record<string, number> = {};

  for (const field of schema.fields) {
    const node = next[field.nodeId];
    if (!node?.inputs) continue;
    // Never overwrite an input that is wired from another node.
    if (isNodeLink(node.inputs[field.inputName])) continue;

    if (field.role === 'seed') {
      const provided = values[field.id];
      const useRandom = randomizeSeeds && !locked.has(field.id);
      const seed = useRandom
        ? randomSeed(field, random)
        : (coerce(field, provided ?? field.defaultValue) as number);
      node.inputs[field.inputName] = seed;
      seeds[field.id] = seed;
      continue;
    }

    if (!(field.id in values)) continue;
    node.inputs[field.inputName] = coerce(field, values[field.id] ?? field.defaultValue);
  }

  return { workflow: next, seeds };
}

/** Convenience lookup used by the img2img / upscale flows. */
export function findFieldByRole(schema: ParamSchema, role: ParamRole): ParamField | undefined {
  return schema.fields.find((f) => f.role === role && !f.hidden);
}
