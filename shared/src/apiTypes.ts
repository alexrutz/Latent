import type { RandomPromptConfig } from './randomPrompt.js';
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
  /**
   * Whether this one appears in the Generate screen's picker.
   *
   * Reading a whole ComfyUI installation finds every workflow anybody ever
   * saved, which is the right thing to import and the wrong thing to scroll
   * through before every render.
   */
  visible: boolean;
  /** Where it was read from, when it came from the ComfyUI folder. */
  sourcePath: string | null;
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
  /** A "Save (API Format)" export, or a workflow saved by the editor itself. */
  graph: unknown;
}

export interface UpdateWorkflowRequest {
  name?: string;
  overrides?: FieldOverrides;
  lastValues?: ParamValues;
  /** Whether this workflow appears in the generate picker. */
  visible?: boolean;
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
  /**
   * The stored row, and the only unambiguous way to ask for these bytes.
   *
   * Name, subfolder and type are not a key: ComfyUI restarts its counter when
   * an output folder is emptied, and two imported folders can hold the same
   * file name. Looking an image up by those three served whichever row happened
   * to be newest — which is exactly how a thumbnail ends up belonging to a
   * different picture than the one it opens.
   *
   * Absent on a favourite recorded before this existed.
   */
  id?: number;
  nodeId: string;
  /** 0 = unrated, 1–5 stars. */
  rating: number;
  /**
   * Kept without a judgement.
   *
   * Same promise as a rating — archived locally, never swept by the automatic
   * cleanup — with nothing said about whether the picture is any good. Being
   * made to rate everything you want to survive is the wrong tax.
   */
  kept: boolean;
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
  /**
   * The submitted values rendered for display, recorded at submit time.
   *
   * Empty for anything queued before this existed, and for prompts queued from
   * ComfyUI's own UI.
   */
  params: ParamSummaryItem[];
  /** A short human summary (the positive prompt) for gallery cards. */
  title: string;
  images: GenerationImage[];
  /**
   * Anything the graph printed rather than drew.
   *
   * "Preview as text" nodes exist to tell you what a workflow decided — the
   * prompt after a wildcard expanded, a caption a vision model produced, a
   * dimension a node computed. Dropping them, which is what a client that only
   * looks for images does, throws away the diagnostics.
   */
  texts: TextOutput[];
  createdAt: number;
  completedAt: number | null;
  /** `comfy` for something generated here, `import` for a scanned folder. */
  source: 'comfy' | 'import';
}

/** One text output, kept with the node that produced it. */
export interface TextOutput {
  nodeId: string;
  nodeTitle: string;
  text: string;
}

export interface GalleryPage {
  items: GenerationRecord[];
  nextCursor: string | null;
}

/* ------------------------------------------------------------------ */
/* Queue                                                               */
/* ------------------------------------------------------------------ */

/**
 * One parameter as it was actually submitted, ready to display.
 *
 * Recorded at submit time rather than derived later: the workflow's form can be
 * re-arranged or deleted afterwards, and what matters in a queue listing is what
 * this particular job was given, not what the workflow looks like now.
 */
export interface ParamSummaryItem {
  /** Field id, e.g. `3.steps`. */
  key: string;
  label: string;
  value: string;
  /**
   * Worth showing in a one-line summary.
   *
   * The point is being able to tell two queued jobs apart at a glance, so this
   * covers what people actually vary: steps, CFG, sampler, size, seed, model.
   */
  primary: boolean;
}

export interface QueueEntry {
  promptId: string;
  number: number;
  running: boolean;
  title: string;
  workflowName: string;
  createdAt: number | null;
  /** What this job was submitted with. Empty for prompts queued elsewhere. */
  params: ParamSummaryItem[];
}

export interface QueueState {
  running: QueueEntry[];
  pending: QueueEntry[];
}

/* ------------------------------------------------------------------ */
/* Live job state (pushed over our WebSocket)                          */
/* ------------------------------------------------------------------ */

/**
 * Timing for the running job.
 *
 * Measured on the server, where the progress events actually arrive, so every
 * client agrees and a phone that reconnects mid-run gets the real numbers
 * instead of starting its own stopwatch from zero.
 */
export interface JobStats {
  /** Wall clock since the run started. */
  elapsedMs: number;
  /** Mean time per sampler step in the current pass. Null until two steps in. */
  msPerStep: number | null;
  /** Estimated time left in the current sampler pass. */
  etaMs: number | null;
  /** Steps left in the current pass. */
  stepsRemaining: number;
  /** Nodes finished, and how many the graph has. */
  nodesDone: number;
  nodesTotal: number;
  /** Wall clock inside the node currently executing. */
  nodeElapsedMs: number;
  /** How long the last run that finished took, for comparison. */
  lastRunMs: number | null;
}

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
  stats: JobStats;
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
  paths?: string[];
  /**
   * Import a whole folder instead of naming every file.
   *
   * An output directory holds thousands of images in dozens of folders, and
   * picking them one at a time on a phone is not a workflow — it is a punishment.
   */
  folder?: string;
  /** Whether a folder import descends into its subfolders. */
  recursive?: boolean;
  /** Rating applied to everything imported in this batch. */
  rating?: number;
}

/** One subfolder of the import root, with enough detail to decide to open it. */
export interface ImportFolder {
  /** Path relative to the import root. */
  path: string;
  name: string;
  /** Images directly inside, not counting subfolders. */
  images: number;
  /** How many of those are already in the gallery. */
  imported: number;
  folders: number;
}

/**
 * One level of the import tree.
 *
 * A level at a time, rather than a flat scan of everything: a ComfyUI output
 * directory is routinely tens of thousands of files, and the useful unit is the
 * folder — a day, a project, a model — not the individual picture.
 */
