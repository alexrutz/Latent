import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';

import type { ComfyImageRef } from '@latent/shared';

import type { ComfyClient } from './comfy/client.js';
import type { Store } from './db.js';

/**
 * A local copy of images worth keeping.
 *
 * The whole point: a gallery row normally just references a file inside
 * ComfyUI's output directory. When that ComfyUI is a rented vast.ai box, the
 * directory ceases to exist the moment the instance is destroyed — and every
 * image you liked goes with it. Rating an image copies the bytes here, onto the
 * machine actually running Latent, where they survive.
 *
 * Files are content-addressed, so rating the same image twice is free and two
 * identical outputs share one file.
 */
export class Archive {
  constructor(
    private readonly root: string,
    private readonly store: Store,
  ) {}

  /** Absolute path for a stored relative path, guarded against traversal. */
  resolvePath(relativePath: string): string | null {
    const absolute = resolve(this.root, relativePath);
    // A poisoned database row must not be able to read arbitrary files.
    const within = relative(this.root, absolute);
    if (within.startsWith('..') || within.startsWith(sep) || resolve(absolute) !== absolute) {
      return null;
    }
    return absolute;
  }

  async read(relativePath: string): Promise<Buffer | null> {
    const absolute = this.resolvePath(relativePath);
    if (!absolute) return null;
    try {
      return await readFile(absolute);
    } catch {
      return null;
    }
  }

  async exists(relativePath: string): Promise<boolean> {
    const absolute = this.resolvePath(relativePath);
    if (!absolute) return false;
    try {
      await stat(absolute);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Fetch an image from ComfyUI and store it locally.
   *
   * Returns the relative path recorded in the database. Idempotent: an image
   * whose bytes are already present is not downloaded twice.
   */
  async capture(
    client: ComfyClient,
    imageId: number,
    ref: ComfyImageRef,
  ): Promise<{ path: string; bytes: number }> {
    const response = await client.view(ref);
    const buffer = Buffer.from(await response.arrayBuffer());

    const hash = createHash('sha256').update(buffer).digest('hex');
    const extension = (extname(ref.filename) || '.png').toLowerCase();
    // Sharded by date so a long-lived archive doesn't end up as one enormous
    // directory, and so it is easy to find or prune by period.
    const now = new Date();
    const relativePath = join(
      String(now.getUTCFullYear()),
      String(now.getUTCMonth() + 1).padStart(2, '0'),
      `${hash}${extension}`,
    );

    const absolute = this.resolvePath(relativePath);
    if (!absolute) throw new Error('Refusing to write outside the archive directory');

    if (!(await this.exists(relativePath))) {
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, buffer);
    }

    this.store.setImageArchive(imageId, relativePath, buffer.length);
    return { path: relativePath, bytes: buffer.length };
  }

  /**
   * Drop an archived copy, unless another image row still points at the same
   * content-addressed file.
   */
  async forget(imageId: number, relativePath: string): Promise<void> {
    this.store.clearImageArchive(imageId);
    if (this.store.archivePathInUseElsewhere(relativePath, imageId)) return;

    const absolute = this.resolvePath(relativePath);
    if (!absolute) return;
    await rm(absolute, { force: true });
  }

  /** Remove archived copies of images nobody rated. Returns how many went. */
  async pruneUnrated(): Promise<number> {
    let removed = 0;
    for (const row of this.store.listUnratedArchived()) {
      if (!row.archived_path) continue;
      await this.forget(row.id, row.archived_path);
      removed += 1;
    }
    return removed;
  }
}
