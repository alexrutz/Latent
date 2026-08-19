import Database from 'better-sqlite3';

import type {
  GallerySort,
  AppSettings,
  ArchiveStats,
  ChatConversation,
  ChatConversationDetail,
  ChatMessage,
  ChatToolResult,
  ComfyImageRef,
  ConnectionAuthMode,
  ConnectionInput,
  ConnectionKind,
  ConnectionSummary,
  FieldOverrides,
  GenerationRecord,
  GenerationStatus,
  ParamSchema,
  Favorite,
  FavoriteSort,
  FormLayout,
  GenerationImage,
  MediaKind,
  ParamSummaryItem,
  ParamValues,
  PromptBlock,
  PromptBlockInput,
  StudyDetail,
  StudyRating,
  StudySamplingName,
  StudyShot,
  StudyShotStatus,
  StudyStatus,
  StudySummary,
  SystemPrompt,
  SystemPromptInput,
  TextOutput,
  TileSpan,
  VariationPreset,
  WorkflowDetail,
  WorkflowPreset,
  WorkflowSummary,
} from '@latent/shared';
import type { ApiWorkflow, RandomPromptConfig } from '@latent/shared';
import {
  DEFAULT_RANDOM_PROMPT_CONFIG,
  defaultSampling,
  mediaKindOf,
  normaliseRandomPromptConfig,
} from '@latent/shared';

import type { BlockState, UiState, WorkflowUiState } from './uiState.js';

/**
 * Ordered, append-only migrations.
 *
 * Each entry runs exactly once and then bumps `user_version`. Never edit a
 * migration that has shipped — add a new one. Migration 1 is written with
 * `IF NOT EXISTS` so a database created before this runner existed adopts it
 * without being rebuilt.
 */
const MIGRATIONS: string[] = [];

