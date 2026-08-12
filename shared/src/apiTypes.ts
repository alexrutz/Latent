import type { RandomPromptConfig } from './randomPrompt.js';
import type { ApiWorkflow, ComfyImageRef } from './comfyTypes.js';
import type { FieldOverrides, ParamSchema, ParamValues } from './paramTypes.js';
// The rating scale belongs to the analysis, which is where it is defined; the
// wire types reuse it rather than restating three levels in two places.
import type { StudyRating } from './studyStats.js';

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

/**
 * What Generate does about work already queued.
 *
 * Which one is right depends entirely on how you are working. Building up a
 * batch to compare later wants `append`; iterating on a prompt wants the queue
 * gone, because eight renders of the wording you have just changed your mind
 * about are eight renders of nothing. And `replace` stops the one in flight too
 * — waiting out a picture you already know is wrong is the whole complaint.
 */
export type QueuePolicy = 'append' | 'clear-pending' | 'replace';

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
  /**
   * Where this run came from.
   *
   * `comfy` for something generated here, `import` for a scanned folder, and
   * `study` for a parameter study — which is kept out of the gallery entirely,
   * because a study is hundreds of deliberately near-identical frames and
   * mixing them in would bury everything else you have ever made.
   */
  source: 'comfy' | 'import' | 'study';
}

/** One text output, kept with the node that produced it. */
export interface TextOutput {
  nodeId: string;
  nodeTitle: string;
  text: string;
}

/**
 * How the gallery is ordered.
 *
 * `oldest` is not the mirror of `newest` in usefulness — it is how you find the
 * beginning of a project — and `rating` is how you find the good ones without
 * remembering when they happened.
 */
export type GallerySort = 'newest' | 'oldest' | 'rating';

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

/**
 * Which server a connection points at.
 *
 * Two kinds, one list. They are different servers doing different work, but
 * everything *about reaching them* is identical — an address that changes every
 * time a box is rented, a token, often a self-signed certificate — so keeping
 * them apart meant two screens asking the same five questions in two different
 * ways. One kind is active at a time per kind.
 */
export type ConnectionKind = 'comfy' | 'llama';

export interface ConnectionSummary {
  id: string;
  kind: ConnectionKind;
  name: string;
  url: string;
  authMode: ConnectionAuthMode;
  username: string | null;
  /** Accept a self-signed certificate. vast.ai uses one when ENABLE_HTTPS=true. */
  allowSelfSigned: boolean;
  /** The secret itself is never sent to the client — only whether one is stored. */
  hasSecret: boolean;
  /** In use for its own kind. A ComfyUI and a model server are both active. */
  isActive: boolean;
  createdAt: number;
}

export interface ConnectionInput {
  name: string;
  url: string;
  /** Defaults to `comfy`, which is what every connection was before this existed. */
  kind?: ConnectionKind;
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
  /** What a model server has loaded, when that is what answered. */
  models?: string[];
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
  /**
   * Whether the picture itself is stored here, rather than only referenced.
   *
   * Favouriting archives the bytes, but that copy can fail — ComfyUI busy,
   * the connection dropped — and it was only logged. The favourite then looked
   * fine until the day the instance that held the picture went away, which is
   * exactly the day a favourite is supposed to survive. Reported so the screen
   * can say so, and offer to fetch it while the source is still there.
   */
  archived: boolean;
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
/* System prompts                                                      */
/* ------------------------------------------------------------------ */

/**
 * A named block of instructions, kept outside the thing that uses it.
 *
 * Workflows grow instructions: a captioner node with a paragraph telling it how
 * to describe a picture, an Ollama node with the rules for rewriting a prompt.
 * Buried in the graph they are invisible, unversioned and impossible to reuse —
 * changing the wording means opening ComfyUI, finding the node and re-exporting
 * the workflow. Collected here they are edited in one place and shared: any text
 * input whose name matches this one's is filled from it at submit time, and the
 * chat's own instructions are simply another entry in the list.
 */
export interface SystemPrompt {
  id: string;
  /**
   * The name, and the key that matches it to a workflow's field.
   *
   * Matched case-insensitively against a field's label, its node's title and
   * its raw input name, in that order.
   */
  name: string;
  text: string;
  position: number;
  createdAt: number;
  updatedAt: number;
}

export interface SystemPromptInput {
  name: string;
  text: string;
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
  /**
   * What Generate does about work already queued. See `QueuePolicy`.
   *
   * Ignored while endless generation is running: there, Generate does not queue
   * anything at all — it hands over the settings for the next run.
   */
  queuePolicy: QueuePolicy;
  /** How the chat module talks to the local language model. */
  chat: ChatSettings;
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
  /**
   * The prefix a saved workflow must carry to be read at all.
   *
   * A ComfyUI install accumulates every experiment anybody ever saved, and a
   * scan that imports all of them makes a list nobody can find anything in.
   * Naming the handful meant for the phone `API_…` costs nothing in the editor
   * and turns the scan into exactly those.
   *
   * Stripped from the name once inside — it marks the file on disk, and
   * repeating it on every row would waste the width. Empty means "take
   * everything", which is what installs from before this did.
   */
  workflowPrefix: string;
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
  /**
   * How much of the screen's resolution the enlarged picture is rendered at.
   *
   * A multiple of the display's own pixels: `1` is exactly what the screen can
   * resolve, `0.5` half of it, `2` twice. `0` means the file itself, at
   * whatever size it was made.
   *
   * Stepped rather than free, because the numbers in between mean nothing you
   * could see. And a scale rather than a switch, because the two ends are both
   * real answers and so is the middle: below 1 for a slow connection, where a
   * picture that arrives is worth more than a sharp one that does not; above 1
   * so the first moments of a zoom are already sharp, before the crop lands.
   *
   * Per device rather than per account, like the rest of these — it is a
   * property of the screen you are holding and the line it is on.
   */
  viewerScale: number;

