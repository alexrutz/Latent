import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
  scryptSync,
} from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';

import type { Store } from './db.js';
import type { BlockState, UiState } from './uiState.js';

/** How often the files are checked against the database. */
const INTERVAL_MS = 3_000;

const IV_LENGTH = 12;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
/** scrypt cost. Matches the vault's, and is paid once per unlock, not per write. */
const SCRYPT = { N: 16_384, r: 8, p: 1 } as const;

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
 * What is actually on disk: a readable envelope around an unreadable payload.
 *
 * The salt has to be legible without the key — it is what the key is derived
 * from — and keeping the whole thing JSON means the file still matches its own
 * extension and can be inspected enough to tell what it is.
 */
interface Envelope {
  latent: 'encrypted';
  v: 1;
  kdf: { name: 'scrypt'; salt: string; N: number; r: number; p: number };
  iv: string;
  /** Ciphertext followed by the GCM tag, base64. */
  data: string;
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
 *
 * **Both files are encrypted** with a key derived from the app password, for the
 * same reason the image archive is: they hold connection secrets and the whole
 * prompt library, and they sit in a directory chosen precisely because it does
 * not get deleted. That has one consequence worth stating plainly — the files
 * are readable only by an install that knows the password they were written
 * under. Wiping the database and choosing a *different* password on the way back
 * up leaves them undecryptable, and Latent will refuse to overwrite them rather
 * than quietly destroy what they hold.
 */
export class StateFiles {
  private readonly paths: StateFilePaths;
  private timer: NodeJS.Timeout | null = null;
  private lastUi = '';
  private lastBlocks = '';

  /** Derived from the password. Null until somebody signs in. */
  private key: Buffer | null = null;
  private salt: Buffer | null = null;
  /** Files that exist but could not be read, and so must not be written over. */
  private readonly blocked = new Set<string>();

  constructor(
    private readonly store: Store,
    directory: string,
    private readonly log: FastifyBaseLogger,
  ) {
    this.paths = stateFilePaths(directory);
  }

  /**
   * Derive the file key from the password and read whatever is on disk.
   *
   * Called on sign-in, on first-run setup, and at boot when the password comes
   * from the environment. Until it happens nothing is written, because there is
   * nothing to encrypt with — the database keeps everything in the meantime and
   * the next flush catches up.
   */
  unlock(password: string): void {
    this.salt = this.readSalt() ?? randomBytes(SALT_LENGTH);
    this.key = scryptSync(password, this.salt, KEY_LENGTH, SCRYPT);
    this.blocked.clear();
    this.restore();
  }

  /**
   * Re-encrypt both files under a new password.
   *
   * Unlike the image archive there is no wrapped master key to re-wrap: these
   * are two small files, so they are simply rewritten.
   */
  rekey(password: string): void {
    const ui = this.store.exportUiState();
    const blocks = this.store.exportPromptBlocks();

    this.salt = randomBytes(SALT_LENGTH);
    this.key = scryptSync(password, this.salt, KEY_LENGTH, SCRYPT);
    this.blocked.clear();

    try {
      this.write(this.paths.ui, serialise(ui));
      this.write(this.paths.blocks, serialise(blocks));
      this.lastUi = serialise(ui);
      this.lastBlocks = serialise(blocks);
    } catch (cause) {
      this.log.warn({ err: cause }, 'Could not re-encrypt the settings files');
    }
  }

  /** Read the files into anything the database does not already have. */
  restore(): void {
    const ui = this.read<UiState>(this.paths.ui);
    if (ui) {
      try {
        this.store.importUiState(ui, randomUUID);
        this.log.info(`Restored settings from ${this.paths.ui}`);
      } catch (cause) {
        this.log.warn({ err: cause }, 'Could not restore settings file');
      }
    }

    const blocks = this.read<BlockState>(this.paths.blocks);
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
    const ui = this.read<UiState>(this.paths.ui);
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
    // Nothing to encrypt with yet: the database still holds all of it, and the
    // first flush after sign-in writes both files.
    if (!this.key) return;

    try {
      const ui = serialise(this.store.exportUiState());
      if (ui !== this.lastUi && this.write(this.paths.ui, ui)) this.lastUi = ui;

      const blocks = serialise(this.store.exportPromptBlocks());
      if (blocks !== this.lastBlocks && this.write(this.paths.blocks, blocks)) {
        this.lastBlocks = blocks;
      }
    } catch (cause) {
      // A read-only parent directory must not take the server down with it.
      this.log.warn({ err: cause }, 'Could not write the settings files');
    }
  }

  /** The salt already in use, so re-deriving the key produces the same one. */
  private readSalt(): Buffer | null {
    for (const path of [this.paths.ui, this.paths.blocks]) {
      const envelope = readEnvelope(path);
      if (envelope) return Buffer.from(envelope.kdf.salt, 'base64');
    }
    return null;
  }

  private read<T>(path: string): T | null {
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      return null; // Not there yet, which is the ordinary first-run case.
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.block(path, 'it is not valid JSON');
      return null;
    }

    // A file written before these were encrypted. Read it as it is; the next
    // flush replaces it with an encrypted one.
    if (!isEnvelope(parsed)) return parsed as T;

    if (!this.key) return null;
    try {
      const iv = Buffer.from(parsed.iv, 'base64');
      const payload = Buffer.from(parsed.data, 'base64');
      const tag = payload.subarray(payload.length - 16);
      const body = payload.subarray(0, payload.length - 16);

      const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
      decipher.setAuthTag(tag);
      const plain = Buffer.concat([decipher.update(body), decipher.final()]);
      return JSON.parse(plain.toString('utf8')) as T;
    } catch {
      this.block(
        path,
        'it was encrypted under a different password. Move it aside if you want a fresh one',
      );
      return null;
    }
  }

  /**
   * Refuse to write a file we could not read.
   *
   * Overwriting it would destroy the layouts and prompt library it holds, which
   * is the one outcome these files exist to prevent.
   */
  private block(path: string, why: string): void {
    if (this.blocked.has(path)) return;
    this.blocked.add(path);
    this.log.warn(`Not writing ${path}: ${why}.`);
  }

  /** @returns whether the file was written. */
  private write(path: string, body: string): boolean {
    if (!this.key || !this.salt || this.blocked.has(path)) return false;

    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(body, 'utf8'), cipher.final()]);
    const envelope: Envelope = {
      latent: 'encrypted',
      v: 1,
      kdf: { name: 'scrypt', salt: this.salt.toString('base64'), ...SCRYPT },
      iv: iv.toString('base64'),
      data: Buffer.concat([encrypted, cipher.getAuthTag()]).toString('base64'),
    };

    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.tmp`;
    // Written whole and then moved into place, so an interrupted write cannot
    // leave a half-file where the settings used to be.
    writeFileSync(temporary, `${JSON.stringify(envelope, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
    return true;
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

function isEnvelope(value: unknown): value is Envelope {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<Envelope>;
  return (
    candidate.latent === 'encrypted' &&
    typeof candidate.iv === 'string' &&
    typeof candidate.data === 'string' &&
    typeof candidate.kdf?.salt === 'string'
  );
}

/** The header of an existing file, without needing a key to read it. */
function readEnvelope(path: string): Envelope | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return isEnvelope(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