export interface ImportBrowseResult {
  root: string;
  ok: boolean;
  message?: string;
  /** Relative path of the folder being shown; empty string at the root. */
  path: string;
  /** The folder above this one, or null at the root. */
  parent: string | null;
  folders: ImportFolder[];
  files: ImportCandidate[];
  /** True when this folder holds more files than were listed. */
  truncated: boolean;
}

/** What reading the ComfyUI workflows folder found. */
export interface WorkflowScanResult {
  ok: boolean;
  message?: string;
  /** Where it looked. */
  directory: string;
  imported: number;
  skipped: number;
  failed: { path: string; reason: string }[];
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

/* ------------------------------------------------------------------ */
/* Hardware and event history                                          */
/* ------------------------------------------------------------------ */

/**
 * One reading of what the machine was doing.
 *
 * Every field is nullable because how much a ComfyUI tells you about its host
 * varies: `/system_stats` always reports VRAM and system RAM, while utilisation
 * and temperature only exist if a monitoring extension is installed. A missing
 * figure is drawn as missing rather than as zero.
 */
export interface ResourceSample {
  at: number;
  vramUsed: number | null;
  vramTotal: number | null;
  ramUsed: number | null;
  ramTotal: number | null;
  gpuPercent: number | null;
  cpuPercent: number | null;
  gpuTempC: number | null;
  /** Jobs waiting, so load can be read against demand. */
  queueRemaining: number;
  /** Sampler speed at that moment, when one was running. */
  stepsPerSecond: number | null;
}

export type MonitorEventKind =
  | 'queued'
  | 'started'
  | 'node'
  | 'text'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'online'
  | 'offline';

/** Something that happened, placed on the same timeline as the readings. */
export interface MonitorEvent {
  at: number;
  kind: MonitorEventKind;
  label: string;
  detail?: string;
  promptId?: string | null;
}

export interface MonitorSnapshot {
  samples: ResourceSample[];
  events: MonitorEvent[];
  /** What this ComfyUI actually reports, so the UI can say what is missing. */
  sources: {
    vram: boolean;
    ram: boolean;
    gpu: boolean;
    cpu: boolean;
  };
  deviceName: string | null;
  /** Where utilisation figures came from, when there are any. */
  utilisationSource: string | null;
}

/** Settings persisted server-side so every device shares them. */
export interface AppSettings {
  /** Workflow used by the gallery's "Upscale" action. */
  upscaleWorkflowId: string | null;
  /** Workflow used by "Send to img2img". */
  img2imgWorkflowId: string | null;
  defaultWorkflowId: string | null;
  /**
   * The ComfyUI installation directory, from which everything else follows.
   *
   * A standard install keeps its inputs, its outputs and its saved workflows in
   * known places under one root, so asking for three paths was asking the same
   * question three times. The two below remain as overrides for the unusual
   * setups — a network mount, outputs redirected elsewhere — and win when set.
   */
  comfyRoot: string | null;
  /** Absolute path to a ComfyUI output folder to scan for import. */
  importRoot: string | null;
  /**
   * Hours after which an unrated, unkept generation is deleted. `null` is off.
   *
   * Generating is cheap and most of what comes out is not worth keeping; without
   * this the gallery fills with thousands of near-misses and the good ones get
   * harder to find, not easier.
   */
  autoDeleteHours: number | null;
  /**
   * Absolute path to a folder of pictures to feed *into* workflows.
   *
   * The mirror of `importRoot`: that one is finished work coming in to be kept,
   * this one is reference photos, sketches and masks going out to img2img.
   */
  inputRoot: string | null;
}

/**
 * A named snapshot of the whole variation setup.
 *
 * Prompt draw and parameter draw together, because they are one way of working
 * — "landscapes, high step count" is a different setup from "portraits, fast
 * drafts", and switching between them should be one tap, not eight.
 */
export interface VariationPreset {
  id: string;
  name: string;
  config: RandomPromptConfig;
  createdAt: number;
}

/* ------------------------------------------------------------------ */
/* Input image library                                                 */
/* ------------------------------------------------------------------ */

export interface InputImage {
  /** Path relative to the configured input root. */
  path: string;
  name: string;
  bytes: number;
  modifiedAt: number;
  width: number | null;
  height: number | null;
}

export interface InputScanResult {
  root: string;
  ok: boolean;
  message?: string;
  files: InputImage[];
  /** True when the folder holds more images than the scan will list. */
  truncated: boolean;
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
  /**
   * Parameter keys drawn over each grid thumbnail, in the order chosen.
   *
   * Separate from `viewerParams` because the two have very different room: a
   * thumbnail fits two or three numbers, the full-size viewer several more.
   */
  gridParams: string[];
  /** Parameter keys drawn over the full-size picture. */
  viewerParams: string[];
  /** Prefix each overlay value with a two-letter abbreviation of its name. */
  overlayLabels: boolean;
}

export const DEFAULT_GRID_SETTINGS: GridSettings = {
  columns: 2,
  uniformTiles: false,
  favoriteThumbnails: true,
  // Nothing overlaid by default: a clean grid is the right first impression, and
  // the picker is one tap away when you are comparing a sweep.
  gridParams: [],
  viewerParams: [],
  overlayLabels: true,
};

/**
 * Endless generation: keep going until told to stop.
 *
 * Held on the server rather than driven from the browser, because a phone locks
 * its screen inside a minute and a suspended tab cannot top up a queue. See
 * `server/src/endless.ts`.
 */
export interface EndlessState {
  enabled: boolean;
  /** The settings the next run will use. */
  request: GenerateRequest | null;
  /** How many runs it has queued since it was switched on. */
  queued: number;
  /** Why it stopped by itself, when it did. */
  message?: string;
}
