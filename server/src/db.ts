import Database from 'better-sqlite3';

import type {
  AppSettings,
  ArchiveStats,
  ComfyImageRef,
  ConnectionAuthMode,
  ConnectionInput,
  ConnectionSummary,
  FieldOverrides,
  GenerationRecord,
  GenerationStatus,
  ParamSchema,
  Favorite,
  FavoriteSort,
  FormLayout,
  GenerationImage,
  ParamSummaryItem,
  ParamValues,
  PromptBlock,
  PromptBlockInput,
  TileSpan,
  WorkflowDetail,
  WorkflowPreset,
  WorkflowSummary,
} from '@latent/shared';
import type { ApiWorkflow, RandomPromptConfig } from '@latent/shared';
import { DEFAULT_RANDOM_PROMPT_CONFIG, normaliseRandomPromptConfig } from '@latent/shared';

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

interface WorkflowRow {
  id: string;
  name: string;
  graph_json: string;
  schema_json: string;
  overrides_json: string;
  last_values_json: string;
  created_at: number;
  updated_at: number;
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
  archived_path: string | null;
  archived_bytes: number | null;
  thumb_path: string | null;
  thumb_bytes: number | null;
  width: number | null;
  height: number | null;
  encrypted: number;
  tile_span: string | null;
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

interface ConnectionRow {
  id: string;
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
    nodeId: row.node_id,
    filename: row.filename,
    subfolder: row.subfolder,
    type: row.type,
    rating: row.rating ?? 0,
    archived: Boolean(row.archived_path),
    hasThumbnail: Boolean(row.thumb_path),
    width: row.width,
    height: row.height,
    tileSpan: parseTileSpan(row.tile_span),
  };
}

