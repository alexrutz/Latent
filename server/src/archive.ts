import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';

import type { ComfyImageRef } from '@latent/shared';

import type { ComfyClient } from './comfy/client.js';
import type { ImageRow, Store } from './db.js';
import { makeThumbnail, readImageSize } from './images/png.js';
import { Vault, VaultLockedError } from './vault.js';

/**
 * A local, encrypted copy of images worth keeping.
 *
 * Two problems solved at once:
 *
 * 1. A gallery row normally just references a file inside ComfyUI's output
 *    directory. When that ComfyUI is a rented vast.ai box, the directory ceases
 *    to exist the moment the instance is destroyed. Rating an image copies the
 *    bytes here, onto the machine actually running Latent.
 *
 * 2. Those copies then sit on a disk indefinitely. Everything written here is
 *    encrypted with a key that only exists while somebody is signed in, so
 *    access to the machine — or to a backup of it — does not mean access to the
 *    pictures.
 *
 * Files are content-addressed, so rating the same image twice is free and two
 * identical outputs share one file.
 */

/** Longest side of a stored thumbnail. Enough for a 2-up grid on a phone at 3x. */
const THUMBNAIL_SIZE = 384;

export interface StoredImage {
  path: string;
  bytes: number;
  thumbPath: string | null;
  thumbBytes: number | null;
  width: number | null;
  height: number | null;
}

export class Archive {
  constructor(
    private readonly root: string,
    private readonly store: Store,
    private readonly vault: Vault,
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
   * Read a stored file back as plaintext.
   *
   * Throws `VaultLockedError` when the archive is locked, so callers can answer
   * with "sign in" rather than a broken image. Files written before encryption
   * existed are returned as-is.
   */
  async read(relativePath: string): Promise<Buffer | null> {
    const absolute = this.resolvePath(relativePath);
    if (!absolute) return null;

    let raw: Buffer;
    try {
      raw = await readFile(absolute);
    } catch {
      return null;
    }

    if (!Vault.isEncrypted(raw)) return raw;
    return this.vault.decrypt(raw);
  }

  private async writeEncrypted(relativePath: string, plaintext: Buffer): Promise<void> {
    const absolute = this.resolvePath(relativePath);
    if (!absolute) throw new Error('Refusing to write outside the archive directory');
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, this.vault.encrypt(plaintext));
  }

  /** Date-sharded so a long-lived archive is not one enormous directory. */
  private pathFor(hash: string, extension: string, suffix = ''): string {
    const now = new Date();
    return join(
      String(now.getUTCFullYear()),
      String(now.getUTCMonth() + 1).padStart(2, '0'),
      `${hash}${suffix}${extension}`,
    );
  }

  /**
   * Store image bytes, with a thumbnail alongside them.
   *
   * `thumbnailSource` is the small preview fetched from ComfyUI when one was
   * available; otherwise a thumbnail is generated locally. Storing one either
   * way is what lets the gallery grid load without pulling full-size images.
   */
  async storeBytes(
    imageId: number,
    filename: string,
    data: Buffer,
    thumbnailSource?: Buffer | null,
  ): Promise<StoredImage> {
    if (!this.vault.isUnlocked) throw new VaultLockedError();

    const hash = createHash('sha256').update(data).digest('hex');
    const extension = (extname(filename) || '.png').toLowerCase();
    const path = this.pathFor(hash, extension);

    if (!(await this.exists(path))) {
      await this.writeEncrypted(path, data);
    }

    const size = readImageSize(data);

    // Prefer what ComfyUI resized for us; fall back to doing it here.
    let thumbnail = thumbnailSource ?? null;
    let thumbExtension = '.webp';
    if (!thumbnail) {
      const generated = makeThumbnail(data, THUMBNAIL_SIZE);
      if (generated) {
        thumbnail = generated.data;
        thumbExtension = '.png';
      }
    }

    let thumbPath: string | null = null;
    let thumbBytes: number | null = null;
    if (thumbnail && thumbnail.length > 0 && thumbnail.length < data.length) {
      thumbPath = this.pathFor(hash, thumbExtension, '_t');
      if (!(await this.exists(thumbPath))) {
        await this.writeEncrypted(thumbPath, thumbnail);
      }
      thumbBytes = thumbnail.length;
    }

    const stored: StoredImage = {
      path,
      bytes: data.length,
      thumbPath,
      thumbBytes,
      width: size?.width ?? null,
      height: size?.height ?? null,
    };

    this.store.setImageArchive(imageId, {
      path: stored.path,
      bytes: stored.bytes,
      encrypted: true,
      thumbPath: stored.thumbPath,
      thumbBytes: stored.thumbBytes,
      width: stored.width,
      height: stored.height,
    });

    return stored;
  }

  /**
   * Fetch an image from ComfyUI and store it locally, thumbnail and all.
   * Idempotent: bytes already present are not downloaded twice.
   */
  async capture(client: ComfyClient, imageId: number, ref: ComfyImageRef): Promise<StoredImage> {
    const response = await client.view(ref);
    const buffer = Buffer.from(await response.arrayBuffer());

    // Ask ComfyUI for the small version too — it already has the decoder, and
    // this is far cheaper than resizing here.
    let preview: Buffer | null = null;
    try {
      const previewResponse = await client.view({ ...ref, preview: `webp;70` });
      const previewBuffer = Buffer.from(await previewResponse.arrayBuffer());
      if (previewBuffer.length > 0 && previewBuffer.length < buffer.length) {
        preview = previewBuffer;
      }
    } catch {
      // Not every ComfyUI build implements `preview=`; we'll resize locally.
    }

    return this.storeBytes(imageId, ref.filename, buffer, preview);
  }

  /**
   * Drop an archived copy, unless another image row still points at the same
   * content-addressed file.
   */
  async forget(imageId: number, row: Pick<ImageRow, 'archived_path' | 'thumb_path'>): Promise<void> {
    const { archived_path: archivedPath, thumb_path: thumbPath } = row;
    this.store.clearImageArchive(imageId);

    for (const path of [archivedPath, thumbPath]) {
      if (!path) continue;
      if (this.store.archivePathInUseElsewhere(path, imageId)) continue;
      const absolute = this.resolvePath(path);
      if (absolute) await rm(absolute, { force: true });
    }
  }

  /** Remove archived copies of images nobody rated. Returns how many went. */
  async pruneUnrated(): Promise<number> {
    let removed = 0;
    for (const row of this.store.listUnratedArchived()) {
      if (!row.archived_path) continue;
      await this.forget(row.id, row);
      removed += 1;
    }
    return removed;
  }
}