  /**
   * The old switch, kept only so an existing setting is not silently dropped.
   *
   * @deprecated Read `viewerScale`. Written by no version; still read once,
   * where `true` becomes a scale of `0` — the file itself, which is what it
   * meant.
   */
  viewerNativeResolution?: boolean;
}

/**
 * The steps the viewer's resolution can be set to, as multiples of the screen.
 *
 * `0` is the file itself and is deliberately last: it is the one step that is
 * not a multiple of anything, and it is where the scale stops being about the
 * screen at all.
 */
export const VIEWER_SCALE_STEPS = [0.5, 0.75, 1, 1.5, 2, 0] as const;

/** What one step is called. Shared so a label cannot drift from its number. */
export function viewerScaleLabel(scale: number): string {
  if (scale === 0) return 'The file';
  return `${scale}×`;
}

/** The stored scale as one of the steps, for a value from an older install. */
export function viewerScaleOf(settings: Partial<GridSettings>): number {
  if (typeof settings.viewerScale === 'number') {
    return VIEWER_SCALE_STEPS.includes(settings.viewerScale as (typeof VIEWER_SCALE_STEPS)[number])
      ? settings.viewerScale
      : 1;
  }
  // The switch this replaced. `true` meant "open the file".
  return settings.viewerNativeResolution ? 0 : 1;
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
  viewerScale: 1,
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

/* ------------------------------------------------------------------ */
/* Chat                                                                */
/* ------------------------------------------------------------------ */

/**
 * Talking to a local llama.cpp server about what to make.
 *
 * The reason this is a module rather than a text box: thinking up prompt blocks
 * by hand takes forever, and describing a picture in words is a conversation
 * — you say a thing, look at it, say a different thing. The chat is where that
 * conversation happens, and the tools are how it turns into something the rest
 * of the app can use.
 */
export interface ChatSettings {
  /** Empty means "whatever the server has loaded", which is the usual case. */
  model: string;
  /** Ceiling on one reply. 0 leaves it to the server. */
  maxTokens: number;
  /**
   * Ask the model to reason before answering, and show that reasoning.
   *
   * On by default: the tools here are asked to make judgements — what belongs
   * in a prompt, which blocks are worth having — and a model that has thought
   * about it first is measurably better at both.
   */
  thinking: boolean;
  /**
   * Which of the saved system prompts is prepended to every conversation.
   *
   * An id into the shared collection rather than a block of text of its own:
   * the chat's instructions are a system prompt like any other, and keeping a
   * second copy here meant the one place they were edited was not the place
   * they were listed. `null` — and an id that no longer exists — uses Latent's
   * own wording.
   */
  systemPromptId: string | null;
  /** How readily each tool is reached for. */
  tools: ChatToolSettings;
  /** What a picture generated from the chat is used with. */
  generation: ChatGenerationSettings;
  /**
   * How big a generated picture is in the transcript, as a step on a scale.
   *
   * A step rather than a fraction of the window. A fraction sounds tidier and
   * is not: the chat window's height changes when the keyboard opens, so the
   * same setting meant two different sizes depending on whether you were
   * typing. The steps are widths, which do not move.
   */
  imageSize: number;
  /**
   * What the prompt button next to Send does.
   *
   * `generate` takes the model's prompt and queues it without asking, which is
   * the point of having a button: you have finished talking and want the
   * picture. `dialog` shows it first, for when you would rather read it.
   */
  promptButton: 'generate' | 'dialog';
  /** Where changes against the conversation's previous prompt are marked. */
  showDiff: { inDialog: boolean; underPicture: boolean };
}

/**
 * The sizes a picture in the transcript can be, as a fraction of the width.
 *
 * Width rather than height, and shared so that the setting and the transcript
 * cannot disagree about what step 3 means.
 */
export const CHAT_IMAGE_SIZES = [0.4, 0.55, 0.7, 0.85, 1] as const;

/**
 * How eagerly one tool is used.
 *
 * A separate setting per tool because they are not the same kind of
 * interruption. Being asked a clarifying question mid-conversation is cheap;
 * being handed a finished prompt while you are still deciding what you want
 * derails the thing the module is for. The defaults reflect that.
 */
export type ToolEagerness =
  | 'off'
  /** Only when the words "do this" are actually said. */
  | 'on-request'
  /** Asked for, or a plain invitation to go ahead. */
  | 'invited'
  /** Once the thing it would act on is decided and nothing is in flux. */
  | 'settled'
  /** When it looks like the next step, without waiting for the decision. */
  | 'ready'
  /** Whenever it might help. */
  | 'eager'
  /**
   * Not an instruction: a guarantee, the way `off` is.
   *
   * Only meaningful for `ask_user`. A reply that asks a question and lists its
   * answers in prose is caught and re-asked as a real tool call, so the options
   * are always something to tap rather than something to type back in. Every
   * level below this is a sentence in the system prompt, which a small model
   * can talk itself out of — and routinely does.
   */
  | 'always';

export interface ChatToolSettings {
  prompt_blocks: ToolEagerness;
  build_prompt: ToolEagerness;
  ask_user: ToolEagerness;
}

/**
 * What a picture started from the chat is generated with.
 *
 * Either whatever the Generate screen is currently set to — which is what you
 * want while iterating on one workflow — or a workflow of its own with its own
 * values, for when the chat is the place you start from and Generate is where
 * you happen to have left something else set up.
 */
export interface ChatGenerationSettings {
  /** Empty means "whatever Generate is on". */
  workflowId: string;
  /** Applied over that workflow's stored values. Only used with `workflowId`. */
  values: ParamValues;
}

/**
 * `note` is Latent's own, and is never sent to the model.
 *
 * Re-running a prompt from further up the conversation is something *you* did
 * with the app rather than a turn in the conversation. It belongs in the
 * transcript, next to the picture it produced — but a model told about it would
 * have to be told in the tool-response format, and a second response to a call
 * it already answered is exactly what chat templates refuse.
 */
export type ChatRole = 'user' | 'assistant' | 'tool' | 'note';

/** One image on a message, held as a data URI so a conversation is self-contained. */
export interface ChatAttachment {
  /** `data:image/png;base64,…` */
  dataUrl: string;
  name: string;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  /** The model's reasoning, kept apart from the answer. */
  thinking?: string;
  attachments?: ChatAttachment[];
  /** Present on an assistant message that asked for a tool to be run. */
  toolCall?: ChatToolCall;
  /** What the user decided about that tool call, once they have. */
  toolResult?: ChatToolResult;
  /**
   * The run this message started, when it started one.
   *
   * Only the id is kept. The pictures themselves belong to the gallery, and
   * copying them into the transcript would mean a second place to delete from
   * and a conversation that grows by a megabyte per accepted prompt.
   */
  generationId?: string;
  /**
   * The prompt that run was queued with.
   *
   * Stored rather than read back from the generation: the diff against the
   * conversation's previous prompt has to be computable from the transcript
   * alone, and a run can be swept out of the gallery while the conversation
   * that produced it stays.
   */
  prompt?: string;
  createdAt: number;
}

export interface ChatConversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface ChatConversationDetail extends ChatConversation {
  messages: ChatMessage[];
}

/* ------------------------------------------------------------------ */
/* Chat tools                                                          */
/* ------------------------------------------------------------------ */

export type ChatToolName = 'prompt_blocks' | 'build_prompt' | 'ask_user';

/** A block the model proposes adding, changing or removing. */
export interface ProposedBlock {
  /** Set when changing or removing one that already exists. */
  id?: string;
  name: string;
  category: string;
  text: string;
  action: 'add' | 'update' | 'remove';
}

export interface PromptBlocksCall {
  tool: 'prompt_blocks';
  /** Why the model thinks these are worth having. */
  reason: string;
  blocks: ProposedBlock[];
}

export interface BuildPromptCall {
  tool: 'build_prompt';
  prompt: string;
  negativePrompt?: string;
  /** What the model was going for, in a sentence. */
  reason: string;
}

/**
 * A question the model wants answered before it goes on.
 *
 * The point is not politeness. A prompt is only as good as the decisions behind
 * it, and a model that guesses at "portrait or landscape" produces something
 * plausible and wrong. Asking costs one tap, because the answers come ready
 * made — with a box for the answer it did not think of.
 */
export interface AskUserQuestion {
  question: string;
  /** Ready answers, so the usual reply is a tap. Two to four is the useful range. */
  options: string[];
}

export interface AskUserCall {
  tool: 'ask_user';
  /**
   * Several at once, because that is how the decisions actually arrive.
   *
   * "Portrait or landscape, and photograph or illustration?" is one moment's
   * thinking and two taps; asking it as two round trips is two waits for a
   * local model to reply. One question is simply a list of one.
   */
  questions: AskUserQuestion[];
  /** Why it matters, in a few words. */
  reason: string;
}

export type ChatToolCall = (PromptBlocksCall | BuildPromptCall | AskUserCall) & {
  /** The id llama.cpp gave it, needed to answer the model. */
  callId: string;
};

export interface ChatToolResult {
  decision: 'accepted' | 'rejected';
  /** What actually happened, in a sentence the model can read. */
  summary: string;
}

/** One frame of a streamed reply. */
export type ChatStreamEvent =
  | { type: 'thinking'; text: string }
  | { type: 'content'; text: string }
  | { type: 'tool'; call: ChatToolCall }
  | { type: 'done'; messageId: string }
  | { type: 'error'; message: string };

/* ------------------------------------------------------------------ */
/* Parameter studies                                                   */
/* ------------------------------------------------------------------ */

/**
 * A study runs in two phases, and the status says which.
 *
 * They are deliberately separate. Generating is a long unattended stretch the
 * machine does on its own; rating is a short attentive one you do with your
 * thumb — and mixing them would mean forming an opinion about a parameter
 * while still choosing its values, which is how you confirm what you already
 * believed rather than find out.
 */
export type StudyStatus =
  /** Being set up. Nothing drawn, nothing queued. */
  | 'draft'
  /** The plan is drawn and the shots are rendering. */
  | 'running'
  /** Stopped part-way. Everything already rendered is kept. */
  | 'paused'
  /** Every shot rendered. Ready to rate. */
  | 'rating'
  /** Rated as far as you care to. The results stand. */
  | 'done';

export type StudyShotStatus = 'pending' | 'queued' | 'done' | 'failed';

export interface StudyShot {
  id: string;
  ordinal: number;
  values: ParamValues;
  status: StudyShotStatus;
  generationId: string | null;
  rating: StudyRating | null;
  ratedAt: number | null;
}

/** A shot with the picture it produced, for the rating viewer. */
export interface StudyShotImage {
  shot: StudyShot;
  image: GenerationImage;
  /** The whole run, so the parameter overlay works as it does everywhere else. */
  record: GenerationRecord;
}

/**
 * Named separately from the sampler's own union so the wire format does not
 * depend on importing the engine.
 */
export type StudySamplingName = 'lhs' | 'random';

export interface StudySummary {
  id: string;
  name: string;
  workflowId: string | null;
  workflowName: string;
  status: StudyStatus;
  sampling: StudySamplingName;
  shotCount: number;
  /** How far the two phases have got. */
  rendered: number;
  failed: number;
  rated: number;
  createdAt: number;
  updatedAt: number;
}

export interface StudyDetail extends StudySummary {
  /**
   * The factors, as the sampler's `StudyFactor[]`.
   *
   * Deliberately opaque at this layer: the shape belongs to `studyPlan`, and
   * restating it here would be two definitions to keep in step.
   */
  factors: unknown[];
  /** Everything *not* being varied, typed once on the setup screen. */
  base: ParamValues;
  seed: number;
}

export interface CreateStudyRequest {
  name: string;
  workflowId: string;
}

export interface UpdateStudyRequest {
  name?: string;
  factors?: unknown[];
  base?: ParamValues;
  sampling?: StudySamplingName;
  shotCount?: number;
  seed?: number;
}

/** What the setup screen shows before anything is committed to. */
export interface StudyPreview {
  shots: number;
  /** How often each factor changes across the plan, in run order. */
  switches: { key: string; label: string; switches: number }[];
  /** The first few shots, so a plan can be eyeballed rather than trusted. */
  sample: ParamValues[];
}
