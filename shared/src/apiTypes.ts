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
  /** Saved arrangements of this form, and which one is in use. */
  layouts: FormLayout[];
  activeLayoutId: string | null;
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

/** How many grid cells a thumbnail occupies. */
export interface TileSpan {
  cols: number;
  rows: number;
}

export interface GenerationImage extends ComfyImageRef {
  nodeId: string;
  /** 0 = unrated, 1–5 stars. */
  rating: number;
  /**
   * True once the bytes have been copied into Latent's own archive, which is
   * what lets a rated image outlive the ComfyUI instance that produced it.
   */
  archived: boolean;
  /** True when a small preview is stored, so the grid never fetches full size. */
  hasThumbnail: boolean;
  /** Pixel size, used to give the tile a shape that matches the image. */
  width: number | null;
  height: number | null;
  /** A manual override of the automatic, aspect-derived tile size. */
  tileSpan: TileSpan | null;
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
  /** `comfy` for something generated here, `import` for a scanned folder. */
  source: 'comfy' | 'import';
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
/* Form layouts                                                        */
/* ------------------------------------------------------------------ */

/**
 * A named arrangement of a workflow's form.
 *
 * Which fields are visible, what they are called, whether they sit on the main
 * screen or under Advanced, and in what order. Several can exist per workflow so
 * that setting the form up one way does not destroy another arrangement — one
 * layout for quick drafts, another with every knob exposed.
 */
export interface FormLayout {
  id: string;
  workflowId: string;
  name: string;
  overrides: FieldOverrides;
  isActive: boolean;
  createdAt: number;
}

export interface CreateLayoutRequest {
  name: string;
  /** Omit to snapshot the workflow's current overrides. */
  overrides?: FieldOverrides;
}

/* ------------------------------------------------------------------ */
/* Favourites                                                          */
/* ------------------------------------------------------------------ */

/**
 * A kept image plus the settings that made it.
 *
 * The settings are a snapshot rather than a reference: the point of a favourite
 * is "make more like this", and that has to keep working after the workflow or
 * the gallery entry it came from has been deleted.
 */
export interface Favorite {
  id: string;
  title: string;
  note: string | null;
  /** Rated independently of the same image's gallery rating. */
  rating: number;
  workflowId: string | null;
  /** True when that workflow still exists and can be re-run. */
  workflowAvailable: boolean;
  values: ParamValues;
  image: GenerationImage | null;
  generationId: string | null;
  createdAt: number;
}

export interface CreateFavoriteRequest {
  generationId: string;
  image: ComfyImageRef;
  note?: string;
}

export type FavoriteSort = 'rating' | 'newest' | 'oldest';

/* ------------------------------------------------------------------ */
/* Prompt building blocks                                              */
/* ------------------------------------------------------------------ */

/**
 * A saved fragment of prompt text, to be chained together instead of typed.
 * Phone keyboards make long prompts miserable; this turns them into taps.
 */
export interface PromptBlock {
  id: string;
  name: string;
  category: string;
  /** Usually a comma-separated run of instructions. */
  text: string;
  position: number;
  createdAt: number;
}

export interface PromptBlockInput {
  name: string;
  text: string;
  category?: string;
  position?: number;
}

/* ------------------------------------------------------------------ */
/* Folder import                                                       */
/* ------------------------------------------------------------------ */

export interface ImportCandidate {
  /** Path relative to the configured import root. */
  path: string;
  name: string;
  bytes: number;
  modifiedAt: number;
  width: number | null;
  height: number | null;
  /** Already pulled into the archive by a previous scan. */
  imported: boolean;
}

export interface ImportScanResult {
  root: string;
  /** False when the configured folder does not exist or cannot be read. */
  ok: boolean;
  message?: string;
  files: ImportCandidate[];
  truncated: boolean;
}

export interface ImportRequest {
  paths: string[];
  /** Rating applied to everything imported in this batch. */
  rating?: number;
}

export interface ImportResult {
  imported: number;
  skipped: number;
  failed: { path: string; reason: string }[];
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
  /**
   * The encrypted image archive is sealed. Happens after a server restart,
   * until somebody signs in — the key only ever lives in memory.
   */
  archiveLocked: boolean;
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
  /** Absolute path to a ComfyUI output folder to scan for import. */
  importRoot: string | null;
}

/** Gallery layout, kept on the device rather than the server. */
export interface GridSettings {
  /** Base column count of the thumbnail grid. */
  columns: number;
  /**
   * When false, a tile's height follows the image's aspect ratio so as much of
   * the picture as possible is visible. When true, everything is square.
   */
  uniformTiles: boolean;
  /** Favourites list shows thumbnails (the default) or is a compact list. */
  favoriteThumbnails: boolean;
}

export const DEFAULT_GRID_SETTINGS: GridSettings = {
  columns: 2,
  uniformTiles: false,
  favoriteThumbnails: true,
};
