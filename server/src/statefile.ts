import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';

import type { Store } from './db.js';
import type { BlockState, UiState } from './uiState.js';

/** How often the files are checked against the database. */
const INTERVAL_MS = 3_000;

export interface StateFilePaths {
  ui: string;
  blocks: string;
}

export function stateFilePaths(directory: string): StateFilePaths {
  return {
    ui: join(directory, 'latent-settings.json'),
    blocks: join(directory, 'latent-prompt-blocks.json'),
  };
}

/**
 * Keeps the arrangement of the app in files outside the project directory.
 *
 * The database lives inside the project, which is exactly what you throw away
 * when you want a clean start — and with it every form layout, saved setup and
 * prompt block, none of which had anything to do with whatever you were
 * restarting to fix. These two files sit a directory above, are written whenever
 * the database changes, and are read back on boot into whatever is missing.
 *
 * Two files rather than one because they are used differently: the prompt
 * library is worth copying to another machine or keeping in version control on
 * its own, while the rest is this installation's configuration.
 *
 * Mirroring by comparing snapshots, rather than by hooking every write, is
 * deliberate: there is no list of call sites to keep up to date, so a feature
 * added later cannot silently stop being saved.
 */
export class StateFiles {
  private readonly paths: StateFilePaths;
  private timer: NodeJS.Timeout | null = null;
  private lastUi = '';
  private lastBlocks = '';

  constructor(
    private readonly store: Store,
    directory: string,
    private readonly log: FastifyBaseLogger,
  ) {
    this.paths = stateFilePaths(directory);
  }

  /** Read the files into anything the database does not already have. */
  restore(): void {
    const ui = read<UiState>(this.paths.ui);
    if (ui) {
      try {
        this.store.importUiState(ui, randomUUID);
        this.log.info(`Restored settings from ${this.paths.ui}`);
      } catch (cause) {
        this.log.warn({ err: cause }, 'Could not restore settings file');
      }
    }

    const blocks = read<BlockState>(this.paths.blocks);
    if (blocks) {
      try {
        const restored = this.store.importPromptBlocks(blocks, randomUUID);
        if (restored > 0) this.log.info(`Restored ${restored} prompt blocks`);
      } catch (cause) {
        this.log.warn({ err: cause }, 'Could not restore prompt blocks file');
      }
    }

    // Seed the comparison so an unchanged database does not rewrite both files
    // on the first tick.
    this.lastUi = serialise(this.store.exportUiState());
    this.lastBlocks = serialise(this.store.exportPromptBlocks());
  }

  /**
   * Give a freshly imported workflow the layout a previous install had for it.
   * Matched by name, which is all that survives a rebuilt database.
   */
  adopt(workflowId: string, name: string): void {
    const ui = read<UiState>(this.paths.ui);
    const saved = ui?.workflows?.[name];
    if (!saved) return;
    try {
      this.store.adoptWorkflowState(workflowId, saved, randomUUID);
      this.log.info(`Reapplied the saved form layout for “${name}”`);
    } catch (cause) {
      this.log.warn({ err: cause }, 'Could not reapply a saved workflow layout');
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.flush(), INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.flush();
  }

  /** Write whichever file no longer matches the database. */
  flush(): void {
    try {
      const ui = serialise(this.store.exportUiState());
      if (ui !== this.lastUi) {
        write(this.paths.ui, ui);
        this.lastUi = ui;
      }

      const blocks = serialise(this.store.exportPromptBlocks());
      if (blocks !== this.lastBlocks) {
        write(this.paths.blocks, blocks);
        this.lastBlocks = blocks;
      }
    } catch (cause) {
      // A read-only parent directory must not take the server down with it.
      this.log.warn({ err: cause }, 'Could not write the settings files');
    }
  }
}

/**
 * `savedAt` is stripped before comparing.
 *
 * It changes on every export, so leaving it in would rewrite both files every
 * three seconds forever.
 */
function serialise(state: UiState | BlockState): string {
  const { savedAt: _ignored, ...rest } = state;
  return JSON.stringify(rest, null, 2);
}

function write(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  // Written whole and then moved into place, so an interrupted write cannot
  // leave a half-file where the settings used to be. 0600 because the
  // connection secrets are in here.
  writeFileSync(temporary, `${body}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function read<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}
