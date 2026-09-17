import type { RandomPromptConfig } from './randomPrompt.js';
import type { ApiWorkflow, ComfyImageRef } from './comfyTypes.js';
import type { FieldOverrides, ParamSchema, ParamValues } from './paramTypes.js';
// The rating scale belongs to the analysis, which is where it is defined; the
// wire types reuse it rather than restating three levels in two places.
import type { StudyRating } from './studyStats.js';
import type { MediaKind } from './media.js';
import type { EditOrigin } from './editOrigin.js';
import type { FieldArrangement } from './fieldArrangement.js';

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
  /**
   * Whether this workflow ends in a moving picture.
   *
   * Read off the graph's save node, so it is known before anything has been
   * rendered — which is what lets the picker say so, and what tells a screen
   * expecting pictures that it is about to be handed a video instead.
   */
  producesVideo: boolean;
  /**
   * Whether this workflow ends in something you listen to.
   *
   * Apart from `producesVideo` rather than one "not a picture" flag: the two
   * differ in what the screen has to do about them. A clip has a frame to show
   * and a poster to capture; a track has neither, so a tile for one is a card
   * rather than a thumbnail that failed to load.
   */
  producesAudio: boolean;
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
  /**
   * Whether this output moves.
   *
   * A video is the same row in the same gallery, but almost nothing about
   * handling it is the same: it is streamed in ranges rather than sent whole,
   * it cannot be resized by the still-image renderer, and it plays rather than
   * draws. Decided from the filename when the row is written; see `mediaKindOf`.
   */
  kind: MediaKind;
  /** How long it runs, once anything has managed to measure it. */
  durationMs: number | null;
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
  /**
   * The pictures this run was given, when it said which was which.
   *
   * Recorded at submit time for the same reason `params` is: which input is the
   * origin comes from a node's title, and the workflow can be re-titled or
   * deleted long before anybody opens the result. Empty for everything that is
   * not a labelled edit — see `findEditOrigins`.
   */
  origins: EditOrigin[];
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
  'ok' | 'unreachable' | 'unauthorized' | 'self_signed' | 'not_comfyui';

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
/* Talking to this server from something it did not ship               */
/* ------------------------------------------------------------------ */

/**
 * The version of the HTTP contract this build speaks.
 *
 * Bumped when something a client depends on changes in a way that would break
 * one written against the previous number — a route removed, a field that
 * stops being sent, a meaning that changes under an unchanged name. Adding a
 * route or a field is not a bump: a client that has never heard of it carries
 * on working, which is the whole reason to distinguish the two.
 *
 * The web app never reads this. It is shipped by the same process it talks to,
 * so the two cannot disagree. This exists for the clients that are not — a
 * native app installed once and meeting whatever is running months later.
 */
export const LATENT_API_VERSION = 1;

/**
 * What `GET /api/app` answers: what this is, and how to get in.
 *
 * Deliberately small and deliberately unauthenticated. It is the one thing a
 * client can ask before it has a credential, so it must be safe to hand to a
 * stranger — the name of the software and the shape of the front door, and
 * nothing whatever about the machine behind it.
 */
