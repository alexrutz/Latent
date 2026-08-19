import type { ParamSchema, ParamValues } from '@latent/shared';

import type { Archive } from '../archive.js';
import type { Auth } from '../auth.js';
import type { Config } from '../config.js';
import type { Endless } from '../endless.js';
import type { Store } from '../db.js';
import type { ThumbnailCache, ViewRenderer } from '../images/thumbnails.js';
import type { Importer } from '../importer.js';
import type { InputLibrary } from '../inputLibrary.js';
import type { Orchestrator } from '../orchestrator.js';
import type { StateFiles } from '../statefile.js';
import type { StudyRunner } from '../study.js';
import type { Sweeper } from '../sweeper.js';
import type { Taste } from '../taste.js';
import type { Vault } from '../vault.js';
import type { WorkflowScanner } from '../workflowScan.js';

export interface AppContext {
  config: Config;
  store: Store;
  orchestrator: Orchestrator;
  auth: Auth;
  archive: Archive;
  vault: Vault;
  /** Notes about what the user likes, readable while the vault is open. */
  taste: Taste;
  importer: Importer;
  /** The read-only folder of pictures to feed into workflows. */
  inputs: InputLibrary;
  /** Mirrors the arrangement of the app to files outside the project. */
  stateFiles: StateFiles;
  /** Deletes generations nobody kept, once they are old enough. */
  sweeper: Sweeper;
  /** Reads every workflow saved in the ComfyUI installation. */
  workflowScanner: WorkflowScanner;
  /** Keeps the queue fed while endless generation is switched on. */
  endless: Endless;
  /** Walks a parameter study's plan, one shot at a time. */
  studyRunner: StudyRunner;
  /**
   * Small copies of big pictures, so the gallery never sends full-size ones.
   *
   * Held on the context rather than made per request because the whole point
   * is that the work is done once: see `ThumbnailCache`.
   */
  thumbnails: ThumbnailCache;
  /**
   * Views of one picture at the size a screen can use, for the viewer.
   *
   * Apart from the thumbnail cache because it holds something else: decoded
   * pictures, so the next rectangle of the one being pinched is cheap.
   */
  views: ViewRenderer;
}

/**
 * A short human label for a generation, shown on gallery cards and in the queue.
 * The positive prompt is what people actually recognise a job by.
 */
export function deriveTitle(schema: ParamSchema, values: ParamValues, fallback: string): string {
  const promptField =
    schema.fields.find((f) => f.role === 'prompt' && !f.hidden) ??
    schema.fields.find((f) => f.role === 'prompt');

  const raw = promptField ? values[promptField.id] ?? promptField.defaultValue : null;
  const text = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
  if (!text) return fallback;
  return text.length > 140 ? `${text.slice(0, 139)}…` : text;
}
