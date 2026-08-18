/**
 * Types describing ComfyUI's HTTP/WebSocket API surface.
 *
 * These mirror what a real ComfyUI server sends. They are deliberately loose
 * where ComfyUI itself is loose (custom nodes can put almost anything in
 * `inputs`), and strict where we depend on the shape.
 */

/** A reference to another node's output: `[nodeId, outputSlot]`. */
export type NodeLink = [string, number];

/** A literal value a user can actually edit. */
export type WidgetValue = string | number | boolean | null;

/** Anything that can appear as a node input value. */
export type NodeInputValue = WidgetValue | NodeLink | unknown;

export interface ApiWorkflowNode {
  class_type: string;
  inputs: Record<string, NodeInputValue>;
  /** ComfyUI writes the user-facing node title here when exporting. */
  _meta?: { title?: string };
}

/** ComfyUI "Save (API Format)" workflow: a flat map of nodeId -> node. */
export type ApiWorkflow = Record<string, ApiWorkflowNode>;

/**
 * An input spec from `/object_info`.
 *
 * Either `["INT", {...opts}]` for a primitive, or `[["euler", "ddim"], {...}]`
 * for a combo box whose first element is the list of allowed values. Some
 * custom nodes omit the options object entirely.
 */
export type InputSpec = [string | ComboChoices, InputOptions?] | [string | ComboChoices];

/**
 * The choices of a combo input.
 *
 * Usually strings, but a node is free to declare numbers — `divisible_by:
 * ([8, 16, 32, 64], …)` is a real one — and then it expects a number back.
 */
export type ComboChoices = (string | number | boolean)[];

export interface InputOptions {
  default?: WidgetValue;
  min?: number;
  max?: number;
  step?: number;
  round?: number | false;
  multiline?: boolean;
  dynamicPrompts?: boolean;
  tooltip?: string;
  image_upload?: boolean;
  control_after_generate?: boolean;
  [key: string]: unknown;
}

export interface NodeDef {
  input?: {
    required?: Record<string, InputSpec>;
    optional?: Record<string, InputSpec>;
    hidden?: Record<string, InputSpec>;
  };
  input_order?: Record<string, string[]>;
  output?: (string | string[])[];
  output_name?: string[];
  output_node?: boolean;
  name?: string;
  display_name?: string;
  description?: string;
  category?: string;
  [key: string]: unknown;
}

export type ObjectInfo = Record<string, NodeDef>;

/** Identifies an image file inside ComfyUI's input/output/temp directories. */
export interface ComfyImageRef {
  filename: string;
  subfolder: string;
  type: 'output' | 'input' | 'temp' | string;
}

export interface PromptResponse {
  prompt_id: string;
  number?: number;
  node_errors?: Record<string, unknown>;
}

export interface HistoryEntry {
  prompt?: unknown;
  outputs?: Record<string, { images?: ComfyImageRef[]; [key: string]: unknown }>;
  status?: {
    status_str?: string;
    completed?: boolean;
    messages?: unknown[];
  };
}

export type HistoryResponse = Record<string, HistoryEntry>;

/** A queue entry: `[number, prompt_id, prompt, extra_data, outputs_to_execute]`. */
export type QueueItem = [number, string, ApiWorkflow, Record<string, unknown>, string[]];

export interface QueueResponse {
  queue_running: QueueItem[];
  queue_pending: QueueItem[];
}

export interface SystemStats {
  system?: {
    os?: string;
    comfyui_version?: string;
    python_version?: string;
    ram_total?: number;
    ram_free?: number;
    [key: string]: unknown;
  };
  devices?: {
    name?: string;
    type?: string;
    vram_total?: number;
    vram_free?: number;
    torch_vram_total?: number;
    torch_vram_free?: number;
    [key: string]: unknown;
  }[];
}

/* ------------------------------------------------------------------ */
/* WebSocket messages                                                  */
/* ------------------------------------------------------------------ */

export interface ComfyStatusMessage {
  type: 'status';
  data: {
    status?: { exec_info?: { queue_remaining?: number } };
    sid?: string;
  };
}

export interface ComfyExecutionStartMessage {
  type: 'execution_start';
  data: { prompt_id: string; timestamp?: number };
}

export interface ComfyExecutionCachedMessage {
  type: 'execution_cached';
  data: { prompt_id: string; nodes: string[]; timestamp?: number };
}

export interface ComfyExecutingMessage {
  type: 'executing';
  /** `node` is null when the whole prompt has finished. */
  data: { prompt_id?: string; node: string | null; display_node?: string | null };
}

export interface ComfyProgressMessage {
  type: 'progress';
  data: { prompt_id?: string; node?: string | null; value: number; max: number };
}

export interface ComfyExecutedMessage {
  type: 'executed';
  data: {
    prompt_id: string;
    node: string;
    output?: { images?: ComfyImageRef[]; [key: string]: unknown };
  };
}

export interface ComfyExecutionErrorMessage {
  type: 'execution_error';
  data: {
    prompt_id: string;
    node_id?: string;
    node_type?: string;
    exception_message?: string;
    exception_type?: string;
    traceback?: string[];
    [key: string]: unknown;
  };
}

export interface ComfyExecutionSuccessMessage {
  type: 'execution_success';
  data: { prompt_id: string; timestamp?: number };
}

export interface ComfyExecutionInterruptedMessage {
  type: 'execution_interrupted';
  data: { prompt_id: string; node_id?: string; [key: string]: unknown };
}

export type ComfyWsMessage =
  | ComfyStatusMessage
  | ComfyExecutionStartMessage
  | ComfyExecutionCachedMessage
  | ComfyExecutingMessage
  | ComfyProgressMessage
  | ComfyExecutedMessage
  | ComfyExecutionErrorMessage
  | ComfyExecutionSuccessMessage
  | ComfyExecutionInterruptedMessage
  | { type: string; data?: unknown };

/**
 * Binary WebSocket frame event codes.
 *
 * A binary frame is: uint32 eventType, then the payload. For PREVIEW_IMAGE the
 * payload is uint32 imageType (1 = JPEG, 2 = PNG) followed by the image bytes.
 */
export const BINARY_EVENT_PREVIEW_IMAGE = 1;
export const BINARY_EVENT_UNENCODED_PREVIEW_IMAGE = 2;

export const BINARY_IMAGE_TYPE_JPEG = 1;
export const BINARY_IMAGE_TYPE_PNG = 2;
