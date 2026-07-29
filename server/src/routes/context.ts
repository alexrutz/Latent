import type { ParamSchema, ParamValues } from '@latent/shared';

import type { Archive } from '../archive.js';
import type { Auth } from '../auth.js';
import type { Config } from '../config.js';
import type { Store } from '../db.js';
import type { Importer } from '../importer.js';
import type { Orchestrator } from '../orchestrator.js';
import type { Vault } from '../vault.js';

export interface AppContext {
  config: Config;
  store: Store;
  orchestrator: Orchestrator;
  auth: Auth;
  archive: Archive;
  vault: Vault;
  importer: Importer;
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