MIGRATIONS.push(`
CREATE TABLE IF NOT EXISTS workflows (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  graph_json       TEXT NOT NULL,
  schema_json      TEXT NOT NULL,
  overrides_json   TEXT NOT NULL DEFAULT '{}',
  last_values_json TEXT NOT NULL DEFAULT '{}',
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS generations (
  id            TEXT PRIMARY KEY,
  prompt_id     TEXT NOT NULL UNIQUE,
  workflow_id   TEXT,
  workflow_name TEXT NOT NULL,
  status        TEXT NOT NULL,
  error         TEXT,
  values_json   TEXT NOT NULL DEFAULT '{}',
  seeds_json    TEXT NOT NULL DEFAULT '{}',
  title         TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL,
  completed_at  INTEGER
);

CREATE INDEX IF NOT EXISTS idx_generations_created
  ON generations (created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS images (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  generation_id TEXT NOT NULL REFERENCES generations(id) ON DELETE CASCADE,
  node_id       TEXT NOT NULL,
  filename      TEXT NOT NULL,
  subfolder     TEXT NOT NULL DEFAULT '',
  type          TEXT NOT NULL DEFAULT 'output',
  UNIQUE (generation_id, filename, subfolder, type)
);

CREATE INDEX IF NOT EXISTS idx_images_generation ON images (generation_id);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

/**
 * v2: remote connection presets, per-workflow parameter presets, and image
 * ratings backed by a local archive.
 */
MIGRATIONS.push(`
CREATE TABLE connections (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  url               TEXT NOT NULL,
  auth_mode         TEXT NOT NULL DEFAULT 'none',
  username          TEXT,
  secret            TEXT,
  allow_self_signed INTEGER NOT NULL DEFAULT 0,
  is_active         INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL
);

CREATE TABLE presets (
  id          TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  values_json TEXT NOT NULL DEFAULT '{}',
  created_at  INTEGER NOT NULL,
  UNIQUE (workflow_id, name)
);

CREATE INDEX idx_presets_workflow ON presets (workflow_id);

ALTER TABLE images ADD COLUMN rating INTEGER NOT NULL DEFAULT 0;
ALTER TABLE images ADD COLUMN archived_path TEXT;
ALTER TABLE images ADD COLUMN archived_bytes INTEGER;

CREATE INDEX idx_images_rating ON images (rating);
`);

/**
 * v3: encrypted archive with thumbnails, image dimensions for the aspect-ratio
 * grid, favourites, prompt building blocks, and folder-imported images.
 */
MIGRATIONS.push(`
ALTER TABLE images ADD COLUMN thumb_path TEXT;
ALTER TABLE images ADD COLUMN thumb_bytes INTEGER;
ALTER TABLE images ADD COLUMN width INTEGER;
ALTER TABLE images ADD COLUMN height INTEGER;
ALTER TABLE images ADD COLUMN encrypted INTEGER NOT NULL DEFAULT 0;
-- Manual override of how many grid cells this image occupies, e.g. '2x2'.
ALTER TABLE images ADD COLUMN tile_span TEXT;

-- 'comfy' for something this app generated, 'import' for a scanned folder.
ALTER TABLE generations ADD COLUMN source TEXT NOT NULL DEFAULT 'comfy';

CREATE TABLE favorites (
  id            TEXT PRIMARY KEY,
  image_id      INTEGER REFERENCES images(id) ON DELETE SET NULL,
  generation_id TEXT REFERENCES generations(id) ON DELETE SET NULL,
  workflow_id   TEXT,
  title         TEXT NOT NULL DEFAULT '',
  note          TEXT,
  rating        INTEGER NOT NULL DEFAULT 0,
  -- Snapshot, not a reference: a favourite has to survive its workflow or
  -- gallery entry being deleted, otherwise it is not a favourite.
  values_json   TEXT NOT NULL DEFAULT '{}',
  image_json    TEXT NOT NULL DEFAULT '{}',
  created_at    INTEGER NOT NULL
);

CREATE INDEX idx_favorites_rating ON favorites (rating DESC, created_at DESC);

CREATE TABLE prompt_blocks (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  category   TEXT NOT NULL DEFAULT '',
  text       TEXT NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_prompt_blocks_order ON prompt_blocks (category, position, created_at);
`);

/**
 * v4: named form layouts per workflow.
 *
 * A workflow had exactly one set of field overrides, so tuning the form for one
 * way of working meant destroying the arrangement you had for another. Layouts
 * are named, switchable snapshots of that arrangement.
 */
MIGRATIONS.push(`
CREATE TABLE layouts (
  id             TEXT PRIMARY KEY,
  workflow_id    TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  overrides_json TEXT NOT NULL DEFAULT '{}',
  is_active      INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  UNIQUE (workflow_id, name)
);

CREATE INDEX idx_layouts_workflow ON layouts (workflow_id, created_at);
`);

/**
 * v5: a readable parameter summary per generation.
 *
 * The queue screen has to let you pick one job out of eight and cancel it, which
 * needs the values each was submitted with — and `values_json` alone cannot give
 * that, because its keys are `3.steps` and the labels live in the workflow's
 * schema, which may have been re-arranged or deleted since. Recording the
 * rendered summary at submit time keeps the listing honest about what ran.
 */
MIGRATIONS.push(`
ALTER TABLE generations ADD COLUMN params_json TEXT NOT NULL DEFAULT '[]';
`);

/**
 * v6: named snapshots of the whole variation setup.
 *
 * Random prompting and parameter variation are one thing in use — "this kind of
 * picture, made this way" — so they are saved and loaded together rather than as
 * two halves that can disagree.
 */
MIGRATIONS.push(`
CREATE TABLE variation_presets (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  config_json TEXT NOT NULL DEFAULT '{}',
  created_at  INTEGER NOT NULL
);

CREATE INDEX idx_variation_presets_created ON variation_presets (created_at);
`);

/**
 * v7: whatever the graph printed rather than drew.
 *
 * "Preview as text" nodes report what a workflow decided — an expanded wildcard,
 * a generated caption, a computed size. They were being dropped on the floor,
 * which made the one output whose entire purpose is diagnosis invisible.
 */
MIGRATIONS.push(`
ALTER TABLE generations ADD COLUMN texts_json TEXT NOT NULL DEFAULT '[]';
`);

/**
 * v8: "keep this" without having to rate it.
 *
 * Ratings are a judgement, and being made to pass one on every picture you want
 * to survive the cleanup is the wrong tax. Keeping is the same promise —
 * archived locally, never swept — with nothing said about whether it is any
 * good.
 */
MIGRATIONS.push(`
ALTER TABLE images ADD COLUMN kept INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_images_kept ON images (kept);
`);

/**
 * v9: workflows read from the ComfyUI folder, and which of them to offer.
 *
 * Reading a whole installation finds every workflow anybody ever saved. That is
 * the right thing to have imported and the wrong thing to scroll past before
 * every render, so each one carries whether it belongs in the picker, and where
 * it came from — the path is what stops a second scan importing it again.
 */
MIGRATIONS.push(`
ALTER TABLE workflows ADD COLUMN visible INTEGER NOT NULL DEFAULT 1;
ALTER TABLE workflows ADD COLUMN source_path TEXT;

CREATE UNIQUE INDEX idx_workflows_source ON workflows (source_path)
  WHERE source_path IS NOT NULL;
`);

/**
 * v10: conversations with the local language model.
 *
 * Kept in the database rather than in the browser because a conversation is the
 * working record of how a prompt came about — the tool that builds one reads
 * back over it — and because the phone that started it is rarely the only thing
 * that will want to see it.
 */
MIGRATIONS.push(`
CREATE TABLE chats (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_chats_updated ON chats (updated_at DESC);

CREATE TABLE chat_messages (
  id          TEXT PRIMARY KEY,
  chat_id     TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  role        TEXT NOT NULL,
  content     TEXT NOT NULL DEFAULT '',
  -- The model's reasoning, apart from its answer: shown collapsed, and never
  -- sent back as context, which is what the models themselves ask for.
  thinking    TEXT,
  -- Images, as data URIs, so a conversation carries its own attachments.
  attachments_json TEXT NOT NULL DEFAULT '[]',
  tool_call_json   TEXT,
  tool_result_json TEXT,
  created_at  INTEGER NOT NULL
);

CREATE INDEX idx_chat_messages_chat ON chat_messages (chat_id, created_at);
`);

/**
 * v11: which run a message started.
 *
 * A prompt accepted in the chat is generated from the chat, and the picture it
 * produced belongs next to the conversation that produced it. Only the run's id
 * is stored: the gallery already owns the pictures, and copying them in here
 * would mean two places to delete from and a conversation that grows by a
 * megabyte every time you say yes.
 */
MIGRATIONS.push(`
ALTER TABLE chat_messages ADD COLUMN generation_id TEXT;
`);

/**
 * v12: the prompt a run in the chat was queued with.
 *
 * Kept on the message rather than read back from the generation, so the diff
 * against the conversation's previous prompt can be worked out from the
 * transcript alone — and so it survives the run being swept out of the gallery
 * while the conversation that produced it stays.
 */
MIGRATIONS.push(`
ALTER TABLE chat_messages ADD COLUMN prompt TEXT;
`);

/**
 * v13: parameter studies.
 *
 * A study is a plan plus a pile of ratings. The plan is drawn once, up front,
 * and stored shot by shot rather than re-derived — it has to survive the phone
 * locking, the browser closing and the box rebooting, and a study resumed on
 * Thursday must continue the run started on Tuesday rather than draw a fresh
 * one.
 *
 * The rating lives on the shot rather than on the image because it is a
 * different kind of judgement from the gallery's stars: three ordinal levels,
 * given blind and fast, meant to be counted rather than browsed.
 *
 * `generations.source` gains a third value, `study`, which is what keeps
 * hundreds of near-identical frames out of the gallery. No schema change is
 * needed for that — the column has been free text since v6.
 */
MIGRATIONS.push(`
CREATE TABLE studies (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  workflow_id   TEXT REFERENCES workflows(id) ON DELETE SET NULL,
  workflow_name TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'draft',
  factors_json  TEXT NOT NULL DEFAULT '[]',
  base_json     TEXT NOT NULL DEFAULT '{}',
  sampling      TEXT NOT NULL DEFAULT 'lhs',
  shot_count    INTEGER NOT NULL DEFAULT 40,
  seed          INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE INDEX idx_studies_updated ON studies (updated_at DESC);

CREATE TABLE study_shots (
  id            TEXT PRIMARY KEY,
  study_id      TEXT NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
  -- Position in the plan, which is already in cost order: running the study is
  -- a walk from the lowest pending ordinal upwards.
  ordinal       INTEGER NOT NULL,
  values_json   TEXT NOT NULL DEFAULT '{}',
  status        TEXT NOT NULL DEFAULT 'pending',
  generation_id TEXT REFERENCES generations(id) ON DELETE SET NULL,
  -- 1 poor, 2 middling, 3 good. NULL until it has been looked at.
  rating        INTEGER,
  rated_at      INTEGER,
  UNIQUE (study_id, ordinal)
);

CREATE INDEX idx_study_shots_run ON study_shots (study_id, status, ordinal);
CREATE INDEX idx_study_shots_rating ON study_shots (study_id, rating);
`);

/**
 * v14: one list of connections, and a collection of named system prompts.
 *
 * The model server used to be an address buried in the chat settings while
 * ComfyUI had a whole screen of presets, which made no sense: they are the same
 * problem — a box you rented an hour ago, a token, a certificate nobody signed —
 * asked twice, in two different ways. `kind` puts them in one list, and
 * `is_active` becomes "in use for its kind", so a ComfyUI and a model server are
 * both active at once.
 *
 * System prompts move the other way: out of the things that used them and into
 * a list of their own, matched back to a workflow's text input by name.
 */
MIGRATIONS.push(`
ALTER TABLE connections ADD COLUMN kind TEXT NOT NULL DEFAULT 'comfy';

CREATE TABLE system_prompts (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  text       TEXT NOT NULL DEFAULT '',
  position   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_system_prompts_order ON system_prompts (position, created_at);
`);

/**
 * v11: outputs that move.
 *
 * A video workflow leaves an mp4 or a webm where a picture used to be, and the
 * row is otherwise the same row — same rating, same keeping, same archive. What
 * differs is everything about handling it, so it is recorded once here rather
 * than re-derived from the filename at every call site.
 *
 * Existing rows are pictures by definition: nothing before this could produce
 * anything else. The backfill is for imported and generated files whose
 * extension says otherwise, which cost nothing to catch now.
 */
MIGRATIONS.push(`
ALTER TABLE images ADD COLUMN kind TEXT NOT NULL DEFAULT 'image';
-- How long it runs, once the browser or the archive has managed to measure it.
ALTER TABLE images ADD COLUMN duration_ms INTEGER;

UPDATE images SET kind = 'video'
 WHERE lower(filename) LIKE '%.mp4'
    OR lower(filename) LIKE '%.webm'
    OR lower(filename) LIKE '%.mkv'
    OR lower(filename) LIKE '%.mov'
    OR lower(filename) LIKE '%.m4v'
    OR lower(filename) LIKE '%.ogv'
    OR lower(filename) LIKE '%.avi'
    OR lower(filename) LIKE '%.gif';
`);

/**
 * v12: notes about what the user likes.
 *
 * `name` and `text` hold ciphertext, not words. This is a description of a
 * person's taste sitting on a disk indefinitely, and it is read by a model
 * rather than displayed on a screen — so the one place it must be legible is
 * inside a running, signed-in server, which is exactly what the vault gives.
 * Everything the app needs to *manage* the notes without reading them —
 * ordering, switching one off, which category a note is under — stays in the
 * clear, so the list works the same whether or not anyone has signed in.
 *
 * Deleting a category keeps its notes and sets them loose, because a note is
 * something the user wrote and a category is only a heading over it.
 */
MIGRATIONS.push(`
CREATE TABLE taste_categories (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  active     INTEGER NOT NULL DEFAULT 1,
  position   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE taste_entries (
  id          TEXT PRIMARY KEY,
  category_id TEXT REFERENCES taste_categories (id) ON DELETE SET NULL,
  text        TEXT NOT NULL,
  active      INTEGER NOT NULL DEFAULT 1,
  position    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE INDEX idx_taste_categories_order ON taste_categories (position, created_at);
CREATE INDEX idx_taste_entries_order ON taste_entries (category_id, position, created_at);
`);

/**
 * v13: notes that apply whatever the influence setting says.
 *
 * The scale governs how much of the space you left gets filled from the notes,
 * which means a concrete request pushes all of them aside. Some of them should
 * not be pushed aside — a format you always want, a thing you never want in a
 * picture — and those matter most in exactly the case the scale silences them.
 * `always_on` marks one of those. Spelled with the suffix because `ALWAYS` is a
 * keyword in SQLite's `GENERATED ALWAYS AS`.
 */
MIGRATIONS.push(`
ALTER TABLE taste_entries ADD COLUMN always_on INTEGER NOT NULL DEFAULT 0;
`);

interface ChatRow {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
}

interface ChatMessageRow {
  id: string;
  chat_id: string;
  role: string;
  content: string;
  thinking: string | null;
  attachments_json: string;
  tool_call_json: string | null;
  tool_result_json: string | null;
  generation_id: string | null;
  prompt: string | null;
  created_at: number;
}

/**
 * Stored settings over the defaults, one group deep.
 *
 * A group is stored as one JSON blob, and a blob written by an older version —
 * or by a client patching part of it — simply does not have the fields added
 * since. Filling those in from the defaults is what the top level always did;
 * doing it one level further down is the same promise for a group that has
 * groups of its own, which the chat's settings now do. Without it, adding a
 * field means every existing install reads it as `undefined` and every caller
 * has to defend against that separately.
 *
 * Deliberately not deeper, and never into arrays: a nested list is a value the
 * user set, and merging defaults into it would resurrect entries they removed.
 */
function mergeSetting(defaults: object, stored: object): object {
  const out: Record<string, unknown> = { ...defaults };

  for (const [key, value] of Object.entries(stored)) {
    const fallback = (defaults as Record<string, unknown>)[key];
    const nested =
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      fallback !== null &&
      typeof fallback === 'object' &&
      !Array.isArray(fallback);

    out[key] = nested ? { ...(fallback as object), ...(value as object) } : value;
  }

  return out;
}

/** Settings held as a group under one key rather than as a single value. */
function isObjectSetting(key: string): boolean {
  const value = (DEFAULT_SETTINGS as unknown as Record<string, unknown>)[key];
  return typeof value === 'object' && value !== null;
}

function toChat(row: ChatRow): ChatConversation {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toChatMessage(row: ChatMessageRow): ChatMessage {
  return {
    id: row.id,
    role: row.role as ChatMessage['role'],
    content: row.content,
    ...(row.thinking ? { thinking: row.thinking } : {}),
    attachments: parseJson<ChatMessage['attachments']>(row.attachments_json, []),
    ...(row.tool_call_json
      ? { toolCall: parseJson<ChatMessage['toolCall']>(row.tool_call_json, undefined) }
      : {}),
    ...(row.tool_result_json
      ? { toolResult: parseJson<ChatMessage['toolResult']>(row.tool_result_json, undefined) }
      : {}),
    ...(row.generation_id ? { generationId: row.generation_id } : {}),
    ...(row.prompt ? { prompt: row.prompt } : {}),
    createdAt: row.created_at,
  };
}

interface WorkflowRow {
  id: string;
  name: string;
  graph_json: string;
  schema_json: string;
  overrides_json: string;
  last_values_json: string;
  created_at: number;
  updated_at: number;
  visible: number;
  source_path: string | null;
}

interface GenerationRow {
  id: string;
  prompt_id: string;
  workflow_id: string | null;
  workflow_name: string;
  status: string;
  error: string | null;
  values_json: string;
  seeds_json: string;
  params_json: string;
  texts_json: string;
  title: string;
  created_at: number;
  completed_at: number | null;
  source: string;
}

export interface ImageRow {
  id: number;
  generation_id: string;
  node_id: string;
  filename: string;
  subfolder: string;
  type: string;
  rating: number;
  kept: number;
  archived_path: string | null;
  archived_bytes: number | null;
  thumb_path: string | null;
  thumb_bytes: number | null;
  width: number | null;
  height: number | null;
  encrypted: number;
  tile_span: string | null;
  kind: string;
  duration_ms: number | null;
}

interface FavoriteRow {
  id: string;
  image_id: number | null;
  generation_id: string | null;
  workflow_id: string | null;
  title: string;
  note: string | null;
  rating: number;
  values_json: string;
  image_json: string;
  created_at: number;
}

interface LayoutRow {
  id: string;
  workflow_id: string;
  name: string;
  overrides_json: string;
  is_active: number;
  created_at: number;
}

interface PromptBlockRow {
  id: string;
  name: string;
  category: string;
  text: string;
  position: number;
  created_at: number;
}

/**
 * A taste category as stored: `name` is ciphertext, not a heading.
 *
 * Exported because the layer that can read it lives elsewhere — see
 * `server/src/taste.ts`. Everything here deliberately stops at the encrypted
 * blob, so the database layer never needs the key.
 */
export interface TasteCategoryRow {
  id: string;
  name: string;
  active: number;
  position: number;
  created_at: number;
}

/** A taste note as stored; `text` is ciphertext. */
export interface TasteEntryRow {
  id: string;
  category_id: string | null;
  text: string;
  active: number;
  /** 1 when this one applies whatever the influence setting says. */
  always_on: number;
  position: number;
  created_at: number;
}

interface ConnectionRow {
  id: string;
  kind: string;
  name: string;
  url: string;
  auth_mode: string;
  username: string | null;
  secret: string | null;
  allow_self_signed: number;
  is_active: number;
  created_at: number;
}

interface PresetRow {
  id: string;
  workflow_id: string;
  name: string;
  values_json: string;
  created_at: number;
}

interface SystemPromptRow {
  id: string;
  name: string;
  text: string;
  position: number;
  created_at: number;
  updated_at: number;
}

function toSystemPrompt(row: SystemPromptRow): SystemPrompt {
  return {
    id: row.id,
    name: row.name,
    text: row.text,
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Tolerate a corrupt/legacy JSON column rather than crashing the whole request. */
function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Trailing slashes break path concatenation in the ComfyUI client. */
function normaliseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

function toConnectionSummary(row: ConnectionRow): ConnectionSummary {
  return {
    id: row.id,
    kind: row.kind === 'llama' ? 'llama' : 'comfy',
    name: row.name,
    url: row.url,
    authMode: row.auth_mode as ConnectionAuthMode,
    username: row.username,
    allowSelfSigned: row.allow_self_signed === 1,
    hasSecret: Boolean(row.secret),
    isActive: row.is_active === 1,
    createdAt: row.created_at,
  };
}

/** `'2x1'` -> `{ cols: 2, rows: 1 }`, ignoring anything malformed. */
function parseTileSpan(raw: string | null): TileSpan | null {
  if (!raw) return null;
  const match = /^(\d)x(\d)$/.exec(raw);
  if (!match) return null;
  const cols = Number(match[1]);
  const rows = Number(match[2]);
  if (cols < 1 || cols > 4 || rows < 1 || rows > 4) return null;
  return { cols, rows };
}

export function toGenerationImage(row: ImageRow): GenerationImage {
  return {
    id: row.id,
    nodeId: row.node_id,
    filename: row.filename,
    subfolder: row.subfolder,
    type: row.type,
    rating: row.rating ?? 0,
    kept: Boolean(row.kept),
    archived: Boolean(row.archived_path),
    hasThumbnail: Boolean(row.thumb_path),
    kind: row.kind === 'video' ? 'video' : 'image',
    durationMs: row.duration_ms ?? null,
    width: row.width,
    height: row.height,
    tileSpan: parseTileSpan(row.tile_span),
  };
}

/**
 * `live` is the gallery row this favourite points at, when it still exists.
 *
 * The stored `image_json` is a snapshot, and it has to be: a favourite outlives
 * the run it came from, which is most of what makes it a favourite. But while
 * the run *is* still there, the snapshot is stale the moment anything about the
 * picture changes — a rating, a tile size, or the poster a browser captured for
 * a video, which is the difference between a favourite tile showing the clip
 * and showing a grey plate forever.
 */
/**
 * The favourite's own copy of the picture, made current.
 *
 * A snapshot written before videos existed says nothing about what it is, and
 * every reader would otherwise have to cope with a missing field forever. The
 * filename has the answer, and it always did.
 */
function snapshotImage(imageJson: string): GenerationImage | null {
  const image = parseJson<GenerationImage | null>(imageJson, null);
  if (!image?.filename) return image;
  return {
    ...image,
    kind: image.kind ?? mediaKindOf(image.filename),
    durationMs: image.durationMs ?? null,
  };
}

function toFavorite(
  row: FavoriteRow,
  workflowAvailable: boolean,
  archived: boolean,
  live?: ImageRow | null,
): Favorite {
  const image = live ? toGenerationImage(live) : snapshotImage(row.image_json);
  return {
    archived,
    id: row.id,
    title: row.title,
    note: row.note,
    rating: row.rating,
    workflowId: row.workflow_id,
    workflowAvailable,
    values: parseJson<ParamValues>(row.values_json, {}),
    image,
    generationId: row.generation_id,
    createdAt: row.created_at,
  };
}

function toLayout(row: LayoutRow): FormLayout {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    name: row.name,
    overrides: parseJson<FieldOverrides>(row.overrides_json, {}),
    isActive: row.is_active === 1,
    createdAt: row.created_at,
  };
}

function toPromptBlock(row: PromptBlockRow): PromptBlock {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    text: row.text,
    position: row.position,
    createdAt: row.created_at,
  };
}

function toPreset(row: PresetRow): WorkflowPreset {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    name: row.name,
    values: parseJson<ParamValues>(row.values_json, {}),
    createdAt: row.created_at,
  };
}

/** Settings key holding the random-prompt configuration as JSON. */
const RANDOM_PROMPT_KEY = 'random_prompt';

const DEFAULT_SETTINGS: AppSettings = {
  upscaleWorkflowId: null,
  img2imgWorkflowId: null,
  defaultWorkflowId: null,
  comfyRoot: null,
  queuePolicy: 'append',
  chat: {
    model: '',
    maxTokens: 0,
    thinking: true,
    // Latent's own wording until a saved system prompt is chosen instead.
    systemPromptId: null,
    /*
     * The defaults are what makes the module usable rather than annoying.
     *
     * `build_prompt` waits to be asked, because being handed a finished prompt
     * while you are still working out what you want ends the conversation the
     * module exists to have. `ask_user` is the opposite: a question costs one
     * tap and improves everything after it.
     */
    tools: {
      prompt_blocks: 'on-request',
      build_prompt: 'on-request',
      /*
       * Questions start high and the scale is shifted for this one tool.
       *
       * A question costs one tap and improves everything after it, and the
       * failure mode people actually hit is a model that lists three options in
       * prose — which then have to be typed back in by hand.
       */
      ask_user: 'always',
    },
    /*
     * The picture is shown back to the model, and it is picky about it.
     *
     * On by default because the alternative is worse in a way that is easy to
     * miss: the turn after a render used to be the model talking confidently
     * about a picture it had never seen. Most model servers worth running are
     * multimodal, and the ones that are not fall back to that same turn without
     * the picture rather than failing.
     *
     * `balanced`, because the useful proposal is the one that names something
     * genuinely absent. A stricter default would rewrite the prompt over a
     * shade of light and train you to ignore it.
     */
    review: { enabled: true, threshold: 'balanced', keepInView: 2, askWhen: 'unsure' },
    /*
     * Enough detail to make a picture, not so much that it makes only one.
     *
     * The failure at either end is real: a sparse prompt varies wildly between
     * seeds, and an elaborate one produces exactly what it says and nothing
     * you did not think of. The middle is where a conversation about a picture
     * usually wants to land.
     */
    promptDetail: 'balanced',
    /*
     * Your taste fills the space you leave, and no more.
     *
     * The default is the behaviour people describe when they ask for this at
     * all: "when I do not know what I want, start from what I like" — and,
     * emphatically, leave what I did ask for alone.
     */
    taste: 'hints',
    generation: { workflowId: '', values: {} },
    imageSize: 3,
    promptButton: 'generate',
    showDiff: { inDialog: true, underPicture: true },
    /*
     * Nothing switched on: the model server keeps the sampling it was launched
     * with, which was chosen for the model behind it. Every parameter is opt-in
     * from there.
     */
    sampling: defaultSampling(),
  },
  importRoot: null,
  inputRoot: null,
  autoDeleteHours: null,
  /*
   * The convention this ships with: mark the workflows meant for the phone
   * `API_…` in the editor and the scan takes those and nothing else. Set it
   * empty to go back to reading the whole installation.
   */
  workflowPrefix: 'API_',
};

export class Store {
  private readonly db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  /**
   * Bring the database up to the current schema.
   *
   * Each migration runs in its own transaction alongside the `user_version`
   * bump, so a failure part-way leaves the database on the last good version
   * rather than half-migrated.
   */
  private migrate(): void {
    const current = Number(this.db.pragma('user_version', { simple: true }) ?? 0);

    for (let version = current; version < MIGRATIONS.length; version += 1) {
      const sql = MIGRATIONS[version];
      if (!sql) continue;

      this.db.exec('BEGIN');
      try {
        this.db.exec(sql);
        this.db.pragma(`user_version = ${version + 1}`);
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw new Error(
          `Database migration ${version + 1} failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  get schemaVersion(): number {
    return Number(this.db.pragma('user_version', { simple: true }) ?? 0);
  }

  /* ---------------------------------------------------------------- */
  /* Chat                                                              */
  /* ---------------------------------------------------------------- */

  listChats(limit = 50): ChatConversation[] {
    return this.db
      .prepare<[number], ChatRow>('SELECT * FROM chats ORDER BY updated_at DESC LIMIT ?')
      .all(limit)
      .map(toChat);
  }

  createChat(id: string, title = ''): ChatConversation {
    const now = Date.now();
    this.db
      .prepare('INSERT INTO chats (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run(id, title, now, now);
    return { id, title, createdAt: now, updatedAt: now };
  }

  getChat(id: string): ChatConversationDetail | null {
    const row = this.db.prepare<[string], ChatRow>('SELECT * FROM chats WHERE id = ?').get(id);
    if (!row) return null;

    const messages = this.db
      .prepare<[string], ChatMessageRow>(
        'SELECT * FROM chat_messages WHERE chat_id = ? ORDER BY created_at, rowid',
      )
      .all(id)
      .map(toChatMessage);

    return { ...toChat(row), messages };
  }

  /** Only ever set from the first thing the user said, so a list is scannable. */
  renameChat(id: string, title: string): void {
    this.db.prepare('UPDATE chats SET title = ?, updated_at = ? WHERE id = ?').run(
      title.slice(0, 120),
      Date.now(),
      id,
    );
  }

  deleteChat(id: string): void {
    this.db.prepare('DELETE FROM chat_messages WHERE chat_id = ?').run(id);
    this.db.prepare('DELETE FROM chats WHERE id = ?').run(id);
  }

  insertChatMessage(chatId: string, message: ChatMessage): void {
    this.db
      .prepare(
        `INSERT INTO chat_messages
           (id, chat_id, role, content, thinking, attachments_json, tool_call_json, tool_result_json, generation_id, prompt, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        message.id,
        chatId,
        message.role,
        message.content,
        message.thinking ?? null,
        JSON.stringify(message.attachments ?? []),
        message.toolCall ? JSON.stringify(message.toolCall) : null,
        message.toolResult ? JSON.stringify(message.toolResult) : null,
        message.generationId ?? null,
        message.prompt ?? null,
        message.createdAt,
      );
    this.db.prepare('UPDATE chats SET updated_at = ? WHERE id = ?').run(Date.now(), chatId);
  }

  /**
   * Drop everything after a message, keeping the message itself.
   *
   * Ordered by `(created_at, rowid)` exactly as `getChat` reads them, so "after"
   * here means the same thing it means on screen. Two messages inserted in the
   * same millisecond are ordered by rowid, and comparing on `created_at` alone
   * would take one of them with it.
   */
  truncateChat(chatId: string, afterMessageId: string): number {
    const anchor = this.db
      .prepare<[string], { created_at: number; rowid: number }>(
        'SELECT created_at, rowid FROM chat_messages WHERE id = ?',
      )
      .get(afterMessageId);
    if (!anchor) return 0;

    const result = this.db
      .prepare(
        `DELETE FROM chat_messages
          WHERE chat_id = ?
            AND (created_at > ? OR (created_at = ? AND rowid > ?))`,
      )
      .run(chatId, anchor.created_at, anchor.created_at, anchor.rowid);

    this.db.prepare('UPDATE chats SET updated_at = ? WHERE id = ?').run(Date.now(), chatId);
    return result.changes;
  }

  /** Record what the user decided about a tool call, on the message that asked. */
  setChatToolResult(messageId: string, result: ChatToolResult): void {
    this.db
      .prepare('UPDATE chat_messages SET tool_result_json = ? WHERE id = ?')
      .run(JSON.stringify(result), messageId);
  }

  close(): void {
    this.db.close();
  }

  /* ---------------------------------------------------------------- */
  /* Workflows                                                         */
  /* ---------------------------------------------------------------- */

  listWorkflows(): WorkflowSummary[] {
    const rows = this.db
      .prepare<[], WorkflowRow>('SELECT * FROM workflows ORDER BY updated_at DESC')
      .all();
    return rows.map((row) => this.toWorkflowSummary(row));
  }

  getWorkflow(id: string): WorkflowDetail | null {
    const row = this.db
      .prepare<[string], WorkflowRow>('SELECT * FROM workflows WHERE id = ?')
      .get(id);
    if (!row) return null;
    return {
      ...this.toWorkflowSummary(row),
      graph: parseJson<ApiWorkflow>(row.graph_json, {}),
      schema: parseJson<ParamSchema>(row.schema_json, {
        version: 1,
        fields: [],
        outputNodeIds: [],
        capabilities: { img2img: false, seeded: false, video: false },
        missingNodeTypes: [],
      }),
      overrides: parseJson<FieldOverrides>(row.overrides_json, {}),
      lastValues: parseJson<ParamValues>(row.last_values_json, {}),
      layouts: this.listLayouts(row.id),
      activeLayoutId: this.getActiveLayout(row.id)?.id ?? null,
    };
  }

  insertWorkflow(input: {
    id: string;
    name: string;
    graph: ApiWorkflow;
    schema: ParamSchema;
    lastValues: ParamValues;
    /** Where a scanned workflow came from, so a re-scan updates rather than duplicates. */
    sourcePath?: string | null;
    visible?: boolean;
  }): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO workflows
           (id, name, graph_json, schema_json, overrides_json, last_values_json,
            created_at, updated_at, visible, source_path)
         VALUES (?, ?, ?, ?, '{}', ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.name,
        JSON.stringify(input.graph),
        JSON.stringify(input.schema),
        JSON.stringify(input.lastValues),
        now,
        now,
        input.visible === false ? 0 : 1,
        input.sourcePath ?? null,
      );
  }

  findWorkflowBySourcePath(sourcePath: string): WorkflowSummary | null {
    const row = this.db
      .prepare<[string], WorkflowRow>('SELECT * FROM workflows WHERE source_path = ?')
      .get(sourcePath);
    return row ? this.toWorkflowSummary(row) : null;
  }

  setWorkflowVisible(id: string, visible: boolean): void {
    this.db
      .prepare('UPDATE workflows SET visible = ?, updated_at = ? WHERE id = ?')
      .run(visible ? 1 : 0, Date.now(), id);
  }

  updateWorkflow(
    id: string,
    patch: {
      name?: string;
      schema?: ParamSchema;
      overrides?: FieldOverrides;
      lastValues?: ParamValues;
    },
  ): void {
    const sets: string[] = [];
    const params: unknown[] = [];

    if (patch.name !== undefined) {
      sets.push('name = ?');
      params.push(patch.name);
    }
    if (patch.schema !== undefined) {
      sets.push('schema_json = ?');
      params.push(JSON.stringify(patch.schema));
    }
    if (patch.overrides !== undefined) {
      sets.push('overrides_json = ?');
      params.push(JSON.stringify(patch.overrides));
    }
    if (patch.lastValues !== undefined) {
      sets.push('last_values_json = ?');
      params.push(JSON.stringify(patch.lastValues));
    }
    if (sets.length === 0) return;

    sets.push('updated_at = ?');
    params.push(Date.now(), id);
    this.db.prepare(`UPDATE workflows SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  deleteWorkflow(id: string): void {
    // Generations keep their denormalised workflow_name, so history survives.
    this.db.prepare('UPDATE generations SET workflow_id = NULL WHERE workflow_id = ?').run(id);
    this.db.prepare('DELETE FROM workflows WHERE id = ?').run(id);
  }

  private toWorkflowSummary(row: WorkflowRow): WorkflowSummary {
    const schema = parseJson<ParamSchema>(row.schema_json, {
      version: 1,
      fields: [],
      outputNodeIds: [],
      capabilities: { img2img: false, seeded: false, video: false },
      missingNodeTypes: [],
    });
    return {
      id: row.id,
      name: row.name,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      capabilities: schema.capabilities,
      missingNodeTypes: schema.missingNodeTypes ?? [],
      visible: row.visible !== 0,
      sourcePath: row.source_path,
      producesVideo: schema.capabilities?.video === true,
    };
  }

  /* ---------------------------------------------------------------- */
  /* Generations                                                       */
  /* ---------------------------------------------------------------- */

  insertGeneration(record: {
    id: string;
    promptId: string;
    workflowId: string | null;
    workflowName: string;
    title: string;
    values: ParamValues;
    seeds: Record<string, number>;
    params?: ParamSummaryItem[];
    /**
     * Where the run came from.
     *
     * `study` is what keeps a parameter study's hundreds of near-identical
     * frames out of the gallery. Everything else about the row is ordinary,
     * which is what lets a shot join the gallery later by changing this one
     * column rather than by moving between tables.
     */
    source?: 'comfy' | 'study';
  }): void {
    this.db
      .prepare(
        `INSERT INTO generations
           (id, prompt_id, workflow_id, workflow_name, status, error, values_json, seeds_json, params_json, title, created_at, completed_at, source)
         VALUES (?, ?, ?, ?, 'queued', NULL, ?, ?, ?, ?, ?, NULL, ?)`,
      )
      .run(
        record.id,
        record.promptId,
        record.workflowId,
        record.workflowName,
        JSON.stringify(record.values),
        JSON.stringify(record.seeds),
        JSON.stringify(record.params ?? []),
        record.title,
        Date.now(),
        record.source ?? 'comfy',
      );
  }

  setGenerationStatus(promptId: string, status: GenerationStatus, error?: string | null): void {
    const done = status === 'completed' || status === 'failed' || status === 'cancelled';
    this.db
      .prepare(
        `UPDATE generations
            SET status = ?, error = ?, completed_at = CASE WHEN ? THEN ? ELSE completed_at END
          WHERE prompt_id = ?`,
      )
      .run(status, error ?? null, done ? 1 : 0, Date.now(), promptId);
  }

  /**
   * Takes bare ComfyUI refs; rating and archive state are added later by the user.
   *
   * Whether each one moves is settled here, from its name, so nothing further
   * down has to guess: a `.mp4` is a video wherever it turns up, and the key
   * ComfyUI happened to file it under — `images`, `gifs`, `videos` — says
   * nothing reliable about that.
   */
  addImages(promptId: string, nodeId: string, images: (ComfyImageRef & { kind?: MediaKind })[]): void {
    const generation = this.db
      .prepare<[string], { id: string }>('SELECT id FROM generations WHERE prompt_id = ?')
      .get(promptId);
    if (!generation) return;

    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO images (generation_id, node_id, filename, subfolder, type, kind)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const insertAll = this.db.transaction((items: (ComfyImageRef & { kind?: MediaKind })[]) => {
      for (const image of items) {
        insert.run(
          generation.id,
          nodeId,
          image.filename,
          image.subfolder ?? '',
          image.type ?? 'output',
          image.kind ?? mediaKindOf(image.filename),
        );
      }
    });
    insertAll(images);
  }

  /** Record how long a video runs, once something has measured it. */
  setImageDuration(imageId: number, durationMs: number): void {
    this.db
      .prepare('UPDATE images SET duration_ms = ? WHERE id = ? AND duration_ms IS NULL')
      .run(Math.round(durationMs), imageId);
  }

  /**
   * Append text a node produced to the run it belongs to.
   *
   * Appended rather than replaced: a graph can have several preview nodes, and
   * they report one at a time as each finishes.
   */
  addTextOutputs(promptId: string, texts: TextOutput[]): void {
    if (texts.length === 0) return;
    const row = this.db
      .prepare<[string], { id: string; texts_json: string }>(
        'SELECT id, texts_json FROM generations WHERE prompt_id = ?',
      )
      .get(promptId);
    if (!row) return;

    const existing = parseJson<TextOutput[]>(row.texts_json, []);
    this.db
      .prepare('UPDATE generations SET texts_json = ? WHERE id = ?')
      .run(JSON.stringify([...existing, ...texts]), row.id);
  }

  getGenerationByPromptId(promptId: string): GenerationRecord | null {
    const row = this.db
      .prepare<[string], GenerationRow>('SELECT * FROM generations WHERE prompt_id = ?')
      .get(promptId);
    return row ? this.hydrateGeneration(row) : null;
  }

  getGeneration(id: string): GenerationRecord | null {
    const row = this.db
      .prepare<[string], GenerationRow>('SELECT * FROM generations WHERE id = ?')
      .get(id);
    return row ? this.hydrateGeneration(row) : null;
  }

  /**
   * Keyset pagination on `(created_at, id)`. Cursor-based rather than OFFSET so
   * that new generations arriving mid-scroll don't shift the page boundaries.
   */
  /**
   * The best rating anywhere in a run, as SQL.
   *
   * A run is a batch, and sorting batches by their best picture is what people
   * mean by "show me the good ones" — the alternative, an average, buries a
   * five-star image under the three near-misses it came with.
   */
  private static readonly BEST_RATING =
    '(SELECT COALESCE(MAX(rating), 0) FROM images WHERE images.generation_id = generations.id)';

  listGenerations(options: {
    limit: number;
    cursor?: string | null;
    workflowId?: string | null;
    /** Only generations holding an image rated at least this highly. */
    minRating?: number;
    sort?: GallerySort;
  }): {
    items: GenerationRecord[];
    nextCursor: string | null;
  } {
    const limit = Math.min(Math.max(options.limit, 1), 100);
    const where: string[] = [];
    const params: unknown[] = [];

    /*
     * Keyset pagination, in whichever direction the sort runs.
     *
     * An offset would skip or repeat rows as the queue drains underneath —
     * which it constantly does — so the cursor is the last row's own key and
     * the comparison flips with the order. Rating pages by rating first and
     * then by time, because a page boundary in the middle of forty four-star
     * pictures has to land somewhere deterministic.
     */
    const sort: GallerySort = options.sort ?? 'newest';
    if (options.cursor) {
      const [createdAt, id, rating] = options.cursor.split('_');
      const ts = Number(createdAt);
      if (Number.isFinite(ts) && id) {
        if (sort === 'oldest') {
          where.push('(created_at > ? OR (created_at = ? AND id > ?))');
          params.push(ts, ts, id);
        } else if (sort === 'rating') {
          const stars = Number(rating ?? 0);
          where.push(
            `(${Store.BEST_RATING} < ?
              OR (${Store.BEST_RATING} = ? AND (created_at < ? OR (created_at = ? AND id < ?))))`,
          );
          params.push(stars, stars, ts, ts, id);
        } else {
          where.push('(created_at < ? OR (created_at = ? AND id < ?))');
          params.push(ts, ts, id);
        }
      }
    }
    if (options.workflowId) {
      where.push('workflow_id = ?');
      params.push(options.workflowId);
    }
    if (options.minRating && options.minRating > 0) {
      where.push(
        'EXISTS (SELECT 1 FROM images WHERE images.generation_id = generations.id AND images.rating >= ?)',
      );
      params.push(options.minRating);
    }

    /*
     * A run you stopped on purpose is not a gallery entry.
     *
     * Cancelling used to leave a "cancelled" placeholder behind, so clearing a
     * queue of eight filled the top of the gallery with eight tombstones for
     * pictures that were never made. A cancel that landed mid-batch does keep
     * whatever images it managed to produce — those are real results.
     */
    where.push(
      `(status <> 'cancelled'
        OR EXISTS (SELECT 1 FROM images WHERE images.generation_id = generations.id))`,
    );

    /*
     * A parameter study is not gallery material.
     *
     * Its whole method is producing hundreds of frames that differ by one
     * setting — exactly the pile the gallery's cleanup and its day sections
     * exist to prevent. They live in the study module, where a near-identical
     * neighbour is the point, and a shot you decide to keep is re-marked
     * `comfy` and joins the gallery properly.
     */
    where.push("source <> 'study'");

    const order =
      sort === 'oldest'
        ? 'created_at ASC, id ASC'
        : sort === 'rating'
          ? `${Store.BEST_RATING} DESC, created_at DESC, id DESC`
          : 'created_at DESC, id DESC';

    const sql = `SELECT *, ${Store.BEST_RATING} AS best_rating FROM generations
                 ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                 ORDER BY ${order}
                 LIMIT ?`;
    const rows = this.db
      .prepare<unknown[], GenerationRow & { best_rating: number }>(sql)
      .all(...params, limit + 1);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page.at(-1);

    return {
      items: page.map((row) => this.hydrateGeneration(row)),
      nextCursor:
        hasMore && last ? `${last.created_at}_${last.id}_${last.best_rating ?? 0}` : null,
    };
  }

  deleteImage(imageId: number): void {
    this.db.prepare('DELETE FROM images WHERE id = ?').run(imageId);
  }

  deleteGeneration(id: string): void {
    this.db.prepare('DELETE FROM images WHERE generation_id = ?').run(id);
    this.db.prepare('DELETE FROM generations WHERE id = ?').run(id);
  }

  /**
   * Generations left "running" when the process died can never complete — the
   * upstream events that would finish them are long gone. Reconciled at boot.
   */
  /**
   * Runs this app still believes are in flight.
   *
   * `olderThanMs` keeps a submit that is seconds old out of it: ComfyUI can take
   * a moment to admit a prompt exists, and reconciling against a queue that has
   * not caught up yet would cancel the job you just started.
   */
  listUnfinished(olderThanMs = 0): GenerationRecord[] {
    return this.db
      .prepare<[number], GenerationRow>(
        `SELECT * FROM generations
          WHERE status IN ('queued', 'running') AND created_at <= ?
          ORDER BY created_at ASC`,
      )
      .all(Date.now() - olderThanMs)
      .map((row) => this.hydrateGeneration(row));
  }

  failStaleGenerations(): number {
    const result = this.db
      .prepare(
        `UPDATE generations
            SET status = 'failed',
                error = 'Interrupted — the Latent server restarted while this job was running.',
                completed_at = ?
          WHERE status IN ('queued', 'running')`,
      )
      .run(Date.now());
    return result.changes;
  }

  private hydrateGeneration(row: GenerationRow): GenerationRecord {
    const images = this.db
      .prepare<[string], ImageRow>(
        'SELECT * FROM images WHERE generation_id = ? ORDER BY id ASC',
      )
      .all(row.id);

    return {
      id: row.id,
      promptId: row.prompt_id,
      workflowId: row.workflow_id,
      workflowName: row.workflow_name,
      status: row.status as GenerationStatus,
      error: row.error,
      values: parseJson<ParamValues>(row.values_json, {}),
      seeds: parseJson<Record<string, number>>(row.seeds_json, {}),
      params: parseJson<ParamSummaryItem[]>(row.params_json, []),
      title: row.title,
      images: images.map(toGenerationImage),
      texts: parseJson<TextOutput[]>(row.texts_json, []),
      createdAt: row.created_at,
      completedAt: row.completed_at,
      source: (row.source as 'comfy' | 'import') ?? 'comfy',
    };
  }

  /* ---------------------------------------------------------------- */
  /* Ratings and the local archive                                     */
  /* ---------------------------------------------------------------- */

  /**
   * Find an image row by the reference the client has (a ComfyUI filename).
   * Used by both the rating endpoint and the archive-first image proxy.
   */
  /**
   * The stored row for an image.
   *
   * Name, subfolder and type are **not** a key. ComfyUI restarts its counter
   * when an output folder is emptied, and two imported folders routinely hold
   * the same file name, so the same triple can name several rows — and picking
   * the newest of them is how a thumbnail comes to belong to a different
   * picture than the one it opens.
   *
   * So there are three ways in, best first: the row id, which the client sends
   * whenever it has one; the generation it belongs to, which *is* a key
   * (`UNIQUE (generation_id, filename, subfolder, type)`); and only failing
   * both, the old guess — kept because a live preview arriving over the socket
   * has no row yet.
   */
  findImage(
    ref: ComfyImageRef & { id?: number },
    generationId?: string,
  ): (ImageRow & { generationId: string }) | null {
    let row: ImageRow | undefined;

    if (typeof ref.id === 'number') {
      row = this.db.prepare<[number], ImageRow>('SELECT * FROM images WHERE id = ?').get(ref.id);
    }

    if (!row && generationId) {
      row = this.db
        .prepare<[string, string, string, string], ImageRow>(
          `SELECT * FROM images
            WHERE generation_id = ? AND filename = ? AND subfolder = ? AND type = ?`,
        )
        .get(generationId, ref.filename, ref.subfolder ?? '', ref.type ?? 'output');
    }

    if (!row) {
      row = this.db
        .prepare<[string, string, string], ImageRow>(
          `SELECT * FROM images
            WHERE filename = ? AND subfolder = ? AND type = ?
            ORDER BY id DESC LIMIT 1`,
        )
        .get(ref.filename, ref.subfolder ?? '', ref.type ?? 'output');
    }

    return row ? { ...row, generationId: row.generation_id } : null;
  }

  setImageKept(imageId: number, kept: boolean): void {
    this.db.prepare('UPDATE images SET kept = ? WHERE id = ?').run(kept ? 1 : 0, imageId);
  }

  /**
   * Generations old enough to sweep, and worth nobody's attention.
   *
   * "Worth attention" is deliberately generous: a star, a keep, or a favourite
   * anywhere in the run protects the whole run. Deleting three of four pictures
   * from a batch because only one was rated would lose the comparison that made
   * the rating meaningful.
   */
  listSweepable(olderThanMs: number, limit = 200): GenerationRecord[] {
    return this.db
      .prepare<[number, number], GenerationRow>(
        `SELECT g.* FROM generations g
          WHERE g.created_at < ?
            AND g.status IN ('completed', 'failed', 'cancelled')
            AND g.source = 'comfy'
            AND NOT EXISTS (
              SELECT 1 FROM images i
               WHERE i.generation_id = g.id AND (i.rating > 0 OR i.kept = 1)
            )
            AND NOT EXISTS (
              SELECT 1 FROM favorites f WHERE f.generation_id = g.id
            )
          ORDER BY g.created_at ASC
          LIMIT ?`,
      )
      .all(Date.now() - olderThanMs, limit)
      .map((row) => this.hydrateGeneration(row));
  }

  setImageRating(imageId: number, rating: number): void {
    const clamped = Math.max(0, Math.min(5, Math.round(rating)));
    this.db.prepare('UPDATE images SET rating = ? WHERE id = ?').run(clamped, imageId);
  }

  setImageArchive(
    imageId: number,
    archive: {
      path: string;
      bytes: number;
      encrypted: boolean;
      thumbPath?: string | null;
      thumbBytes?: number | null;
      width?: number | null;
      height?: number | null;
    },
  ): void {
    this.db
      .prepare(
        `UPDATE images
            SET archived_path = ?, archived_bytes = ?, encrypted = ?,
                -- Kept when this store has none to offer: a video's poster is
                -- captured long before the file itself is ever archived, and
                -- archiving must not throw the only preview away.
                thumb_path = COALESCE(?, thumb_path),
                thumb_bytes = COALESCE(?, thumb_bytes),
                width = COALESCE(?, width), height = COALESCE(?, height)
          WHERE id = ?`,
      )
      .run(
        archive.path,
        archive.bytes,
        archive.encrypted ? 1 : 0,
        archive.thumbPath ?? null,
        archive.thumbBytes ?? null,
        archive.width ?? null,
        archive.height ?? null,
        imageId,
      );
  }

  /**
   * File a still for something that cannot be resized here.
   *
   * A video has no thumbnail until somebody has decoded a frame of it, which on
   * a server without ffmpeg is the browser — see the poster route. Stored the
   * same way a thumbnail always was, so every grid, sheet and picker gets it
   * without knowing where it came from.
   */
  setImagePoster(
    imageId: number,
    poster: { path: string; bytes: number; width?: number | null; height?: number | null },
  ): void {
    this.db
      .prepare(
        `UPDATE images
            SET thumb_path = ?, thumb_bytes = ?,
                width = COALESCE(?, width), height = COALESCE(?, height)
          WHERE id = ?`,
      )
      .run(poster.path, poster.bytes, poster.width ?? null, poster.height ?? null, imageId);
  }

  /** Remember an image's pixel size so the grid can shape its tile up front. */
  setImageDimensions(imageId: number, width: number, height: number): void {
    this.db
      .prepare('UPDATE images SET width = ?, height = ? WHERE id = ?')
      .run(width, height, imageId);
  }

  /** `null` clears a manual override and returns the tile to automatic sizing. */
  setImageTileSpan(imageId: number, span: TileSpan | null): void {
    this.db
      .prepare('UPDATE images SET tile_span = ? WHERE id = ?')
      .run(span ? `${span.cols}x${span.rows}` : null, imageId);
  }

  getImage(imageId: number): ImageRow | null {
    return (
      this.db.prepare<[number], ImageRow>('SELECT * FROM images WHERE id = ?').get(imageId) ?? null
    );
  }

  clearImageArchive(imageId: number): void {
    this.db
      .prepare(
        `UPDATE images
            SET archived_path = NULL, archived_bytes = NULL,
                thumb_path = NULL, thumb_bytes = NULL, encrypted = 0
          WHERE id = ?`,
      )
      .run(imageId);
  }

  /* ---------------------------------------------------------------- */
  /* Favourites                                                        */
  /* ---------------------------------------------------------------- */

  listFavorites(sort: FavoriteSort = 'rating'): Favorite[] {
    const order =
      sort === 'newest'
        ? 'created_at DESC'
        : sort === 'oldest'
          ? 'created_at ASC'
          : 'rating DESC, created_at DESC';

    const rows = this.db
      .prepare<[], FavoriteRow>(`SELECT * FROM favorites ORDER BY ${order}`)
      .all();

    // One lookup rather than one per row: the list can be long.
    const available = new Set(
      this.db
        .prepare<[], { id: string }>('SELECT id FROM workflows')
        .all()
        .map((row) => row.id),
    );

    /*
     * Which of these actually have their bytes here.
     *
     * One query rather than one per row, for the same reason as the workflow
     * lookup above: this list is as long as the user's taste.
     */
    const archived = new Set(
      this.db
        .prepare<[], { id: number }>('SELECT id FROM images WHERE archived_path IS NOT NULL')
        .all()
        .map((entry) => entry.id),
    );

    /*
     * The rows these favourites point at, where they are still there.
     *
     * One query for the lot, like the two above: this list is as long as the
     * user's taste, and a lookup per row would make opening the screen a
     * hundred statements.
     */
    const live = new Map<number, ImageRow>();
    const ids = rows.map((row) => row.image_id).filter((id): id is number => id !== null);
    if (ids.length > 0) {
      const placeholders = ids.map(() => '?').join(', ');
      for (const image of this.db
        .prepare<number[], ImageRow>(`SELECT * FROM images WHERE id IN (${placeholders})`)
        .all(...ids)) {
        live.set(image.id, image);
      }
    }

    return rows.map((row) =>
      toFavorite(
        row,
        row.workflow_id !== null && available.has(row.workflow_id),
        row.image_id !== null && archived.has(row.image_id),
        row.image_id !== null ? (live.get(row.image_id) ?? null) : null,
      ),
    );
  }

  getFavorite(id: string): Favorite | null {
    const row = this.db
      .prepare<[string], FavoriteRow>('SELECT * FROM favorites WHERE id = ?')
      .get(id);
    if (!row) return null;
    const available =
      row.workflow_id !== null && this.getWorkflow(row.workflow_id) !== null;
    return toFavorite(
      row,
      available,
      this.isArchived(row.image_id),
      row.image_id !== null ? this.getImage(row.image_id) : null,
    );
  }

  /** Whether an image's bytes are stored here rather than only referenced. */
  private isArchived(imageId: number | null): boolean {
    if (imageId === null) return false;
    return this.getImage(imageId)?.archived_path != null;
  }

  /** True when this exact image is already a favourite, so the UI can toggle. */
  findFavoriteByImage(imageId: number): Favorite | null {
    const row = this.db
      .prepare<[number], FavoriteRow>('SELECT * FROM favorites WHERE image_id = ? LIMIT 1')
      .get(imageId);
    if (!row) return null;
    return toFavorite(
      row,
      row.workflow_id !== null && this.getWorkflow(row.workflow_id) !== null,
      this.isArchived(row.image_id),
      this.getImage(imageId),
    );
  }

  insertFavorite(favorite: {
    id: string;
    imageId: number | null;
    generationId: string | null;
    workflowId: string | null;
    title: string;
    note: string | null;
    values: ParamValues;
    image: GenerationImage | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO favorites
           (id, image_id, generation_id, workflow_id, title, note, rating, values_json, image_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      )
      .run(
        favorite.id,
        favorite.imageId,
        favorite.generationId,
        favorite.workflowId,
        favorite.title,
        favorite.note,
        JSON.stringify(favorite.values),
        JSON.stringify(favorite.image),
        Date.now(),
      );
  }

  updateFavorite(id: string, patch: { rating?: number; note?: string | null }): void {
    const sets: string[] = [];
    const params: unknown[] = [];

    if (patch.rating !== undefined) {
      sets.push('rating = ?');
      params.push(Math.max(0, Math.min(5, Math.round(patch.rating))));
    }
    if (patch.note !== undefined) {
      sets.push('note = ?');
      params.push(patch.note);
    }
    if (sets.length === 0) return;

    params.push(id);
    this.db.prepare(`UPDATE favorites SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  deleteFavorite(id: string): void {
    this.db.prepare('DELETE FROM favorites WHERE id = ?').run(id);
  }

  /* ---------------------------------------------------------------- */
  /* Form layouts                                                      */
  /* ---------------------------------------------------------------- */

  listLayouts(workflowId: string): FormLayout[] {
    return this.db
      .prepare<[string], LayoutRow>(
        'SELECT * FROM layouts WHERE workflow_id = ? ORDER BY created_at ASC',
      )
      .all(workflowId)
      .map(toLayout);
  }

  getLayout(id: string): FormLayout | null {
    const row = this.db.prepare<[string], LayoutRow>('SELECT * FROM layouts WHERE id = ?').get(id);
    return row ? toLayout(row) : null;
  }

  getActiveLayout(workflowId: string): FormLayout | null {
    const row = this.db
      .prepare<[string], LayoutRow>(
        'SELECT * FROM layouts WHERE workflow_id = ? AND is_active = 1 LIMIT 1',
      )
      .get(workflowId);
    return row ? toLayout(row) : null;
  }

  /** Saving over an existing name replaces it, as with parameter presets. */
  upsertLayout(
    id: string,
    workflowId: string,
    name: string,
    overrides: FieldOverrides,
  ): FormLayout {
    this.db
      .prepare(
        `INSERT INTO layouts (id, workflow_id, name, overrides_json, is_active, created_at)
         VALUES (?, ?, ?, ?, 0, ?)
         ON CONFLICT (workflow_id, name)
           DO UPDATE SET overrides_json = excluded.overrides_json`,
      )
      .run(id, workflowId, name.trim(), JSON.stringify(overrides), Date.now());

    const row = this.db
      .prepare<[string, string], LayoutRow>(
        'SELECT * FROM layouts WHERE workflow_id = ? AND name = ?',
      )
      .get(workflowId, name.trim());
    if (!row) throw new Error('Layout vanished immediately after being written');
    return toLayout(row);
  }

  updateLayoutOverrides(id: string, overrides: FieldOverrides): void {
    this.db
      .prepare('UPDATE layouts SET overrides_json = ? WHERE id = ?')
      .run(JSON.stringify(overrides), id);
  }

  activateLayout(workflowId: string, id: string | null): void {
    const activate = this.db.transaction(() => {
      this.db.prepare('UPDATE layouts SET is_active = 0 WHERE workflow_id = ?').run(workflowId);
      if (id) this.db.prepare('UPDATE layouts SET is_active = 1 WHERE id = ?').run(id);
    });
    activate();
  }

  deleteLayout(id: string): void {
    this.db.prepare('DELETE FROM layouts WHERE id = ?').run(id);
  }

  /* ---------------------------------------------------------------- */
  /* Prompt building blocks                                            */
  /* ---------------------------------------------------------------- */

  listPromptBlocks(): PromptBlock[] {
    return this.db
      .prepare<[], PromptBlockRow>(
        'SELECT * FROM prompt_blocks ORDER BY category ASC, position ASC, created_at ASC',
      )
      .all()
      .map(toPromptBlock);
  }

  getPromptBlock(id: string): PromptBlock | null {
    const row = this.db
      .prepare<[string], PromptBlockRow>('SELECT * FROM prompt_blocks WHERE id = ?')
      .get(id);
    return row ? toPromptBlock(row) : null;
  }

  insertPromptBlock(id: string, input: PromptBlockInput): PromptBlock {
    this.db
      .prepare(
        `INSERT INTO prompt_blocks (id, name, category, text, position, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.name.trim(),
        (input.category ?? '').trim(),
        input.text,
        input.position ?? 0,
        Date.now(),
      );
    return this.getPromptBlock(id) as PromptBlock;
  }

  updatePromptBlock(id: string, input: Partial<PromptBlockInput>): void {
    const sets: string[] = [];
    const params: unknown[] = [];

    if (input.name !== undefined) {
      sets.push('name = ?');
      params.push(input.name.trim());
    }
    if (input.category !== undefined) {
      sets.push('category = ?');
      params.push(input.category.trim());
    }
    if (input.text !== undefined) {
      sets.push('text = ?');
      params.push(input.text);
    }
    if (input.position !== undefined) {
      sets.push('position = ?');
      params.push(input.position);
    }
    if (sets.length === 0) return;

    params.push(id);
    this.db.prepare(`UPDATE prompt_blocks SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  deletePromptBlock(id: string): void {
    this.db.prepare('DELETE FROM prompt_blocks WHERE id = ?').run(id);
  }

  /**
   * Write a whole order at once.
   *
   * A drag produces one new sequence, not a series of individual moves, and
   * sending it as one statement per block would leave the list half-reordered
   * if the connection dropped in the middle.
   */
  reorderPromptBlocks(ids: string[]): void {
    const update = this.db.prepare('UPDATE prompt_blocks SET position = ? WHERE id = ?');
    this.db.transaction(() => {
      ids.forEach((id, index) => update.run(index, id));
    })();
  }

  /* ---------------------------------------------------------------- */
  /* Notes about what the user likes                                   */
  /* ---------------------------------------------------------------- */

  /*
   * Ciphertext in, ciphertext out.
   *
   * The methods below move opaque strings; only `Taste` knows what is in them.
   * Keeping the split at this line means the database layer cannot leak a
   * plaintext it never holds, and the ordering and switching still work while
   * the vault is locked.
   */

  listTasteCategoryRows(): TasteCategoryRow[] {
    return this.db
      .prepare<[], TasteCategoryRow>(
        'SELECT * FROM taste_categories ORDER BY position ASC, created_at ASC',
      )
      .all();
  }

  getTasteCategoryRow(id: string): TasteCategoryRow | null {
    return (
      this.db
        .prepare<[string], TasteCategoryRow>('SELECT * FROM taste_categories WHERE id = ?')
        .get(id) ?? null
    );
  }

  /** Appends: a new heading belongs at the end of the list, not the top of it. */
  insertTasteCategory(id: string, name: string): TasteCategoryRow {
    this.db
      .prepare(
        `INSERT INTO taste_categories (id, name, active, position, created_at)
         VALUES (?, ?, 1, COALESCE((SELECT MAX(position) + 1 FROM taste_categories), 0), ?)`,
      )
      .run(id, name, Date.now());
    return this.getTasteCategoryRow(id) as TasteCategoryRow;
  }

  updateTasteCategory(
    id: string,
    input: { name?: string; active?: boolean; position?: number },
  ): void {
    const sets: string[] = [];
    const params: unknown[] = [];

    if (input.name !== undefined) {
      sets.push('name = ?');
      params.push(input.name);
    }
    if (input.active !== undefined) {
      sets.push('active = ?');
      params.push(input.active ? 1 : 0);
    }
    if (input.position !== undefined) {
      sets.push('position = ?');
      params.push(input.position);
    }
    if (sets.length === 0) return;

    params.push(id);
    this.db.prepare(`UPDATE taste_categories SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  /**
   * Delete the heading, keep the notes.
   *
   * The foreign key says the same thing, but it is spelled out here as well:
   * a database opened without `foreign_keys` on would otherwise orphan rows
   * that the profile then cannot show at all.
   */
  deleteTasteCategory(id: string): void {
    this.db.transaction(() => {
      this.db.prepare('UPDATE taste_entries SET category_id = NULL WHERE category_id = ?').run(id);
      this.db.prepare('DELETE FROM taste_categories WHERE id = ?').run(id);
    })();
  }

  listTasteEntryRows(): TasteEntryRow[] {
    return this.db
      .prepare<[], TasteEntryRow>(
        'SELECT * FROM taste_entries ORDER BY position ASC, created_at ASC',
      )
      .all();
  }

  getTasteEntryRow(id: string): TasteEntryRow | null {
    return (
      this.db
        .prepare<[string], TasteEntryRow>('SELECT * FROM taste_entries WHERE id = ?')
        .get(id) ?? null
    );
  }

  insertTasteEntry(
    id: string,
    input: { categoryId: string | null; text: string; always?: boolean },
  ): TasteEntryRow {
    this.db
      .prepare(
        `INSERT INTO taste_entries (id, category_id, text, active, always_on, position, created_at)
         VALUES (?, ?, ?, 1, ?, COALESCE((SELECT MAX(position) + 1 FROM taste_entries), 0), ?)`,
      )
      .run(id, input.categoryId, input.text, input.always ? 1 : 0, Date.now());
    return this.getTasteEntryRow(id) as TasteEntryRow;
  }

  updateTasteEntry(
    id: string,
    input: {
      categoryId?: string | null;
      text?: string;
      active?: boolean;
      always?: boolean;
      position?: number;
    },
  ): void {
    const sets: string[] = [];
    const params: unknown[] = [];

    if (input.categoryId !== undefined) {
      sets.push('category_id = ?');
      params.push(input.categoryId);
    }
    if (input.text !== undefined) {
      sets.push('text = ?');
      params.push(input.text);
    }
    if (input.active !== undefined) {
      sets.push('active = ?');
      params.push(input.active ? 1 : 0);
    }
    if (input.always !== undefined) {
      sets.push('always_on = ?');
      params.push(input.always ? 1 : 0);
    }
    if (input.position !== undefined) {
      sets.push('position = ?');
      params.push(input.position);
    }
    if (sets.length === 0) return;

    params.push(id);
    this.db.prepare(`UPDATE taste_entries SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  deleteTasteEntry(id: string): void {
    this.db.prepare('DELETE FROM taste_entries WHERE id = ?').run(id);
  }

  /* ---------------------------------------------------------------- */
  /* System prompts                                                    */
  /* ---------------------------------------------------------------- */

  listSystemPrompts(): SystemPrompt[] {
    return this.db
      .prepare<[], SystemPromptRow>(
        'SELECT * FROM system_prompts ORDER BY position ASC, created_at ASC',
      )
      .all()
      .map(toSystemPrompt);
  }

  getSystemPrompt(id: string): SystemPrompt | null {
    const row = this.db
      .prepare<[string], SystemPromptRow>('SELECT * FROM system_prompts WHERE id = ?')
      .get(id);
    return row ? toSystemPrompt(row) : null;
  }

  /**
   * Look one up by name, the way a workflow's field does.
   *
   * Case-insensitive, because the name is matched against a label somebody
   * typed into ComfyUI months ago and "Caption" and "caption" are the same
   * instruction.
   */
  findSystemPromptByName(name: string): SystemPrompt | null {
    const row = this.db
      .prepare<[string], SystemPromptRow>(
        'SELECT * FROM system_prompts WHERE lower(trim(name)) = ? LIMIT 1',
      )
      .get(name.trim().toLowerCase());
    return row ? toSystemPrompt(row) : null;
  }

  insertSystemPrompt(id: string, input: SystemPromptInput): SystemPrompt {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO system_prompts (id, name, text, position, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.name.trim(), input.text, input.position ?? this.countSystemPrompts(), now, now);
    return this.getSystemPrompt(id) as SystemPrompt;
  }

  updateSystemPrompt(id: string, input: Partial<SystemPromptInput>): void {
    const sets: string[] = [];
    const params: unknown[] = [];

    if (input.name !== undefined) {
      sets.push('name = ?');
      params.push(input.name.trim());
    }
    if (input.text !== undefined) {
      sets.push('text = ?');
      params.push(input.text);
    }
    if (input.position !== undefined) {
      sets.push('position = ?');
      params.push(input.position);
    }
    if (sets.length === 0) return;

    sets.push('updated_at = ?');
    params.push(Date.now(), id);
    this.db.prepare(`UPDATE system_prompts SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  deleteSystemPrompt(id: string): void {
    this.db.prepare('DELETE FROM system_prompts WHERE id = ?').run(id);
  }

  countSystemPrompts(): number {
    const row = this.db
      .prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM system_prompts')
      .get();
    return row?.count ?? 0;
  }

  /* ---------------------------------------------------------------- */
  /* Imported images                                                   */
  /* ---------------------------------------------------------------- */

  /**
   * Record a file scanned from a folder as a gallery entry.
   *
   * Imports become ordinary generations with `source = 'import'`, so the whole
   * rating, archiving and favouriting machinery applies to them unchanged.
   */
  insertImportedImage(input: {
    generationId: string;
    promptId: string;
    title: string;
    filename: string;
    subfolder: string;
    modifiedAt: number;
    /**
     * Recovered from the image's own metadata, when it had any.
     *
     * This is what makes "use these settings again" work for a picture Latent
     * never generated — without it an imported image is a dead end.
     */
    workflowId?: string | null;
    workflowName?: string;
    values?: ParamValues;
    params?: ParamSummaryItem[];
  }): number {
    this.db
      .prepare(
        `INSERT INTO generations
           (id, prompt_id, workflow_id, workflow_name, status, error, values_json, seeds_json, title, created_at, completed_at, source, params_json)
         VALUES (?, ?, ?, ?, 'completed', NULL, ?, '{}', ?, ?, ?, 'import', ?)`,
      )
      .run(
        input.generationId,
        input.promptId,
        input.workflowId ?? null,
        input.workflowName ?? 'Imported',
        JSON.stringify(input.values ?? {}),
        input.title,
        input.modifiedAt,
        input.modifiedAt,
        JSON.stringify(input.params ?? []),
      );

    const result = this.db
      .prepare(
        `INSERT INTO images (generation_id, node_id, filename, subfolder, type, kind)
         VALUES (?, 'import', ?, ?, 'import', ?)`,
      )
      .run(input.generationId, input.filename, input.subfolder, mediaKindOf(input.filename));

    return Number(result.lastInsertRowid);
  }

  /** Which of these relative paths have already been imported. */
  importedPaths(): Set<string> {
    const rows = this.db
      .prepare<[], { filename: string; subfolder: string }>(
        "SELECT filename, subfolder FROM images WHERE type = 'import'",
      )
      .all();
    return new Set(rows.map((row) => (row.subfolder ? `${row.subfolder}/${row.filename}` : row.filename)));
  }

  /**
   * True when some other row still points at this file.
   *
   * Archive paths are content-addressed and therefore shared between duplicate
   * images; deleting one row's copy must not blank another's. Checks both the
   * full image and thumbnail columns, since a path could be either.
   */
  archivePathInUseElsewhere(path: string, exceptImageId: number): boolean {
    const row = this.db
      .prepare<[string, string, number], { count: number }>(
        `SELECT COUNT(*) AS count FROM images
          WHERE (archived_path = ? OR thumb_path = ?) AND id != ?`,
      )
      .get(path, path, exceptImageId);
    return (row?.count ?? 0) > 0;
  }

  archiveStats(): ArchiveStats {
    const row = this.db
      .prepare<[], { images: number; bytes: number | null }>(
        `SELECT COUNT(*) AS images, SUM(archived_bytes) AS bytes
           FROM images WHERE archived_path IS NOT NULL`,
      )
      .get();
    return { images: row?.images ?? 0, bytes: row?.bytes ?? 0 };
  }

  /** Archived images nobody rated, offered up for cleanup. */
  listUnratedArchived(): ImageRow[] {
    return this.db
      .prepare<[], ImageRow>(
        'SELECT * FROM images WHERE archived_path IS NOT NULL AND rating = 0',
      )
      .all();
  }

  /* ---------------------------------------------------------------- */
  /* Connections                                                       */
  /* ---------------------------------------------------------------- */

  /**
   * Every connection, both kinds, oldest first.
   *
   * Kind is a column rather than a separate listing: they are shown as one list
   * and the client decides how to group them, which is the only arrangement that
   * survives a third kind ever existing.
   */
  listConnections(): ConnectionSummary[] {
    return this.db
      .prepare<[], ConnectionRow>('SELECT * FROM connections ORDER BY created_at ASC')
      .all()
      .map(toConnectionSummary);
  }

  getConnection(id: string): ConnectionSummary | null {
    const row = this.db
      .prepare<[string], ConnectionRow>('SELECT * FROM connections WHERE id = ?')
      .get(id);
    return row ? toConnectionSummary(row) : null;
  }

  /** Includes the secret — server-side only, never handed to a route response. */
  getConnectionWithSecret(id: string): (ConnectionSummary & { secret: string | null }) | null {
    const row = this.db
      .prepare<[string], ConnectionRow>('SELECT * FROM connections WHERE id = ?')
      .get(id);
    return row ? { ...toConnectionSummary(row), secret: row.secret } : null;
  }

  /** The one in use for a kind. Both kinds have one at the same time. */
  getActiveConnection(
    kind: ConnectionKind = 'comfy',
  ): (ConnectionSummary & { secret: string | null }) | null {
    const row = this.db
      .prepare<[string], ConnectionRow>(
        'SELECT * FROM connections WHERE is_active = 1 AND kind = ? LIMIT 1',
      )
      .get(kind);
    return row ? { ...toConnectionSummary(row), secret: row.secret } : null;
  }

  insertConnection(id: string, input: ConnectionInput): void {
    this.db
      .prepare(
        `INSERT INTO connections
           (id, kind, name, url, auth_mode, username, secret, allow_self_signed, is_active, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      )
      .run(
        id,
        input.kind === 'llama' ? 'llama' : 'comfy',
        input.name.trim(),
        normaliseUrl(input.url),
        input.authMode ?? 'none',
        input.username ?? null,
        input.secret ?? null,
        input.allowSelfSigned ? 1 : 0,
        Date.now(),
      );
  }

  updateConnection(id: string, input: ConnectionInput): void {
    const sets: string[] = [];
    const params: unknown[] = [];

    if (input.kind !== undefined) {
      sets.push('kind = ?');
      params.push(input.kind === 'llama' ? 'llama' : 'comfy');
    }
    if (input.name !== undefined) {
      sets.push('name = ?');
      params.push(input.name.trim());
    }
    if (input.url !== undefined) {
      sets.push('url = ?');
      params.push(normaliseUrl(input.url));
    }
    if (input.authMode !== undefined) {
      sets.push('auth_mode = ?');
      params.push(input.authMode);
    }
    if (input.username !== undefined) {
      sets.push('username = ?');
      params.push(input.username);
    }
    // Undefined keeps the stored secret; an empty string deliberately clears it.
    if (input.secret !== undefined) {
      sets.push('secret = ?');
      params.push(input.secret === '' ? null : input.secret);
    }
    if (input.allowSelfSigned !== undefined) {
      sets.push('allow_self_signed = ?');
      params.push(input.allowSelfSigned ? 1 : 0);
    }
    if (sets.length === 0) return;

    params.push(id);
    this.db.prepare(`UPDATE connections SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  deleteConnection(id: string): void {
    this.db.prepare('DELETE FROM connections WHERE id = ?').run(id);
  }

  /**
   * Put one connection in use, within its own kind.
   *
   * Only its own kind is stood down: choosing a model server must not switch
   * ComfyUI off, which is exactly what a single global "active" flag would do
   * now that both live in one table.
   */
  activateConnection(id: string): void {
    const activate = this.db.transaction((target: string) => {
      const row = this.db
        .prepare<[string], ConnectionRow>('SELECT * FROM connections WHERE id = ?')
        .get(target);
      if (!row) return;
      this.db.prepare('UPDATE connections SET is_active = 0 WHERE kind = ?').run(row.kind);
      this.db.prepare('UPDATE connections SET is_active = 1 WHERE id = ?').run(target);
    });
    activate(id);
  }

  countConnections(kind?: ConnectionKind): number {
    const row = kind
      ? this.db
          .prepare<[string], { count: number }>(
            'SELECT COUNT(*) AS count FROM connections WHERE kind = ?',
          )
          .get(kind)
      : this.db
          .prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM connections')
          .get();
    return row?.count ?? 0;
  }

  /* ---------------------------------------------------------------- */
  /* Workflow parameter presets                                        */
  /* ---------------------------------------------------------------- */

  listPresets(workflowId: string): WorkflowPreset[] {
    return this.db
      .prepare<[string], PresetRow>(
        'SELECT * FROM presets WHERE workflow_id = ? ORDER BY created_at ASC',
      )
      .all(workflowId)
      .map(toPreset);
  }

  getPreset(id: string): WorkflowPreset | null {
    const row = this.db.prepare<[string], PresetRow>('SELECT * FROM presets WHERE id = ?').get(id);
    return row ? toPreset(row) : null;
  }

  /** Saving under an existing name overwrites it, which is what "save" means here. */
  upsertPreset(id: string, workflowId: string, name: string, values: ParamValues): WorkflowPreset {
    this.db
      .prepare(
        `INSERT INTO presets (id, workflow_id, name, values_json, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (workflow_id, name)
           DO UPDATE SET values_json = excluded.values_json`,
      )
      .run(id, workflowId, name.trim(), JSON.stringify(values), Date.now());

    const row = this.db
      .prepare<[string, string], PresetRow>(
        'SELECT * FROM presets WHERE workflow_id = ? AND name = ?',
      )
      .get(workflowId, name.trim());
    if (!row) throw new Error('Preset vanished immediately after being written');
    return toPreset(row);
  }

  deletePreset(id: string): void {
    this.db.prepare('DELETE FROM presets WHERE id = ?').run(id);
  }

  /* ---------------------------------------------------------------- */
  /* Settings                                                          */
  /* ---------------------------------------------------------------- */

  /** Raw key/value access, used for the password hash. */
  getSecretSetting(key: string): string | null {
    const row = this.db
      .prepare<[string], { value: string }>('SELECT value FROM settings WHERE key = ?')
      .get(key);
    return row?.value ?? null;
  }

  setSecretSetting(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  /**
   * The random-prompt configuration.
   *
   * Server-side rather than per-device because the draw itself happens here, once
   * per queued item — a phone that queues eight and walks away must not have to
   * stay connected for the remaining seven to be randomised.
   *
   * Stored as one JSON blob in `settings`, so no migration is needed and adding a
   * field later cannot invalidate what is already saved: `normalise` fills gaps.
   */
  getRandomPromptConfig(): RandomPromptConfig {
    const raw = this.getSecretSetting(RANDOM_PROMPT_KEY);
    if (!raw) return { ...DEFAULT_RANDOM_PROMPT_CONFIG };
    try {
      return normaliseRandomPromptConfig(JSON.parse(raw));
    } catch {
      // A corrupt value must not take the server down; fall back to "off".
      return { ...DEFAULT_RANDOM_PROMPT_CONFIG };
    }
  }

  setRandomPromptConfig(patch: Partial<RandomPromptConfig>): RandomPromptConfig {
    const next = normaliseRandomPromptConfig({ ...this.getRandomPromptConfig(), ...patch });
    this.setSecretSetting(RANDOM_PROMPT_KEY, JSON.stringify(next));
    return next;
  }

  /* ---------------------------------------------------------------- */
  /* Saved variation setups                                            */
  /* ---------------------------------------------------------------- */

  listVariationPresets(): VariationPreset[] {
    return this.db
      .prepare<[], { id: string; name: string; config_json: string; created_at: number }>(
        'SELECT * FROM variation_presets ORDER BY name ASC',
      )
      .all()
      .map((row) => ({
        id: row.id,
        name: row.name,
        createdAt: row.created_at,
        config: normaliseRandomPromptConfig(parseJson<unknown>(row.config_json, {})),
      }));
  }

  /** Saving under an existing name overwrites it — that is what people mean. */
  saveVariationPreset(id: string, name: string, config: RandomPromptConfig): VariationPreset {
    this.db
      .prepare(
        `INSERT INTO variation_presets (id, name, config_json, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET config_json = excluded.config_json`,
      )
      .run(id, name, JSON.stringify(normaliseRandomPromptConfig(config)), Date.now());

    const saved = this.listVariationPresets().find((preset) => preset.name === name);
    if (!saved) throw new Error('Preset vanished immediately after being saved');
    return saved;
  }

  getVariationPreset(id: string): VariationPreset | null {
    return this.listVariationPresets().find((preset) => preset.id === id) ?? null;
  }

  deleteVariationPreset(id: string): void {
    this.db.prepare('DELETE FROM variation_presets WHERE id = ?').run(id);
  }

  getSettings(): AppSettings {
    const rows = this.db.prepare<[], { key: string; value: string }>('SELECT * FROM settings').all();
    const settings: Record<string, unknown> = { ...DEFAULT_SETTINGS };
    for (const row of rows) {
      if (!(row.key in DEFAULT_SETTINGS)) continue;

      /*
       * Most settings are a single value and are stored as text. A couple are
       * a group of related ones — the chat's model, reply limit and tool pace
       * belong together and are always set together — and those are stored as
       * JSON under one key, merged over the defaults so a value added in a
       * later version appears rather than being undefined.
       */
      if (isObjectSetting(row.key)) {
        settings[row.key] = mergeSetting(
          (DEFAULT_SETTINGS as unknown as Record<string, object>)[row.key] ?? {},
          parseJson<object>(row.value, {}),
        );
        continue;
      }
      settings[row.key] = row.value === '' ? null : row.value;
    }
    // Settings are stored as text; the one number among them has to come back
    // as a number or every comparison against it is a string comparison.
    const hours = Number(settings.autoDeleteHours);
    settings.autoDeleteHours = Number.isFinite(hours) && hours > 0 ? hours : null;
    return settings as unknown as AppSettings;
  }

  updateSettings(patch: Partial<AppSettings>): AppSettings {
    const upsert = this.db.prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    );
    const current = this.getSettings() as unknown as Record<string, unknown>;


    for (const [key, value] of Object.entries(patch)) {
      if (!(key in DEFAULT_SETTINGS)) continue;

      // Patched a field at a time, so setting the chat's model does not
      // silently reset which system prompt it uses.
      if (isObjectSetting(key)) {
        // One group deep, like the read side: patching the chat's review
        // settings must not drop the fields of it the patch did not mention.
        upsert.run(key, JSON.stringify(mergeSetting(current[key] as object, value as object)));
        continue;
      }
      upsert.run(key, value == null ? '' : String(value));
    }
    return this.getSettings();
  }

  /**
   * Move the chat's address and instructions out of the settings blob.
   *
   * Both were fields on `chat` before the model server became an ordinary
   * connection and system prompts became a collection. They are moved rather
   * than dropped: the address is somebody's rented box, and the instructions are
   * often months of tuning. Runs on every boot and does nothing once there is
   * nothing left to move.
   *
   * `temperature` is deleted outright — sampling belongs to the model server's
   * launch flags, and a stale number here would keep overriding them.
   */
  migrateChatSettings(makeId: () => string): void {
    const row = this.db
      .prepare<[string], { value: string }>('SELECT value FROM settings WHERE key = ?')
      .get('chat');
    if (!row) return;

    const legacy = parseJson<Record<string, unknown>>(row.value, {});
    const hasLegacy = ['baseUrl', 'systemPrompt', 'temperature'].some((key) => key in legacy);
    if (!hasLegacy) return;

    const baseUrl = typeof legacy.baseUrl === 'string' ? legacy.baseUrl.trim() : '';
    const systemPrompt = typeof legacy.systemPrompt === 'string' ? legacy.systemPrompt : '';

    const next = { ...legacy };
    delete next.baseUrl;
    delete next.systemPrompt;
    delete next.temperature;

    if (baseUrl !== '' && this.countConnections('llama') === 0) {
      const id = makeId();
      this.insertConnection(id, {
        kind: 'llama',
        name: 'Model server',
        url: baseUrl,
        authMode: 'none',
      });
      this.activateConnection(id);
    }

    if (systemPrompt.trim() !== '' && next.systemPromptId == null) {
      const kept =
        this.findSystemPromptByName('Chat') ??
        this.insertSystemPrompt(makeId(), { name: 'Chat', text: systemPrompt });
      next.systemPromptId = kept.id;
    }

    this.db
      .prepare(
        `INSERT INTO settings (key, value) VALUES ('chat', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(JSON.stringify(next));
  }

  /* ---------------------------------------------------------------- */
  /* Portable state                                                    */
  /* ---------------------------------------------------------------- */

  /** Everything that was arranged by hand, in a form that survives this file. */
  exportUiState(): UiState {
    const workflows: Record<string, WorkflowUiState> = {};
    for (const summary of this.listWorkflows()) {
      const detail = this.getWorkflow(summary.id);
      if (!detail) continue;
      workflows[detail.name] = {
        overrides: detail.overrides,
        lastValues: detail.lastValues,
        layouts: this.listLayouts(detail.id).map((layout) => ({
          name: layout.name,
          overrides: layout.overrides,
          active: layout.isActive,
        })),
        presets: this.listPresets(detail.id).map((preset) => ({
          name: preset.name,
          values: preset.values,
        })),
      };
    }

    return {
      version: 1,
      savedAt: Date.now(),
      settings: this.getSettings(),
      connections: this.listConnections().map((connection) => ({
        kind: connection.kind,
        name: connection.name,
        url: connection.url,
        authMode: connection.authMode,
        username: connection.username,
        secret: this.getConnectionWithSecret(connection.id)?.secret ?? null,
        allowSelfSigned: connection.allowSelfSigned,
        active: connection.isActive,
      })),
      systemPrompts: this.listSystemPrompts().map(({ name, text, position }) => ({
        name,
        text,
        position,
      })),
      variation: {
        config: this.getRandomPromptConfig(),
        presets: this.listVariationPresets().map((preset) => ({
          name: preset.name,
          config: preset.config,
        })),
      },
      workflows,
    };
  }

  /**
   * Take back everything the current database does not already have.
   *
   * Additive on purpose: this runs on every boot, and a restore that overwrote
   * live data would turn a stale file into a way of losing work. Anything
   * already present wins.
   */
  importUiState(state: UiState, makeId: () => string): void {
    const settings = this.getSettings();
    const missing = Object.fromEntries(
      Object.entries(state.settings ?? {}).filter(
        ([key, value]) =>
          key in settings && value != null && settings[key as keyof AppSettings] == null,
      ),
    ) as Partial<AppSettings>;
    if (Object.keys(missing).length > 0) this.updateSettings(missing);

    if (this.countConnections() === 0) {
      for (const connection of state.connections ?? []) {
        const id = makeId();
        this.insertConnection(id, {
          kind: connection.kind ?? 'comfy',
          name: connection.name,
          url: connection.url,
          authMode: connection.authMode,
          username: connection.username,
          secret: connection.secret,
          allowSelfSigned: connection.allowSelfSigned,
        });
        if (connection.active) this.activateConnection(id);
      }
    }

    // Restored by name, one at a time: unlike connections, a half-populated
    // collection is normal — you write the chat's instructions on day one and
    // a workflow's captioning rules a month later.
    for (const prompt of state.systemPrompts ?? []) {
      if (!prompt?.name) continue;
      if (this.findSystemPromptByName(prompt.name)) continue;
      this.insertSystemPrompt(makeId(), prompt);
    }

    if (state.variation?.config) this.setRandomPromptConfig(state.variation.config);
    if (this.listVariationPresets().length === 0) {
      for (const preset of state.variation?.presets ?? []) {
        this.saveVariationPreset(makeId(), preset.name, preset.config);
      }
    }
  }

  /**
   * Re-attach a saved arrangement to a workflow that has just been imported.
   *
   * The point of the whole exercise: you delete the project folder, import the
   * same workflow JSON again, and the form is the one you built rather than the
   * one the heuristics derive.
   */
  adoptWorkflowState(workflowId: string, state: WorkflowUiState, makeId: () => string): void {
    const detail = this.getWorkflow(workflowId);
    if (!detail) return;

    if (Object.keys(detail.overrides).length === 0 && Object.keys(state.overrides).length > 0) {
      this.updateWorkflow(workflowId, { overrides: state.overrides });
    }
    if (Object.keys(detail.lastValues).length === 0 && Object.keys(state.lastValues).length > 0) {
      this.updateWorkflow(workflowId, { lastValues: state.lastValues });
    }

    if (this.listLayouts(workflowId).length === 0) {
      for (const layout of state.layouts) {
        const id = makeId();
        this.upsertLayout(id, workflowId, layout.name, layout.overrides);
        if (layout.active) this.activateLayout(workflowId, id);
      }
    }
    if (this.listPresets(workflowId).length === 0) {
      for (const preset of state.presets) {
        this.upsertPreset(makeId(), workflowId, preset.name, preset.values);
      }
    }
  }

  exportPromptBlocks(): BlockState {
    return {
      version: 1,
      savedAt: Date.now(),
      blocks: this.listPromptBlocks().map(({ name, category, text, position }) => ({
        name,
        category,
        text,
        position,
      })),
    };
  }

  /* ---------------------------------------------------------------- */
  /* Parameter studies                                                 */
  /* ---------------------------------------------------------------- */

  /** The counts both phases are measured by, as SQL both listings share. */
  private static readonly SHOT_COUNTS = `
    (SELECT COUNT(*) FROM study_shots s WHERE s.study_id = studies.id AND s.status = 'done')
      AS rendered,
    (SELECT COUNT(*) FROM study_shots s WHERE s.study_id = studies.id AND s.status = 'failed')
      AS failed,
    (SELECT COUNT(*) FROM study_shots s WHERE s.study_id = studies.id AND s.rating IS NOT NULL)
      AS rated`;

  listStudies(): StudySummary[] {
    return this.db
      .prepare<[], StudyRow & StudyCounts>(
        `SELECT *, ${Store.SHOT_COUNTS} FROM studies ORDER BY updated_at DESC`,
      )
      .all()
      .map(toStudySummary);
  }

  getStudy(id: string): StudyDetail | null {
    const row = this.db
      .prepare<[string], StudyRow & StudyCounts>(
        `SELECT *, ${Store.SHOT_COUNTS} FROM studies WHERE id = ?`,
      )
      .get(id);
    if (!row) return null;

    return {
      ...toStudySummary(row),
      factors: parseJson<unknown[]>(row.factors_json, []),
      base: parseJson<ParamValues>(row.base_json, {}),
      seed: row.seed,
    };
  }

  insertStudy(input: {
    id: string;
    name: string;
    workflowId: string | null;
    workflowName: string;
    seed: number;
  }): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO studies
           (id, name, workflow_id, workflow_name, status, factors_json, base_json,
            sampling, shot_count, seed, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'draft', '[]', '{}', 'lhs', 40, ?, ?, ?)`,
      )
      .run(input.id, input.name, input.workflowId, input.workflowName, input.seed, now, now);
  }

  updateStudy(
    id: string,
    patch: {
      name?: string;
      factors?: unknown[];
      base?: ParamValues;
      sampling?: StudySamplingName;
      shotCount?: number;
      seed?: number;
      status?: StudyStatus;
    },
  ): void {
    const sets: string[] = [];
    const params: unknown[] = [];

    if (patch.name !== undefined) {
      sets.push('name = ?');
      params.push(patch.name);
    }
    if (patch.factors !== undefined) {
      sets.push('factors_json = ?');
      params.push(JSON.stringify(patch.factors));
    }
    if (patch.base !== undefined) {
      sets.push('base_json = ?');
      params.push(JSON.stringify(patch.base));
    }
    if (patch.sampling !== undefined) {
      sets.push('sampling = ?');
      params.push(patch.sampling);
    }
    if (patch.shotCount !== undefined) {
      sets.push('shot_count = ?');
      params.push(Math.max(1, Math.floor(patch.shotCount)));
    }
    if (patch.seed !== undefined) {
      sets.push('seed = ?');
      params.push(Math.floor(patch.seed));
    }
    if (patch.status !== undefined) {
      sets.push('status = ?');
      params.push(patch.status);
    }
    if (sets.length === 0) return;

    sets.push('updated_at = ?');
    params.push(Date.now(), id);
    this.db.prepare(`UPDATE studies SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  /**
   * Delete a study, and the pictures it made.
   *
   * `study_shots` cascades, but the generations do not — they are ordinary
   * rows carrying `source = 'study'` — so they go explicitly. A shot promoted
   * to a favourite is `comfy` by then and deliberately survives: keeping it
   * was the whole point of promoting it.
   */
  deleteStudy(id: string): void {
    const run = this.db.transaction(() => {
      this.dropStudyGenerations(id);
      this.db.prepare('DELETE FROM studies WHERE id = ?').run(id);
    });
    run();
  }

  /** Every picture a study made that has not been promoted out of it. */
  private dropStudyGenerations(studyId: string): void {
    const ids = this.db
      .prepare<[string], { generation_id: string }>(
        `SELECT generation_id FROM study_shots
          WHERE study_id = ? AND generation_id IS NOT NULL`,
      )
      .all(studyId)
      .map((row) => row.generation_id);

    const drop = this.db.prepare("DELETE FROM generations WHERE id = ? AND source = 'study'");
    for (const generationId of ids) drop.run(generationId);
  }

  /**
   * Write a freshly drawn plan, replacing whatever was there.
   *
   * Replacing rather than appending, because re-planning is what you do after
   * changing the factors — and the old shots were drawn against the old setup.
   * Their pictures go with them; keeping them would silently mix two studies
   * into one set of statistics.
   */
  replaceShots(studyId: string, shots: { id: string; values: ParamValues }[]): void {
    const insert = this.db.prepare(
      `INSERT INTO study_shots (id, study_id, ordinal, values_json, status)
       VALUES (?, ?, ?, ?, 'pending')`,
    );
    const run = this.db.transaction(() => {
      this.dropStudyGenerations(studyId);
      this.db.prepare('DELETE FROM study_shots WHERE study_id = ?').run(studyId);
      shots.forEach((shot, index) => {
        insert.run(shot.id, studyId, index, JSON.stringify(shot.values));
      });
    });
    run();
  }

  listShots(studyId: string): StudyShot[] {
    return this.db
      .prepare<[string], StudyShotRow>(
        'SELECT * FROM study_shots WHERE study_id = ? ORDER BY ordinal',
      )
      .all(studyId)
      .map(toStudyShot);
  }

  getShot(id: string): (StudyShot & { studyId: string }) | null {
    const row = this.db
      .prepare<[string], StudyShotRow>('SELECT * FROM study_shots WHERE id = ?')
      .get(id);
    return row ? { ...toStudyShot(row), studyId: row.study_id } : null;
  }

  /** The next shots to render, in plan order — which is already cost order. */
  nextPendingShots(studyId: string, limit: number): StudyShot[] {
    return this.db
      .prepare<[string, number], StudyShotRow>(
        `SELECT * FROM study_shots
          WHERE study_id = ? AND status = 'pending'
          ORDER BY ordinal LIMIT ?`,
      )
      .all(studyId, limit)
      .map(toStudyShot);
  }

  setShotStatus(id: string, status: StudyShotStatus, generationId?: string | null): void {
    this.db
      .prepare(
        `UPDATE study_shots
            SET status = ?, generation_id = COALESCE(?, generation_id)
          WHERE id = ?`,
      )
      .run(status, generationId ?? null, id);
  }

  /**
   * Put every queued shot of a study back to pending.
   *
   * A shot marked queued whose prompt never reached ComfyUI — a crash, a lost
   * connection, a pause landing mid-submit — would otherwise be skipped
   * forever, leaving a hole in the plan that nothing fills. Pending is the
   * safe reading: at worst a shot renders twice.
   */
  requeueStranded(studyId: string): number {
    return this.db
      .prepare("UPDATE study_shots SET status = 'pending' WHERE study_id = ? AND status = 'queued'")
      .run(studyId).changes;
  }

  /** Which shot a finished generation belongs to, if any. */
  findShotByGeneration(generationId: string): (StudyShot & { studyId: string }) | null {
    const row = this.db
      .prepare<[string], StudyShotRow>('SELECT * FROM study_shots WHERE generation_id = ?')
      .get(generationId);
    return row ? { ...toStudyShot(row), studyId: row.study_id } : null;
  }

  setShotRating(id: string, rating: number | null): void {
    const clamped = rating === null ? null : Math.max(1, Math.min(3, Math.round(rating)));
    this.db
      .prepare('UPDATE study_shots SET rating = ?, rated_at = ? WHERE id = ?')
      .run(clamped, clamped === null ? null : Date.now(), id);
  }

  /**
   * A rendered shot nobody has rated, drawn at random.
   *
   * Random on purpose, and it is the one place in the app where that is a
   * methodological requirement rather than a flourish. The plan runs in cost
   * order, so the pictures arrive grouped by model and by resolution; rating
   * them in that order means judging forty frames from one checkpoint in a
   * row, and by the tenth you have recalibrated to it. What you would be
   * measuring is drift in your own eye. Shuffling keeps the ratings comparable
   * across the study rather than within a block of it.
   */
  randomUnratedShot(studyId: string): StudyShot | null {
    const row = this.db
      .prepare<[string], StudyShotRow>(
        `SELECT * FROM study_shots
          WHERE study_id = ? AND rating IS NULL AND status = 'done'
            AND EXISTS (SELECT 1 FROM images WHERE images.generation_id = study_shots.generation_id)
          ORDER BY RANDOM() LIMIT 1`,
      )
      .get(studyId);
    return row ? toStudyShot(row) : null;
  }

  /** Every rated shot, for the statistics. */
  ratedShots(studyId: string): { values: ParamValues; rating: StudyRating }[] {
    return this.db
      .prepare<[string], { values_json: string; rating: number }>(
        'SELECT values_json, rating FROM study_shots WHERE study_id = ? AND rating IS NOT NULL',
      )
      .all(studyId)
      .map((row) => ({
        values: parseJson<ParamValues>(row.values_json, {}),
        rating: row.rating as StudyRating,
      }));
  }

  /**
   * Move a study's picture into the gallery.
   *
   * One column. The run stops being a study run and becomes an ordinary one,
   * after which every other part of the app — gallery, favourites, archive,
   * the automatic cleanup — treats it like anything else, with no special case
   * anywhere. That is the whole reason the exclusion is a `source` value
   * rather than a separate table.
   */
  promoteStudyGeneration(generationId: string): boolean {
    return (
      this.db
        .prepare("UPDATE generations SET source = 'comfy' WHERE id = ? AND source = 'study'")
        .run(generationId).changes > 0
    );
  }

  /** Only into an empty library — never merged, so nothing is duplicated. */
  importPromptBlocks(state: BlockState, makeId: () => string): number {
    if (this.listPromptBlocks().length > 0) return 0;
    let restored = 0;
    for (const block of state.blocks ?? []) {
      if (!block?.name || !block?.text) continue;
      this.insertPromptBlock(makeId(), block);
      restored += 1;
    }
    return restored;
  }
}

interface StudyRow {
  id: string;
  name: string;
  workflow_id: string | null;
  workflow_name: string;
  status: string;
  factors_json: string;
  base_json: string;
  sampling: string;
  shot_count: number;
  seed: number;
  created_at: number;
  updated_at: number;
}

interface StudyCounts {
  rendered: number;
  failed: number;
  rated: number;
}

interface StudyShotRow {
  id: string;
  study_id: string;
  ordinal: number;
  values_json: string;
  status: string;
  generation_id: string | null;
  rating: number | null;
  rated_at: number | null;
}

function toStudySummary(row: StudyRow & StudyCounts): StudySummary {
  return {
    id: row.id,
    name: row.name,
    workflowId: row.workflow_id,
    workflowName: row.workflow_name,
    status: row.status as StudyStatus,
    sampling: (row.sampling as StudySamplingName) ?? 'lhs',
    shotCount: row.shot_count,
    rendered: row.rendered,
    failed: row.failed,
    rated: row.rated,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toStudyShot(row: StudyShotRow): StudyShot {
  return {
    id: row.id,
    ordinal: row.ordinal,
    values: parseJson<ParamValues>(row.values_json, {}),
    status: row.status as StudyShotStatus,
    generationId: row.generation_id,
    rating: row.rating === null ? null : (row.rating as StudyRating),
    ratedAt: row.rated_at,
  };
}
