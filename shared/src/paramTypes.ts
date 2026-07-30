import type { WidgetValue } from './comfyTypes.js';

/**
 * Semantic meaning we infer for a field, used to give it a good mobile control
 * and a sensible position in the form. `other` means "we recognised the type
 * but not the purpose" — those land in the Advanced section.
 */
export type ParamRole =
  | 'prompt'
  | 'negative_prompt'
  | 'image_input'
  | 'model'
  | 'lora'
  /** A free-text field holding `<lora:name:0.8>` tags, edited structurally. */
  | 'lora_text'
  | 'vae'
  | 'width'
  | 'height'
  | 'batch_size'
  | 'steps'
  | 'cfg'
  | 'sampler'
  | 'scheduler'
  | 'denoise'
  | 'seed'
  | 'other';

/** Which UI control renders the field. */
export type ControlKind = 'textarea' | 'text' | 'int' | 'float' | 'combo' | 'boolean' | 'image';

export type ParamGroup = 'main' | 'advanced';

export interface ParamField {
  /** Stable identifier: `${nodeId}.${inputName}`. */
  id: string;
  nodeId: string;
  inputName: string;
  classType: string;
  /** Node title from `_meta.title`, else the node's display name, else class. */
  nodeTitle: string;
  /** Human label shown next to the control. */
  label: string;
  role: ParamRole;
  control: ControlKind;
  defaultValue: WidgetValue;
  /** Allowed values when `control === 'combo'`. */
  options?: string[];
  /** Hard limits, straight from `/object_info`. Typed input is clamped to these. */
  min?: number;
  max?: number;
  /**
   * The range a slider actually uses.
   *
   * `/object_info` advertises the extremes a node will tolerate — steps up to
   * 10000, CFG up to 100 — which makes a slider spanning them useless: one pixel
   * of thumb travel jumps ~40 steps. These are the range people work in, and the
   * UI offers a toggle to reach the full one when it is genuinely needed.
   */
  softMin?: number;
  softMax?: number;
  step?: number;
  /**
   * Resolved from the field's override: how it is edited, and with which values
   * when that is a point line. Absent means the ordinary input.
   */
  inputMode?: NumericInputMode;
  points?: FieldPoints;
  multiline?: boolean;
  tooltip?: string;
  group: ParamGroup;
  hidden: boolean;
  /** Sort position within the group. */
  order: number;
  /**
   * True when the node class wasn't found in `/object_info` (a custom node not
   * installed, or a server we couldn't reach). The field is still editable,
   * typed by inspecting its literal value.
   */
  unknownNodeType: boolean;
}

/** User customisations, stored separately so a re-scan never loses them. */
/**
 * How a numeric field is edited.
 *
 * `input` is the general-purpose control: a sheet with a slider and a keyboard.
 * `points` is a line of pre-set values you tap — no sheet, no typing, one
 * gesture. Worth choosing per field, because the values people actually use for
 * steps or CFG are a handful they return to over and over, while a seed is never
 * one of a short list.
 */
export type NumericInputMode = 'input' | 'points';

/** The range and interval a point line offers. */
export interface FieldPoints {
  min: number;
  max: number;
  step: number;
}

export interface FieldOverride {
  label?: string;
  group?: ParamGroup;
  hidden?: boolean;
  order?: number;
  /** How this field is edited. Numeric fields only; ignored elsewhere. */
  inputMode?: NumericInputMode;
  points?: FieldPoints;
}

export type FieldOverrides = Record<string, FieldOverride>;

export interface ParamSchema {
  version: 1;
  fields: ParamField[];
  /** Nodes that produce images (SaveImage / PreviewImage / `output_node`). */
  outputNodeIds: string[];
  capabilities: {
    /** Has at least one editable image input, so it can accept a photo. */
    img2img: boolean;
    /** Has at least one seed field. */
    seeded: boolean;
  };
  /** Node classes referenced by the workflow but missing from `/object_info`. */
  missingNodeTypes: string[];
}

export type ParamValues = Record<string, WidgetValue>;
