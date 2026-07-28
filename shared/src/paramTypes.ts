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
  min?: number;
  max?: number;
  step?: number;
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
export interface FieldOverride {
  label?: string;
  group?: ParamGroup;
  hidden?: boolean;
  order?: number;
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
