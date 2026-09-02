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
  /**
   * A picture named by where it sits, rather than one uploaded.
   *
   * comfyllama's folder browser holds `output/monday/render.png` — a reference
   * into a folder on the ComfyUI machine. It is deliberately not `image_input`:
   * that role means "a picture this device can supply", which drives the
   * img2img capability and the camera-roll upload, and neither is true here.
   * The picture already exists on the far end and is chosen, not sent.
   */
  | 'folder_image'
  | 'model'
  | 'lora'
  /** A free-text field holding `<lora:name:0.8>` tags, edited structurally. */
  | 'lora_text'
  | 'vae'
  | 'width'
  | 'height'
  /**
   * The other way to say how big the picture is.
   *
   * comfyllama's `EmptyLatentByAspectRatio` gives a ratio and an area instead
   * of two edge lengths. It is the same decision, so it belongs in the same
   * place on the form and on a gallery card.
   */
  | 'aspect_ratio'
  | 'megapixels'
  /**
   * How many frames a video workflow renders.
   *
   * The single most consequential number in a video graph — it is the length of
   * the clip and most of the render time — and without a role of its own it sat
   * in the advanced group as "Length", one unremarkable integer among twenty.
   */
  | 'length'
  /** Frames per second: the same frames stretched or compressed in time. */
  | 'frame_rate'
  /**
   * How long a generated sound runs, in seconds.
   *
   * The audio equivalent of `length`, and consequential for the same reason: it
   * is the piece of music you get and most of the time spent making it. In
   * seconds rather than frames, because that is what the audio nodes take.
   */
  | 'seconds'
  | 'batch_size'
  | 'steps'
  | 'cfg'
  | 'sampler'
  | 'scheduler'
  | 'denoise'
  | 'seed'
  | 'other';

/** Which UI control renders the field. */
export type ControlKind =
  | 'textarea'
  | 'text'
  | 'int'
  | 'float'
  | 'combo'
  | 'boolean'
  | 'image'
  /** A picture chosen out of a folder on the ComfyUI machine, held as a path. */
  | 'folderImage';

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
  /**
   * The combo's choices were numbers, not strings.
   *
   * A node may declare its list numerically — `divisible_by: ([8, 16, 32, 64],
   * …)` — and then it wants a number back. The options are carried as text
   * because that is what a picker offers; this is what converts them again.
   */
  numericOptions?: boolean;
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
  /** How much of a row this field takes on the Generate screen. */
  width?: FieldWidth;
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

/**
 * How wide a field is drawn.
 *
 * The form is two columns of chips; `full` gives a field the whole row. Which
 * one is right depends on the value, not on its type — a sampler name needs the
 * width its options do, while four short numbers read better side by side — so
 * it is a per-field choice rather than a rule.
 */
export type FieldWidth = 'half' | 'full';

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
  width?: FieldWidth;
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
    /**
     * Ends in a moving picture rather than a still one.
     *
     * Read off the graph's save node, so it is known before anything has run —
     * which is what lets the picker label a workflow, and what warns a screen
     * expecting a picture that it is about to be handed a video.
     */
    video: boolean;
    /**
     * Ends in a sound rather than a picture.
     *
     * Kept apart from `video` rather than folded into a "not a still image"
     * flag: a video has frames to draw and a poster to grab, and audio has
     * neither, so the screens that ask this question want different answers.
     */
    audio: boolean;
  };
  /** Node classes referenced by the workflow but missing from `/object_info`. */
  missingNodeTypes: string[];
}

export type ParamValues = Record<string, WidgetValue>;