export interface AppInfo {
  /** Always `latent`. Lets a client tell it has reached the right thing. */
  app: 'latent';
  api: { version: number };
  auth: {
    /** `cookie` for a browser, `bearer` for anything without a cookie jar. */
    schemes: ('cookie' | 'bearer')[];
    login: string;
    /** No password has been chosen yet; the client must run setup first. */
    setupRequired: boolean;
    /** Prose, because there is no number: see the route. */
    tokenLifetime: string;
  };
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
   * The update routes are registered. Not the same as "an update can be
   * installed" — that needs a git checkout with an upstream, and
   * `GET /api/update` is where the reason lives when there isn't one.
   */
  updateEnabled: boolean;
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

/* ------------------------------------------------------------------ */
/* Browsing folders on the ComfyUI machine                             */
/* ------------------------------------------------------------------ */

/** One folder comfyllama is willing to serve, by the key a request names it with. */
export interface BrowseRoot {
  key: string;
  path: string;
}

export interface BrowseEntry {
  name: string;
  /** Relative to the root, with `/` separators. Half of a stored reference. */
  path: string;
  size: number;
  /** Seconds, as Python's `st_mtime` gives them. */
  mtime: number;
}

export interface BrowseListing {
  root: string;
  path: string;
  folders: BrowseEntry[];
  files: BrowseEntry[];
  /** More matched than were returned; narrow the search rather than paging. */
  truncated: boolean;
  total: number;
}

export type BrowseSort = 'date' | 'name' | 'size';
export type BrowseOrder = 'asc' | 'desc';

/* ------------------------------------------------------------------ */
/* Updating the software                                               */
/* ------------------------------------------------------------------ */

/**
 * The steps an update runs, in the order it runs them.
 *
 * Named rather than numbered because the interesting question during an update
 * is never "how far along" but "which part is slow" — and it is nearly always
 * `install`, which is the one that compiles better-sqlite3 from source when no
 * prebuilt binary matches the machine.
 */
export type UpdateStepName = 'fetch' | 'reset' | 'install' | 'build' | 'rollback';

export type UpdateStepStatus = 'waiting' | 'running' | 'done' | 'failed' | 'skipped';

export type UpdatePhase = 'running' | 'succeeded' | 'failed';

export interface UpdateStep {
  name: UpdateStepName;
  /**
   * Exactly what was run.
   *
   * Shown, not just logged: when an update fails on a machine you are holding a
   * phone to, the thing you want is the command to try by hand over SSH.
   */
  command: string;
  status: UpdateStepStatus;
  startedAt: number | null;
  endedAt: number | null;
  exitCode: number | null;
}

export interface UpdateLogLine {
  /**
   * Monotonic within one server process, and the cursor a client polls with.
   *
   * Polling rather than a socket, and a cursor rather than the whole log: the
   * build wipes `web/dist` while it runs, so the page watching an update cannot
   * reload and cannot fetch anything new from the bundle. It has to be able to
   * lose its connection, come back, and still be told only what it missed.
   */
  seq: number;
  /** Null for the runner's own remarks, which belong to no command. */
  step: UpdateStepName | null;
  stream: 'out' | 'err' | 'note';
  text: string;
}

/** The install itself: what is checked out, and whether it can be moved. */
export interface UpdateCheckout {
  /** Whether an update can be installed from here at all. */
  updatable: boolean;
  /** Why not, in a sentence somebody can act on. Null when it can. */
  reason: string | null;
  branch: string | null;
  /** The remote branch `branch` tracks, e.g. `origin/main`. */
  upstream: string | null;
  commit: string | null;
  commitShort: string | null;
  committedAt: number | null;
  subject: string | null;
  /**
   * Uncommitted changes are in the way.
   *
   * Kept apart from `updatable` because it is the one blocker that is somebody's
   * own work rather than a property of the install, and the screen says so
   * differently: everything else is "this cannot be updated", this is "you have
   * edits here that an update would destroy".
   */
  dirty: boolean;
}

/** What the upstream has that this checkout does not. */
export interface UpdateAvailable {
  /** When origin was last asked. Null means not since this process started. */
  checkedAt: number | null;
  behind: number;
  /**
   * Commits here that the upstream does not have.
   *
   * Not an error — a checkout somebody has committed to locally still updates
   * fine — but it is a warning worth showing, because the reset that installs
   * the update is what makes those commits unreachable.
   */
  ahead: number;
  commit: string | null;
  commitShort: string | null;
  subject: string | null;
}

/** One attempt, from the commit it started at to wherever it ended up. */
export interface UpdateRun {
  id: string;
  phase: UpdatePhase;
  startedAt: number;
  endedAt: number | null;
  /** Where this started, and so where a rollback goes back to. */
  from: string;
  /** Where it ended. Equal to `from` again after a rollback. */
  to: string | null;
  steps: UpdateStep[];
  error: string | null;
  /**
   * New code is on disk and the running process is still the old one.
   *
   * Separate from `phase`, because a *failed* run that rolled back also leaves
   * a rebuilt tree — identical to what is running, so there is nothing to
   * restart for — while a successful one has to be replaced to take effect.
   */
  restartRequired: boolean;
}

/**
 * What would bring Latent back if this process exited.
 *
 * The update cannot take effect without replacing the running process, and
 * nothing in Latent can start itself. So this is checked rather than assumed:
 * offering a restart button on a machine where `npm start` was typed into a
 * shell would make it a "stop Latent" button, with the phone that pressed it as
 * the only way to find out.
 */
export interface UpdateSupervisor {
  kind: 'docker' | 'systemd' | 'pm2' | 'unknown';
  /** Whether exiting is expected to bring it back. */
  restarts: boolean;
  note: string;
}

export interface UpdateStatus {
  checkout: UpdateCheckout;
  available: UpdateAvailable;
  /** The current or most recent attempt; null if none since the last restart. */
  run: UpdateRun | null;
  /** Everything after the `since` the client asked with. */
  log: UpdateLogLine[];
  /** The highest seq that exists. Poll with this as the next `since`. */
  cursor: number;
  supervisor: UpdateSupervisor;
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
  /**
   * What the card is drawing, in watts, and what it is allowed to draw.
   *
   * The figure that makes utilisation mean something. "GPU at 100%" only says
   * the scheduler had work resident every interval, which a kernel waiting on
   * memory satisfies as well as one doing arithmetic — so a bandwidth-bound run
   * and a compute-bound one read the same, and the power draw is what separates
   * them. A 450 W card sitting at 160 W is waiting; at 430 W it is working.
   */
  gpuWatts: number | null;
  gpuWattsLimit: number | null;
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
    /** Needs comfyllama on the ComfyUI machine, and an NVIDIA card in it. */
    power: boolean;
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
  /**
   * Folders and files starred in the folder browser, newest first.
   *
   * Reference material is reused, and the same handful of it is reused most:
   * the sketch a series is built on, the folder of masks, the one photograph
   * every portrait starts from. Finding those by walking down from `output`
   * every time is the whole cost of using them, and it is paid per picture.
   *
   * Kept with the settings rather than on the device because what you reference
   * is a property of the installation, not of the phone you happened to pick it
   * from — the same reasoning that puts the workflows and the prompt library
   * here.
   */
  browseFavorites: BrowseFavorite[];
  /**
   * One form arrangement applied to every workflow. See `fieldArrangement.ts`.
   *
   * Keyed by what a field is called rather than by which workflow it is in, so
   * an opinion about `duration` is an opinion about every workflow that has
   * one — including the ones imported next week. Per-workflow overrides still
   * win, so nothing arranged here can quietly undo hand-tuned work.
   */
  fieldArrangement: FieldArrangement;
}

/** One starred entry in the folder browser: `root/relative/path`, plus what it is. */
export interface BrowseFavorite {
  /** `output/monday/render_0007.png` — the reference the picker hands back. */
  ref: string;
  /** A folder is somewhere to go; a file is something to pick. */
  kind: 'file' | 'folder';
  addedAt: number;
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
   * Which side of the screen the two compare handles rest against.
   *
   * A picture made by an edit workflow can be wiped away to show the one it was
   * made from — see `findEditOrigins` — and the handles that do the wiping sit
   * parked on an edge until they are dragged. Which edge is a question about
   * the hand holding the phone, not about the picture: a right thumb reaches
   * the right edge and a left one does not, and a handle parked where your
   * thumb already rests is one you can use without looking.
   *
   * Two of them, one per axis, because an edit changes different things in
   * different places and a single seam can only be dragged one way.
   */
  compareVerticalEdge: 'left' | 'right';
  compareHorizontalEdge: 'top' | 'bottom';

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
  // Left and top: where a wipe starts in every comparison anybody has ever
  // seen, because it is where reading starts. Moved for the hand, not for taste.
  compareVerticalEdge: 'left',
  compareHorizontalEdge: 'top',
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
  /** Whether a finished picture is shown to the model, and how picky it is. */
  review: ChatReviewSettings;
  /** An endless run of pictures out of your notes. See `WanderRun`. */
  wander: WanderRun;
  /**
   * Whether it accepts its own rewrites and carries on. See `AutonomousRun`.
   *
   * Beside the review rather than inside it, although it is the review's
   * threshold that ends the loop: settings merge one group deep, and a group
   * inside a group is the one shape a partial patch cannot fill in from the
   * defaults.
   */
  autonomous: AutonomousRun;
  /**
   * How far a prompt goes in describing the picture.
   *
   * Instructions rather than a length limit: "two sentences" is a rule a model
   * follows by truncating, and what is wanted is a different level of decision
   * — how much of the scene is settled here rather than left to the sampler.
   */
  promptDetail: PromptDetail;
  /** How much what you like shapes what it suggests. See `TasteProfile`. */
  taste: TasteInfluence;
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
  /**
   * Sampling, one parameter at a time, each off until you turn it on.
   *
   * Off is not "no sampling" — it is *the server's own*, which is the flags
   * llama.cpp was launched with, chosen for the model behind it. That remains
   * the right default, and it is why every parameter here is opt-in rather
   * than a box pre-filled with a number that would silently override it.
   *
   * Individually, rather than one switch over the lot, because the reason to
   * reach for these is usually a single one: a model that repeats itself wants
   * a DRY penalty and nothing else touched.
   */
  sampling: ChatSampling;
}

/**
 * One sampling parameter's override.
 *
 * The value is kept while the switch is off, so turning a parameter off to
 * compare and back on again does not lose what you had dialled in.
 */
export interface SamplingSetting {
  /** Off leaves the parameter out of the request entirely. */
  on: boolean;
  value: number;
}

/** Every parameter the sampling dialog offers, by its llama.cpp name. */
export type SamplingKey =
  | 'temperature'
  | 'top_k'
  | 'top_p'
  | 'min_p'
  | 'typical_p'
  | 'repeat_penalty'
  | 'repeat_last_n'
  | 'presence_penalty'
  | 'frequency_penalty'
  | 'dry_multiplier'
  | 'dry_base'
  | 'dry_allowed_length'
  | 'dry_penalty_last_n'
  | 'xtc_probability'
  | 'xtc_threshold'
  | 'mirostat'
  | 'mirostat_tau'
  | 'mirostat_eta'
  | 'seed';

export type ChatSampling = Record<SamplingKey, SamplingSetting>;

/** Which group of the dialog a parameter belongs in. */
export type SamplingGroup = 'core' | 'repetition' | 'dry' | 'xtc' | 'mirostat' | 'seed';

export interface SamplingParam {
  key: SamplingKey;
  group: SamplingGroup;
  label: string;
  min: number;
  max: number;
  step: number;
  /** Where the switch starts it, which is llama.cpp's own default. */
  value: number;
  /** What it does, in one line, because none of these names say. */
  hint: string;
}

/**
 * The parameters, as data.
 *
 * A list rather than nineteen hand-written rows: the dialog, the defaults and
 * the clamping all read from here, so a parameter cannot end up with a slider
 * that allows what the request then has rejected.
 *
 * The names are llama.cpp's own and go on the wire unchanged. Its
 * OpenAI-compatible endpoint accepts both the standard names and its own
 * extensions, which is why `presence_penalty` and `min_p` sit side by side.
 */
export const SAMPLING_PARAMS: readonly SamplingParam[] = [
  {
    key: 'temperature',
    group: 'core',
    label: 'Temperature',
    min: 0,
    max: 2,
    step: 0.05,
    value: 0.8,
    hint: 'How far down the list of likely words it is willing to go. 0 always picks the most likely one.',
  },
  {
    key: 'top_k',
    group: 'core',
    label: 'Top-k',
    min: 0,
    max: 200,
    step: 1,
    value: 40,
    hint: 'Only ever consider this many candidates. 0 turns it off.',
  },
  {
    key: 'top_p',
    group: 'core',
    label: 'Top-p',
    min: 0,
    max: 1,
    step: 0.01,
    value: 0.95,
    hint: 'Keep the likeliest candidates until they add up to this much probability.',
  },
  {
    key: 'min_p',
    group: 'core',
    label: 'Min-p',
    min: 0,
    max: 1,
    step: 0.01,
    value: 0.05,
    hint: 'Drop anything less likely than this fraction of the best candidate. Usually the one to reach for instead of top-p.',
  },
  {
    key: 'typical_p',
    group: 'core',
    label: 'Typical-p',
    min: 0,
    max: 1,
    step: 0.01,
    value: 1,
    hint: 'Prefers words of average surprise over both the obvious and the wild. 1 turns it off.',
  },
  {
    key: 'repeat_penalty',
    group: 'repetition',
    label: 'Repeat penalty',
    min: 1,
    max: 2,
    step: 0.01,
    value: 1.1,
    hint: 'Marks down words that have already appeared. 1 turns it off.',
  },
  {
    key: 'repeat_last_n',
    group: 'repetition',
    label: 'Repeat window',
    min: 0,
    max: 4096,
    step: 16,
    value: 64,
    hint: 'How far back the repeat penalty looks, in tokens.',
  },
  {
    key: 'presence_penalty',
    group: 'repetition',
    label: 'Presence penalty',
    min: -2,
    max: 2,
    step: 0.05,
    value: 0,
    hint: 'A flat markdown for any word already used, however often.',
  },
  {
    key: 'frequency_penalty',
    group: 'repetition',
    label: 'Frequency penalty',
    min: -2,
    max: 2,
    step: 0.05,
    value: 0,
    hint: 'A markdown that grows with how often a word has been used.',
  },
  {
    key: 'dry_multiplier',
    group: 'dry',
    label: 'DRY multiplier',
    min: 0,
    max: 5,
    step: 0.1,
    value: 0.8,
    hint: 'Penalises repeating a whole *sequence* rather than a word. 0 turns DRY off; this is the switch for the group.',
  },
  {
    key: 'dry_base',
    group: 'dry',
    label: 'DRY base',
    min: 1,
    max: 4,
    step: 0.05,
    value: 1.75,
    hint: 'How sharply the penalty grows with the length of the repeat.',
  },
  {
    key: 'dry_allowed_length',
    group: 'dry',
    label: 'DRY allowed length',
    min: 0,
    max: 20,
    step: 1,
    value: 2,
    hint: 'A repeat shorter than this is not penalised at all.',
  },
  {
    key: 'dry_penalty_last_n',
    group: 'dry',
    label: 'DRY window',
    min: -1,
    max: 8192,
    step: 64,
    value: -1,
    hint: 'How far back DRY looks. -1 is the whole context.',
  },
  {
    key: 'xtc_probability',
    group: 'xtc',
    label: 'XTC probability',
    min: 0,
    max: 1,
    step: 0.01,
    value: 0,
    hint: 'How often to drop the most likely candidates on purpose, for less predictable prose. 0 turns XTC off.',
  },
  {
    key: 'xtc_threshold',
    group: 'xtc',
    label: 'XTC threshold',
    min: 0,
    max: 1,
    step: 0.01,
    value: 0.1,
    hint: 'Only candidates above this likelihood are eligible to be dropped.',
  },
  {
    key: 'mirostat',
    group: 'mirostat',
    label: 'Mirostat',
    min: 0,
    max: 2,
    step: 1,
    value: 0,
    hint: 'Steers towards a fixed surprise instead of using top-k/top-p. 0 off, 1 and 2 are the two versions.',
  },
  {
    key: 'mirostat_tau',
    group: 'mirostat',
    label: 'Mirostat τ',
    min: 0,
    max: 10,
    step: 0.1,
    value: 5,
    hint: 'The surprise it aims for. Lower is more focused.',
  },
  {
    key: 'mirostat_eta',
    group: 'mirostat',
    label: 'Mirostat η',
    min: 0,
    max: 1,
    step: 0.01,
    value: 0.1,
    hint: 'How quickly it corrects towards that target.',
  },
  {
    key: 'seed',
    group: 'seed',
    label: 'Seed',
    min: 0,
    max: 2_147_483_647,
    step: 1,
    value: 0,
    hint: 'Fixes the randomness, so the same conversation gives the same reply. Off is a new one each time.',
  },
];

/** What each group of the dialog is called, and why it is a group. */
export const SAMPLING_GROUPS: readonly { key: SamplingGroup; label: string; hint: string }[] = [
  {
    key: 'core',
    label: 'Which words it picks from',
    hint: 'The shortlist each next word is chosen out of. Temperature and one narrowing parameter is usually the whole story.',
  },
  {
    key: 'repetition',
    label: 'Saying the same thing twice',
    hint: 'Marks down words already used. Blunt, and worth trying before DRY only because every build supports it.',
  },
  {
    key: 'dry',
    label: 'DRY',
    hint: 'Penalises a repeated *sequence* rather than a repeated word, so a model that loops out of a phrase is caught without flattening ordinary language.',
  },
  {
    key: 'xtc',
    label: 'XTC',
    hint: 'Drops the most likely candidates on purpose. For prose that reads less like a model; not for anything that has to be right.',
  },
  {
    key: 'mirostat',
    label: 'Mirostat',
    hint: 'An alternative to the shortlist entirely: it steers towards a fixed level of surprise. Turning it on makes top-k and top-p irrelevant.',
  },
  {
    key: 'seed',
    label: 'Repeatability',
    hint: 'For comparing two settings on the same conversation rather than on two different rolls of the dice.',
  },
];

/** Every parameter off: the server keeps the sampling it was started with. */
export function defaultSampling(): ChatSampling {
  return Object.fromEntries(
    SAMPLING_PARAMS.map((param) => [param.key, { on: false, value: param.value }]),
  ) as ChatSampling;
}

/**
 * The parameters to put in a request, clamped to what each one allows.
 *
 * Only what is switched on, so a request carries nothing the user did not ask
 * for and the server's own flags survive untouched. Clamped here rather than
 * only in the dialog: settings are stored as JSON and edited by hand often
 * enough that the sanitising has to live where the request is built.
 */
export function samplingOverrides(
  sampling: Partial<ChatSampling> | undefined,
): Record<string, number> {
  const out: Record<string, number> = {};
  if (!sampling) return out;

  for (const param of SAMPLING_PARAMS) {
    const setting = sampling[param.key];
    if (!setting?.on) continue;
    const value = Number(setting.value);
    if (!Number.isFinite(value)) continue;
    const clamped = Math.min(param.max, Math.max(param.min, value));
    out[param.key] = param.step >= 1 ? Math.round(clamped) : clamped;
  }
  return out;
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
 * How far a picture may be from its prompt before a rewrite is proposed.
 *
 * The same shape as the pace scale beside it, and for the same reason: this is
 * one ordered judgement, not a set of alternatives. What it decides is how
 * perfectionist the model is on your behalf — everything above `never` is a
 * standard it holds the picture to, stated to it as a score it has to beat.
 */
export type ReviewThreshold =
  /** Say how it went and stop there. Never proposes a rewrite. */
  | 'never'
  /** Only when the picture is plainly not what was asked for. */
  | 'wrong'
  /** When something the prompt called for is missing. */
  | 'loose'
  /** When a noticeable part of it is off. */
  | 'balanced'
  /** When any part of it is off. */
  | 'strict'
  /** Unless it is exactly what the prompt describes. */
  | 'exacting';

/**
 * Looking at what came out.
 *
 * A prompt is a guess about how a model will read it, and the only honest test
 * is the picture. The chat model is usually multimodal — most worth running
 * are — so it can be shown the result and asked the one question that matters:
 * is this what the prompt said? Everything downstream of that (what is missing,
 * what to change, whether it is worth changing) is a judgement, which is what
 * `threshold` calibrates.
 */
/**
 * When the model stops and asks rather than deciding for you.
 *
 * A picture can miss its prompt for reasons that are not the prompt's fault, or
 * for several at once — the light is wrong *and* the subject is off centre —
 * and which of those to fix is a matter of taste rather than of fact. Guessing
 * at that produces a rewrite that fixes the wrong thing, confidently. This is
 * how readily it says so instead.
 */
export type ReviewAsk =
  /** Never asks; it rewrites the prompt itself or says nothing. */
  | 'never'
  /** Only when it genuinely cannot tell what went wrong. */
  | 'unclear'
  /** When it is unsure which of several fixes you would want. */
  | 'unsure'
  /** Whenever there is more than one sensible way to improve the match. */
  | 'often'
  /** Always asks before rewriting anything. */
  | 'always';

/**
 * How much a prompt spells out.
 *
 * The same picture can be described in a sentence or in a paragraph, and which
 * is better is not a fact about prompting — it is a fact about what you are
 * doing. A sparse prompt leaves the model room and varies wildly between seeds;
 * an elaborate one pins the picture down and is what you want when you know
 * exactly what you are after.
 */
export type PromptDetail = 'sparse' | 'plain' | 'balanced' | 'detailed' | 'elaborate';

export interface ChatReviewSettings {
  /**
   * Show the model the pictures it makes at all. On by default.
   *
   * Off for a text-only model, or when the extra wait per picture is not worth
   * it. With it off the conversation is what it always was: a model that has
   * written prompts and never seen a single result of one.
   */
  enabled: boolean;
  threshold: ReviewThreshold;
  /**
   * How many of the most recent pictures stay in the model's view.
   *
   * Not just the moment it is made. "Make the sky darker" means nothing to a
   * model that saw the picture once, two turns ago, and is now working from its
   * own description of it — every subsequent change compounds that description
   * instead of the actual result. So the last few renders are sent with every
   * turn, and the conversation is about something both of you can see.
   *
   * A few rather than all of them, because each one is prefill: a picture is
   * on the order of a thousand tokens before the model says anything, and a
   * long session would spend most of its time re-reading its own back
   * catalogue. Two is enough for "that one was better than this one". `0`
   * keeps the picture only for the turn where it is judged.
   */
  keepInView: number;
  /** How readily it asks you rather than rewriting the prompt itself. */
  askWhen: ReviewAsk;
}

/**
 * Wandering: picture after picture, out of what you like.
 *
 * A different thing from `AutonomousRun`, which is about *one* picture getting
 * closer to its prompt. This one never converges on anything — each round draws
 * a few of your notes at random, makes a picture that holds them together, and
 * moves on. It is for the evening when you do not want to decide anything and
 * would rather be shown things.
 *
 * Drawn on the server, because the notes are encrypted there and are
 * deliberately never on screen: the point is to be surprised by your own taste,
 * not to read a list of it.
 */
export interface WanderRun {
  /**
   * Which workflow renders these. Empty means whatever the chat generates with.
   *
   * Worth setting separately: the workflow you are iterating with is often the
   * slow one, and an endless run wants the fast one.
   */
  workflowId: string;
  /**
   * How many notes are drawn for each picture.
   *
   * The whole dial of this mode. One note is a variation on a theme; five is a
   * collage that mostly holds together; more than that and every picture starts
   * to look like every other, because they all contain everything.
   *
   * A ceiling rather than a promise: the rules in `draw` can make a round
   * unable to reach it — a cap of one per heading and three headings is three
   * notes however high this is set — and a round that quietly doubled up to
   * hit the number would be breaking the rule that was asked for.
   *
   * **`0` means no ceiling**: as many as the rules reach, which under the
   * default cap of one per heading is one note from each. That is the default —
   * see `wanderCount`, which is the one place the sentinel is resolved.
   */
  attributes: number;
  /** Which notes are eligible, and how they are picked. See `WanderDraw`. */
  draw: WanderDraw;
  /**
   * Where the sampling for these turns comes from.
   *
   * `chat` keeps whatever the conversation uses. `own` is there because this is
   * not a conversation: nobody is reading the words, the same few notes come
   * round again, and a model at its careful settings writes the same prompt
   * from them every time. Creativity is the whole product here.
   */
  sampling: 'chat' | 'own';
  /** Used when `sampling` is `own`. */
  ownSampling: ChatSampling;
}

/**
 * What a wandering round is allowed to draw from, and how.
 *
 * A flat shuffle of every note you have switched on is the obvious way to do
 * this and it is not good enough. Notes are not interchangeable: a heading
 * called "Format" holds things that belong in every picture, one called "Films"
 * holds a dozen near-synonyms of which you want exactly one, and one called
 * "Ideas for later" is not something you want turning up tonight at all. The
 * draw has to know the difference, and only you can tell it.
 *
 * Everything here defaults to the flat shuffle, so an existing setup goes on
 * behaving as it did until somebody opens the sheet.
 */
export interface WanderDraw {
  /**
   * Per-heading rules, by category id. A heading not listed is `draw` with no
   * cap of its own — the default, and the reason a new heading needs no
   * attention before it starts working.
   */
  categories: Record<string, WanderCategoryRule>;
  /**
   * At most this many notes from any one heading, unless the heading overrides
   * it. `0` is no limit.
   *
   * Set to one, this is "a round takes at most one thing from each heading",
   * which is the single most useful rule here: it is what stops a round being
   * four different ways of saying the same thing because one heading happened
   * to win the shuffle four times.
   */
  perCategory: number;
  /**
   * Notes filed under no heading.
   *
   * They have no heading to switch off, so they get their own switch. `off` is
   * for a profile where the loose notes are the unsorted inbox and the filed
   * ones are the considered list.
   */
  loose: 'draw' | 'off';
  /**
   * Notes you have pinned.
   *
   * `draw` puts them in the pool like any other, with no privilege — the old
   * behaviour, and defensible: a pin means "this holds even when they have
   * asked for something specific", and in a wandering round nobody has asked
   * for anything. `always` is the other reading, that a pinned note is part of
   * everything you make, and it puts every one of them in every round. `off`
   * keeps the pins for the conversation and out of this.
   */
  pinned: 'draw' | 'always' | 'off';
  /**
   * How many rounds back a note stays out of the draw once it has been used.
   *
   * The failure mode of an endless run is not repetition of pictures, it is
   * repetition of *notes*: a profile with eight active notes and three drawn a
   * round will show you the same one twice within a minute, and by the fourth
   * picture it reads as the model being stuck. `0` is off.
   */
  avoidRepeats: number;
}

/** What one heading does in the draw. */
export interface WanderCategoryRule {
  /**
   * `draw` is the default: its notes join the pool and may or may not come up.
   * `always` guarantees the heading a place in every round — the setting for
   * the heading that decides what kind of picture this is at all. `off` leaves
   * it out of wandering entirely, without switching it off for the chat.
   */
  role: 'off' | 'draw' | 'always';
  /** At most this many notes from here. `0` defers to `perCategory`. */
  max: number;
}

export const DEFAULT_WANDER_DRAW: WanderDraw = {
  categories: {},
  /*
   * One from each heading, which is the shape the mode wants.
   *
   * The headings are the things you curated — a *Format* heading, a *Films*
   * heading, a *Mood* heading — so a picture built from one of each is a
   * picture made of your list. A flat shuffle is not: it will happily take
   * three films and no format, because one heading won the toss three times,
   * and then every round is four ways of saying the same thing.
   *
   * With `attributes` at its own default of "no ceiling" (see `wanderCount`),
   * this is literally one note per heading, every round.
   */
  perCategory: 1,
  loose: 'draw',
  pinned: 'draw',
  /*
   * Two rounds, which is the one new default worth having.
   *
   * Unlike the caps it cannot make a round come up short — the exclusion is
   * dropped the moment it would leave nothing to draw — and the thing it
   * prevents is the most obvious fault of the mode as it stands.
   */
  avoidRepeats: 2,
};

/**
 * Leaving it to get on with it.
 *
 * Everything the loop needs already exists separately: the model writes a
 * prompt, a render comes out, the model is shown it and says how much of the
 * prompt came through, and below the perfectionism threshold it proposes a
 * rewrite. The only thing standing between that and a picture that improves on
 * its own is the tap that accepts each proposal — so this is that tap, made
 * automatic.
 *
 * The exit condition is the threshold you already set: it stops the first time
 * a render clears it. That is the whole point — "keep going until it is good
 * enough" is a sentence about the threshold, not a new judgement.
 */
export interface AutonomousRun {
  /** Off by default. Each render costs GPU time nobody watched being started. */
  enabled: boolean;
  /**
   * How many renders one run may make before it stops and waits for you.
   *
   * A model convinced its prompt is nearly right can rewrite it a dozen times
   * without getting closer, and an unattended loop that does is a night of GPU
   * time spent on a picture that was finished at round two. Reaching the limit
   * leaves the last proposal waiting rather than throwing it away.
   */
  maxRounds: number;
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
/* What you like                                                       */
/* ------------------------------------------------------------------ */

/**
 * A heading for notes about your taste — "Colour", "Places", "Films".
 *
 * Optional by design: a note that does not belong under any of them is still a
 * note worth having, and being made to file everything is the reason people
 * stop writing things down.
 */
export interface TasteCategory {
  id: string;
  name: string;
  /** Whether this one, and the notes under it, are currently feeding in. */
  active: boolean;
  position: number;
  createdAt: number;
}

/** One thing you like, or want, or keep coming back to. */
export interface TasteEntry {
  id: string;
  /** `null` for a note that belongs to no category. */
  categoryId: string | null;
  text: string;
  /**
   * Whether it is currently feeding in.
   *
   * Separately from its category, because "everything about colour except that
   * one" is the normal shape of changing your mind. A note under a switched-off
   * category stays off whatever this says.
   */
  active: boolean;
  /**
   * Ignore the scale for this one: it applies whenever it is relevant.
   *
   * The rest of the notes only fill the space you left, so a concrete request
   * pushes them aside. Some things are not like that — a format you always
   * want, a thing you never want in a picture, a treatment you have settled on
   * — and those are exactly the ones that matter most when you *have* said what
   * you want.
   *
   * "Relevant" is the whole of the limit. A standing note is not a phrase to
   * work into every prompt: one about colour has no business in a request for a
   * line drawing, and the model is told to leave it out rather than bend the
   * picture to fit it.
   */
  always: boolean;
  position: number;
  createdAt: number;
}

/**
 * Everything Latent knows about what you like.
 *
 * Kept encrypted with the app password like the picture archive, for the same
 * reason: it is a description of you, sitting on a disk indefinitely. The model
 * reads it — that is what it is for — but nothing else does, and it never
 * leaves the machines you already trust with the pictures.
 */
export interface TasteProfile {
  categories: TasteCategory[];
  entries: TasteEntry[];
}

/**
 * How much your taste shapes what the model suggests.
 *
 * The rule every level shares: it never overrides something you actually asked
 * for. What changes is how much it fills the space you left — which is the
 * whole point of writing it down, since the hardest part of making a picture is
 * deciding what to make.
 */
export type TasteInfluence =
  /** Never mentioned to the model at all — standing notes included. */
  | 'off'
  /** Only when you have said nothing whatever about what you want. */
  | 'sparingly'
  /** A vague idea is nudged towards it; a concrete one is left alone. */
  | 'hints'
  /** Shapes every suggestion, where it does not contradict what was asked. */
  | 'guiding'
  /** Everything starts from it unless you say otherwise. */
  | 'strong';

/* ------------------------------------------------------------------ */
/* Chat tools                                                          */
/* ------------------------------------------------------------------ */

/**
 * The tools the model may reach for on its own, each with a pace setting.
 *
 * `revise_prompt` is deliberately not one of them: it is offered on exactly one
 * turn — the one where the model has just been shown the picture its prompt
 * produced — so "how readily does it reach for this" is not a question that
 * arises. See `ChatCallName`.
 */
export type ChatToolName = 'prompt_blocks' | 'build_prompt' | 'ask_user';

/** Every tool a call can name, including the one that is not pace-governed. */
export type ChatCallName = ChatToolName | 'revise_prompt';

/** A block the model proposes adding, changing or removing. */
export interface ProposedBlock {
  /**
   * The existing block this changes or removes.
   *
   * Filled in by the server rather than by the model. A model that has been
   * shown the library knows a block by its name and group, not by a uuid it
   * would have to copy out by hand, so a change or a removal is matched
   * against the real library before the proposal is ever stored. See
   * `resolveProposedBlocks`.
   */
  id?: string;
  name: string;
  category: string;
  text: string;
  action: 'add' | 'update' | 'remove';
  /**
   * Set when a change or a removal names nothing in the library.
   *
   * Kept in the proposal instead of being dropped from it, because a silently
   * missing row is how "it cannot delete blocks" looked from the outside: the
   * model said it had removed something, the dialog agreed, and nothing
   * happened. A proposal that cannot be carried out says so on its own row and
   * cannot be accepted.
   */
  missing?: boolean;
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
  /**
   * Written by a wandering run, from notes drawn at random. See `WanderRun`.
   *
   * Recorded by the server rather than claimed by the model, and used for one
   * thing on the screen: a picture made this way opens what made it, because
   * "what was that one?" is the only question an endless stream raises.
   */
  fromWander?: boolean;
  /**
   * Which notes this round was built from, by id.
   *
   * Ids rather than the words, because this is what gets written to the
   * database and the notes are encrypted there on purpose — storing the text
   * on a chat message would put the whole profile in the clear one round at a
   * time. The words are filled into `wanderNotes` when a conversation is read,
   * from the vault, so a locked server simply has none to give.
   *
   * They are also what a later round reads to avoid repeating itself; see
   * `WanderDraw.avoidRepeats`.
   */
  wanderNoteIds?: string[];
  /**
   * The same notes as words, resolved on the way out and never stored.
   *
   * What the picture was actually made of, for the dialog that answers "what
   * was that one?". The mode used to say nothing about this on the grounds
   * that being surprised by your own taste is the point — which is true right
   * up until a picture comes out well and there is no way to find out why.
   */
  wanderNotes?: string[];
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
   * Asked while looking at a picture, rather than while working one out.
   *
   * Set by the server, not by the model: it is a fact about which turn the call
   * arrived on. What it buys is the turn *after* the answer — that one is still
   * about the picture, so the rewrite is still on offer there rather than the
   * conversation quietly leaving the review behind.
   */
  fromReview?: boolean;
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

/**
 * A rewrite, proposed after looking at what the last prompt actually produced.
 *
 * The same payload as `build_prompt` and deliberately a different tool: it is
 * only ever offered on the turn where the model has just been shown a picture,
 * so it cannot be reached for at random, and the dialog can say what it is —
 * a second attempt at a prompt that missed, rather than a first at a new one.
 */
export interface RevisePromptCall {
  tool: 'revise_prompt';
  prompt: string;
  negativePrompt?: string;
  /** What was wrong with the picture, and what the change is meant to fix. */
  reason: string;
  /** How well the last one matched, out of ten, as the model scored it. */
  score?: number;
}

export type ChatToolCall = (PromptBlocksCall | BuildPromptCall | AskUserCall | RevisePromptCall) & {
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
/* What a conversation is doing                                        */
/* ------------------------------------------------------------------ */

/**
 * Where a conversation has got to, as a state the server holds.
 *
 * This is the change the chat module needed most. Every multi-step behaviour
 * here — a wandering run, an autonomous one, waiting for a render before
 * saying anything about it — used to be a sequence of steps the *browser*
 * drove: post this, read the stream, decide, queue, record, wait, post the
 * next. A loop whose control flow lives in a tab is a loop the operating
 * system may stop at any moment, and it did: switching apps froze the page,
 * the open stream was killed under it, timers slowed to one tick a minute, and
 * whatever step was between two `await`s simply never ran. Worse, a browser
 * that died between queueing a render and recording the decision left the
 * conversation with a proposal that had no answer — a state most chat
 * templates refuse to continue from at all.
 *
 * So the loop is the server's, and this is what it is doing. Persisted, so a
 * restart resumes rather than forgets; read by every client at once, so two
 * tabs agree; and the whole of what the screen needs to draw, so there is
 * nothing for a client to work out for itself and get wrong.
 */
export interface ChatRun {
  /** What the conversation is doing right now. */
  phase: ChatRunPhase;
  /**
   * Why it is doing it, which is what decides what happens next.
   *
   * `manual` is an ordinary conversation: one reply, then it waits for you.
   * `auto` accepts the model's own rewrites until a render clears the
   * perfectionism threshold. `wander` makes picture after picture out of notes
   * drawn at random. The two loops differ only in what they do when a round
   * ends, which is exactly what a mode should be.
   */
  mode: ChatRunMode;
  /** Rounds this run has completed, for the strip above the composer. */
  round: number;
  /**
   * The proposal waiting on a person, when the phase is `awaiting`.
   *
   * The id of the message carrying it. The transcript already holds the call
   * itself, so sending it again here would be two copies of one thing that
   * could disagree.
   */
  awaiting: string | null;
  /** The run this conversation is waiting on, when the phase is `generating`. */
  generationId: string | null;
  /**
   * Why a loop stopped short, in a sentence, or nothing while it is going.
   *
   * The strip above the composer is the only place a run that has quietly
   * stopped is distinguishable from one still going, so a loop that gives up
   * has to say why here.
   */
  note: string | null;
  /** What went wrong, if anything. Cleared by the next thing you do. */
  error: string | null;
  /**
   * What the next turn is for.
   *
   * Stored rather than worked out from the transcript, because two of the three
   * cannot be: "the ✦ button was pressed" and "that render is finished" are
   * facts about what happened, not about what the last message looks like. The
   * old code guessed them from the shape of the history and got the awkward
   * cases wrong — a rejected proposal and a finished render both leave a `tool`
   * message behind, and only one of them means the model should be shown a
   * picture and offered a rewrite.
   */
  want: ChatWant;
  /**
   * Accept the next prompt this conversation produces, without asking.
   *
   * Set by "generate now", which says what to do with the answer before the
   * answer exists. Distinct from `mode: 'auto'`, which is standing permission
   * for a whole run — this is one instruction about one proposal.
   */
  autoAccept: boolean;
}

export type ChatWant =
  /** Whatever the model has to say — an ordinary turn. */
  | 'reply'
  /** A prompt, by name. The tool is forced rather than requested. */
  | 'prompt'
  /**
   * A prompt, and not the one already on the table.
   *
   * The second half of the generate button. Same forced tool, different thing
   * said: a model handed a conversation that already contains a finished prompt
   * writes that prompt again with two words moved, which is exactly the state
   * this asks to get out of.
   */
  | 'freshPrompt'
  /** A judgement of the render that just finished, and maybe a rewrite. */
  | 'afterRender';

export type ChatRunPhase =
  /** Nothing in flight. Waiting for you. */
  | 'idle'
  /** The model is answering. Tokens are arriving. */
  | 'thinking'
  /** A proposal is on the table and only a person can settle it. */
  | 'awaiting'
  /** A render is in progress, and the turn after it waits for the picture. */
  | 'generating';

export type ChatRunMode = 'manual' | 'auto' | 'wander';

/** A conversation doing nothing, which is what a fresh one is doing. */
export const IDLE_RUN: ChatRun = {
  phase: 'idle',
  mode: 'manual',
  round: 0,
  awaiting: null,
  generationId: null,
  note: null,
  error: null,
  want: 'reply',
  autoAccept: false,
};

/**
 * What a subscriber to a conversation receives.
 *
 * One long-lived stream per open conversation rather than one per turn. That
 * is the other half of moving the loop: a stream that exists only while a
 * request is in flight cannot tell you about anything that happened while you
 * were away, so a client coming back from a suspended tab had no way to find
 * out that three pictures had been made in the meantime except to re-read
 * everything and guess.
 *
 * Every stream opens with a `sync`, so a client that has just connected, just
 * reconnected, or been asleep for an hour all take the same path: draw what
 * the server says is true, then follow the deltas.
 */
export type ChatEvent =
  /** The whole truth, sent on connect and after anything that reorders history. */
  | { type: 'sync'; run: ChatRun; partial: ChatPartialReply | null }
  /** The run state changed: a phase, a round, a note. */
  | { type: 'run'; run: ChatRun }
  /** Reasoning, as it arrives. Shown collapsed, never sent back as context. */
  | { type: 'thinking'; text: string }
  /** The reply, as it arrives. */
  | { type: 'content'; text: string }
  /** A finished message was stored — the transcript should be re-read. */
  | { type: 'message'; messageId: string }
  | { type: 'error'; message: string };

/**
 * A reply that is part-way through, for a client that has just arrived.
 *
 * Held in memory by the runner rather than written to the database per token,
 * which would be a write per token for a record nobody reads until it is
 * finished. Its purpose is a client reconnecting mid-sentence: without it, a
 * tab woken after thirty seconds shows nothing at all until the turn ends.
 */
export interface ChatPartialReply {
  content: string;
  thinking: string;
}

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
