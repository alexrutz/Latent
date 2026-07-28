import Database from 'better-sqlite3';

import type {
  AppSettings,
  FieldOverrides,
  GenerationImage,
  GenerationRecord,
  GenerationStatus,
  ParamSchema,
  ParamValues,
  WorkflowDetail,
  WorkflowSummary,
} from '@latent/shared';
import type { ApiWorkflow } from '@latent/shared';

const SCHEMA = `
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
`;

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
  title: string;
  created_at: number;
  completed_at: number | null;
}

interface ImageRow {
  generation_id: string;
  node_id: string;
  filename: string;
  subfolder: string;
  type: string;
}

/** Tolerate a corrupt/legacy JSON column rather than crashing the whole request. */
function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

const DEFAULT_SETTINGS: AppSettings = {
  upscaleWorkflowId: null,
  img2imgWorkflowId: null,
  defaultWorkflowId: null,
};

export class Store {
  private readonly db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);
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
  }): void {
    this.db
      .prepare(
        `INSERT INTO generations
           (id, prompt_id, workflow_id, workflow_name, status, error, values_json, seeds_json, title, created_at, completed_at)
         VALUES (?, ?, ?, ?, 'queued', NULL, ?, ?, ?, ?, NULL)`,
      )
      .run(
        record.id,
        record.promptId,
        record.workflowId,
        record.workflowName,
        JSON.stringify(record.values),
        JSON.stringify(record.seeds),
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

  addImages(promptId: string, nodeId: string, images: GenerationImage[]): void {
    const generation = this.db
      .prepare<[string], { id: string }>('SELECT id FROM generations WHERE prompt_id = ?')
      .get(promptId);
    if (!generation) return;

    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO images (generation_id, node_id, filename, subfolder, type)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const insertAll = this.db.transaction((items: GenerationImage[]) => {
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
  listGenerations(options: { limit: number; cursor?: string | null; workflowId?: string | null }): {
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
      title: row.title,
      images: images.map((image) => ({
        nodeId: image.node_id,
        filename: image.filename,
        subfolder: image.subfolder,
        type: image.type,
      })),
      createdAt: row.created_at,
      completedAt: row.completed_at,
    };
  }

  /* ---------------------------------------------------------------- */
  /* Settings                                                          */
  /* ---------------------------------------------------------------- */

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
