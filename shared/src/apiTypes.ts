import type { ApiWorkflow, ComfyImageRef } from './comfyTypes.js';
import type { FieldOverrides, ParamSchema, ParamValues } from './paramTypes.js';

/* ------------------------------------------------------------------ */
/* Workflows                                                           */
/* ------------------------------------------------------------------ */

export interface WorkflowSummary {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  capabilities: ParamSchema['capabilities'];
  missingNodeTypes: string[];
}

export interface WorkflowDetail extends WorkflowSummary {
  graph: ApiWorkflow;
  schema: ParamSchema;
  overrides: FieldOverrides;
  /** Last values the user submitted, so the form reopens where they left it. */
  lastValues: ParamValues;
}

export interface CreateWorkflowRequest {
  name: string;
  /** The parsed contents of a "Save (API Format)" export. */
  graph: unknown;
}

export interface UpdateWorkflowRequest {
  name?: string;
  overrides?: FieldOverrides;
  lastValues?: ParamValues;
}

/* ------------------------------------------------------------------ */
/* Generation                                                          */
/* ------------------------------------------------------------------ */

export interface GenerateRequest {
  workflowId: string;
  values: ParamValues;
  randomizeSeeds?: boolean;
  lockedSeedFields?: string[];
  /** Queue the same prompt N times (each with a fresh seed if randomising). */
  batchCount?: number;
}

export interface GenerateResponse {
  generationIds: string[];
  promptIds: string[];
}

export type GenerationStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface GenerationImage extends ComfyImageRef {
  nodeId: string;
  /** 0 = unrated, 1–5 stars. */
  rating: number;
  /**
   * True once the bytes have been copied into Latent's own archive, which is
   * what lets a rated image outlive the ComfyUI instance that produced it.
   */
  archived: boolean;
}

export interface GenerationRecord {
  id: string;
  promptId: string;
  workflowId: string | null;
  workflowName: string;
  status: GenerationStatus;
  error: string | null;
  values: ParamValues;
  seeds: Record<string, number>;
  /** A short human summary (the positive prompt) for gallery cards. */
  title: string;
  images: GenerationImage[];
  createdAt: number;
  completedAt: number | null;
}

export interface GalleryPage {
  items: GenerationRecord[];
  nextCursor: string | null;
}

/* ------------------------------------------------------------------ */
/* Queue                                                               */
/* ------------------------------------------------------------------ */

export interface QueueEntry {
  promptId: string;
  number: number;
  running: boolean;
  title: string;
  workflowName: string;
  createdAt: number | null;
}

export interface QueueState {
  running: QueueEntry[];
  pending: QueueEntry[];
}

/* ------------------------------------------------------------------ */
/* Live job state (pushed over our WebSocket)                          */
/* ------------------------------------------------------------------ */

export interface LiveJob {
  promptId: string;
  generationId: string | null;
  title: string;
  /** Node currently executing. */
  nodeId: string | null;
  nodeTitle: string | null;
  /** Sampler progress within the current node. */
  progress: number;
  progressMax: number;
  /** Fraction of the graph's nodes finished, 0..1. */
  graphProgress: number;
  startedAt: number;
}

export interface LiveState {
  connected: boolean;
  /** ComfyUI reachable and the upstream socket open. */
  comfyOnline: boolean;
  queueRemaining: number;
  job: LiveJob | null;
  lastError: string | null;
}

export type ServerEvent =
  | { type: 'snapshot'; data: LiveState }
  | { type: 'state'; data: LiveState }
  | { type: 'generation'; data: GenerationRecord }
  | { type: 'queue'; data: QueueState };

/* ------------------------------------------------------------------ */
/* Connections                                                         */
/* ------------------------------------------------------------------ */

/**
 * How to authenticate against a ComfyUI endpoint.
 *
 * vast.ai puts ComfyUI behind a proxy that accepts either
 * `Authorization: Bearer <token>` or Basic auth as `vastai:<token>`, where the
 * token is the instance's `OPEN_BUTTON_TOKEN` — or whatever you set
 * `WEB_PASSWORD` to when renting the box, which replaces it.
 */
export type ConnectionAuthMode = 'none' | 'bearer' | 'basic';

export interface ConnectionSummary {
  id: string;
  name: string;
  url: string;
  authMode: ConnectionAuthMode;
  username: string | null;
  /** Accept a self-signed certificate. vast.ai uses one when ENABLE_HTTPS=true. */
  allowSelfSigned: boolean;
  /** The secret itself is never sent to the client — only whether one is stored. */
  hasSecret: boolean;
  isActive: boolean;
  createdAt: number;
}

export interface ConnectionInput {
  name: string;
  url: string;
  authMode?: ConnectionAuthMode;
  username?: string | null;
  /** Omit to keep the stored secret unchanged; empty string clears it. */
  secret?: string | null;
  allowSelfSigned?: boolean;
}

export type ConnectionTestOutcome =
  | 'ok'
  | 'unreachable'
  | 'unauthorized'
  | 'self_signed'
  | 'not_comfyui';

export interface ConnectionTestResult {
  outcome: ConnectionTestOutcome;
  /** A sentence the user can act on, not a stack trace. */
  message: string;
  comfyVersion?: string | null;
}

/* ------------------------------------------------------------------ */
/* Workflow parameter presets                                          */
/* ------------------------------------------------------------------ */

export interface WorkflowPreset {
  id: string;
  workflowId: string;
  name: string;
  values: ParamValues;
  createdAt: number;
}

export interface CreatePresetRequest {
  name: string;
  values: ParamValues;
}

/* ------------------------------------------------------------------ */
/* Misc                                                                */
/* ------------------------------------------------------------------ */

export interface StatusResponse {
  comfyUrl: string;
  comfyOnline: boolean;
  comfyVersion: string | null;
  authRequired: boolean;
  authenticated: boolean;
  /** No password has been chosen yet; the app must run its setup flow. */
  setupRequired: boolean;
  /** The terminal route only exists when the server was started with it enabled. */
  terminalEnabled: boolean;
  activeConnectionId: string | null;
  activeConnectionName: string | null;
  devices: { name: string; vramTotal: number; vramFree: number }[];
}

export interface ArchiveStats {
  images: number;
  bytes: number;
}

export interface UploadImageResponse {
  name: string;
  subfolder: string;
  type: string;
}

export interface ApiError {
  error: string;
  detail?: string;
}

/** Settings persisted server-side so every device shares them. */
export interface AppSettings {
  /** Workflow used by the gallery's "Upscale" action. */
  upscaleWorkflowId: string | null;
  /** Workflow used by "Send to img2img". */
  img2imgWorkflowId: string | null;
  defaultWorkflowId: string | null;
}