function toFavorite(row: FavoriteRow, workflowAvailable: boolean): Favorite {
  const image = parseJson<GenerationImage | null>(row.image_json, null);
  return {
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
  importRoot: null,
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
        capabilities: { img2img: false, seeded: false },
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
  }): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO workflows
           (id, name, graph_json, schema_json, overrides_json, last_values_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, '{}', ?, ?, ?)`,
      )
      .run(
        input.id,
        input.name,
        JSON.stringify(input.graph),
        JSON.stringify(input.schema),
        JSON.stringify(input.lastValues),
        now,
        now,
      );
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
      capabilities: { img2img: false, seeded: false },
      missingNodeTypes: [],
    });
    return {
      id: row.id,
      name: row.name,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      capabilities: schema.capabilities,
      missingNodeTypes: schema.missingNodeTypes ?? [],
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
  }): void {
    this.db
      .prepare(
        `INSERT INTO generations
           (id, prompt_id, workflow_id, workflow_name, status, error, values_json, seeds_json, params_json, title, created_at, completed_at)
         VALUES (?, ?, ?, ?, 'queued', NULL, ?, ?, ?, ?, ?, NULL)`,
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

  /** Takes bare ComfyUI refs; rating and archive state are added later by the user. */
  addImages(promptId: string, nodeId: string, images: ComfyImageRef[]): void {
    const generation = this.db
      .prepare<[string], { id: string }>('SELECT id FROM generations WHERE prompt_id = ?')
      .get(promptId);
    if (!generation) return;

    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO images (generation_id, node_id, filename, subfolder, type)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const insertAll = this.db.transaction((items: ComfyImageRef[]) => {
      for (const image of items) {
        insert.run(generation.id, nodeId, image.filename, image.subfolder ?? '', image.type ?? 'output');
      }
    });
    insertAll(images);
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
  listGenerations(options: {
    limit: number;
    cursor?: string | null;
    workflowId?: string | null;
    /** Only generations holding an image rated at least this highly. */
    minRating?: number;
  }): {
    items: GenerationRecord[];
    nextCursor: string | null;
  } {
    const limit = Math.min(Math.max(options.limit, 1), 100);
    const where: string[] = [];
    const params: unknown[] = [];

    if (options.cursor) {
      const [createdAt, id] = options.cursor.split('_');
      const ts = Number(createdAt);
      if (Number.isFinite(ts) && id) {
        where.push('(created_at < ? OR (created_at = ? AND id < ?))');
        params.push(ts, ts, id);
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

    const sql = `SELECT * FROM generations
                 ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                 ORDER BY created_at DESC, id DESC
                 LIMIT ?`;
    const rows = this.db.prepare<unknown[], GenerationRow>(sql).all(...params, limit + 1);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page.at(-1);

    return {
      items: page.map((row) => this.hydrateGeneration(row)),
      nextCursor: hasMore && last ? `${last.created_at}_${last.id}` : null,
    };
  }

  deleteGeneration(id: string): void {
    this.db.prepare('DELETE FROM images WHERE generation_id = ?').run(id);
    this.db.prepare('DELETE FROM generations WHERE id = ?').run(id);
  }

  /**
   * Generations left "running" when the process died can never complete — the
   * upstream events that would finish them are long gone. Reconciled at boot.
   */
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
  findImage(ref: ComfyImageRef): (ImageRow & { generationId: string }) | null {
    const row = this.db
      .prepare<[string, string, string], ImageRow>(
        `SELECT * FROM images
          WHERE filename = ? AND subfolder = ? AND type = ?
          ORDER BY id DESC LIMIT 1`,
      )
      .get(ref.filename, ref.subfolder ?? '', ref.type ?? 'output');
    return row ? { ...row, generationId: row.generation_id } : null;
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
                thumb_path = ?, thumb_bytes = ?,
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

    return rows.map((row) => toFavorite(row, row.workflow_id !== null && available.has(row.workflow_id)));
  }

  getFavorite(id: string): Favorite | null {
    const row = this.db
      .prepare<[string], FavoriteRow>('SELECT * FROM favorites WHERE id = ?')
      .get(id);
    if (!row) return null;
    const available =
      row.workflow_id !== null && this.getWorkflow(row.workflow_id) !== null;
    return toFavorite(row, available);
  }

  /** True when this exact image is already a favourite, so the UI can toggle. */
  findFavoriteByImage(imageId: number): Favorite | null {
    const row = this.db
      .prepare<[number], FavoriteRow>('SELECT * FROM favorites WHERE image_id = ? LIMIT 1')
      .get(imageId);
    if (!row) return null;
    return toFavorite(row, row.workflow_id !== null && this.getWorkflow(row.workflow_id) !== null);
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
  }): number {
    this.db
      .prepare(
        `INSERT INTO generations
           (id, prompt_id, workflow_id, workflow_name, status, error, values_json, seeds_json, title, created_at, completed_at, source)
         VALUES (?, ?, NULL, 'Imported', 'completed', NULL, '{}', '{}', ?, ?, ?, 'import')`,
      )
      .run(input.generationId, input.promptId, input.title, input.modifiedAt, input.modifiedAt);

    const result = this.db
      .prepare(
        `INSERT INTO images (generation_id, node_id, filename, subfolder, type)
         VALUES (?, 'import', ?, ?, 'import')`,
      )
      .run(input.generationId, input.filename, input.subfolder);

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

  getActiveConnection(): (ConnectionSummary & { secret: string | null }) | null {
    const row = this.db
      .prepare<[], ConnectionRow>('SELECT * FROM connections WHERE is_active = 1 LIMIT 1')
      .get();
    return row ? { ...toConnectionSummary(row), secret: row.secret } : null;
  }

  insertConnection(id: string, input: ConnectionInput): void {
    this.db
      .prepare(
        `INSERT INTO connections
           (id, name, url, auth_mode, username, secret, allow_self_signed, is_active, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      )
      .run(
        id,
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

  activateConnection(id: string): void {
    const activate = this.db.transaction((target: string) => {
      this.db.prepare('UPDATE connections SET is_active = 0').run();
      this.db.prepare('UPDATE connections SET is_active = 1 WHERE id = ?').run(target);
    });
    activate(id);
  }

  countConnections(): number {
    const row = this.db
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

  getSettings(): AppSettings {
    const rows = this.db.prepare<[], { key: string; value: string }>('SELECT * FROM settings').all();
    const settings: Record<string, string | null> = { ...DEFAULT_SETTINGS };
    for (const row of rows) {
      if (row.key in DEFAULT_SETTINGS) settings[row.key] = row.value === '' ? null : row.value;
    }
    return settings as unknown as AppSettings;
  }

  updateSettings(patch: Partial<AppSettings>): AppSettings {
    const upsert = this.db.prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    );
    for (const [key, value] of Object.entries(patch)) {
      if (!(key in DEFAULT_SETTINGS)) continue;
      upsert.run(key, value == null ? '' : String(value));
    }
    return this.getSettings();
  }
}
