import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { mediaKindOf } from '@latent/shared';
import type { ComfyImageRef } from '@latent/shared';

import type { ComfyClient } from './comfy/client.js';
import type { ImageRow, Store } from './db.js';
import { makeThumbnail, readImageSize } from './images/png.js';
import { ArchiveUnreadableError, Vault, VaultLockedError } from './vault.js';

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

    try {
      return this.vault.decrypt(raw);
    } catch (error) {
      // A locked vault is a different problem from a file we will never be able
      // to read, and the caller needs to tell the user which one it is.
      if (error instanceof VaultLockedError) throw error;
      throw new ArchiveUnreadableError();
    }
  }

  /**
   * Whether a file is already there *and* this install can read it.
   *
   * Archive paths are content-addressed, so the same picture always lands at
   * the same path and identical bytes are stored once. That shortcut assumed
   * an existing file belongs to us, and after a clean start it does not: the
   * archive is deliberately kept while the database is thrown away, so the new
   * database has a new master key and every file already there was encrypted
   * under the old one. Keeping such a file and recording a row that points at
   * it produces an image that can never be decrypted — for a picture the user
   * has right there on disk and is importing precisely to keep.
   *
   * So the existence check is a *readability* check, and anything we cannot
   * read is written over with the copy we were just handed.
   */
  private async readable(relativePath: string): Promise<boolean> {
    try {
      return (await this.read(relativePath)) !== null;
    } catch {
      // Locked or undecryptable. Locked never gets here — the caller checks
      // first — so this is the stale-ciphertext case, and it must be rewritten.
      return false;
    }
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
   * The thumbnail is made here, always. It used to prefer whatever ComfyUI
   * answered `preview=webp;70` with, on the belief that it had already done the
   * resizing — it has not. That endpoint re-encodes and moves not one pixel, so
   * what got filed as the thumbnail of a 4000×4000 picture was a 4000×4000
   * webp, and it passed the "smaller than the original" check every time
   * because webp is always smaller than PNG at the same size.
   */
  async storeBytes(imageId: number, filename: string, data: Buffer): Promise<StoredImage> {
    if (!this.vault.isUnlocked) throw new VaultLockedError();

    const hash = createHash('sha256').update(data).digest('hex');
    const extension = (extname(filename) || '.png').toLowerCase();
    const path = this.pathFor(hash, extension);

    if (!(await this.readable(path))) {
      await this.writeEncrypted(path, data);
    }

    const size = readImageSize(data);

    const generated = makeThumbnail(data, THUMBNAIL_SIZE);
    const thumbnail = generated?.data ?? null;

    let thumbPath: string | null = null;
    let thumbBytes: number | null = null;
    if (thumbnail && thumbnail.length > 0) {
      thumbPath = this.pathFor(hash, '.png', '_t');
      if (!(await this.readable(thumbPath))) {
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
   * Fetch an output from ComfyUI and store it locally, thumbnail and all.
   * Idempotent: bytes already present are not downloaded twice.
   */
  async capture(client: ComfyClient, imageId: number, ref: ComfyImageRef): Promise<StoredImage> {
    const response = await client.view(ref);

    // A clip or a track goes to disk as it arrives. Either is routinely a
    // hundred times the size of a picture, and there is no reason for one to be
    // a Buffer on the way past.
    if (mediaKindOf(ref.filename) !== 'image') {
      if (!response.body) throw new Error('ComfyUI returned an empty file');
      return this.storeStreamed(
        imageId,
        ref.filename,
        Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
      );
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    // One download, not two: the second one used to ask for `preview=` in the
    // belief that it came back resized, and it never did.
    return this.storeBytes(imageId, ref.filename, buffer);
  }

  /**
   * Keep a clip or a track, as itself.
   *
   * Two deliberate differences from a picture. It is **not encrypted**: the
   * archive's encryption is whole-file AES-GCM, which cannot be read from the
   * middle, and a video is watched by asking for the middle — every seek, and on
   * some browsers every play, is a byte range. Encrypting it would mean holding
   * the whole clip in memory to answer each of those, for a file that is
   * routinely a hundred times the size of a picture. And it is **streamed**, for
   * the same reason: a rendered clip goes to disk without ever being a Buffer.
   *
   * The pictures alongside it stay encrypted exactly as before. This is the one
   * relaxation, and it is confined to the file type that forced it.
   */
  async storeStreamed(imageId: number, filename: string, source: Readable): Promise<StoredImage> {
    const staging = join('.staging', randomUUID());
    const stagingPath = this.resolvePath(staging);
    if (!stagingPath) throw new Error('Refusing to write outside the archive directory');
    await mkdir(dirname(stagingPath), { recursive: true });

    const hash = createHash('sha256');
    let bytes = 0;
    // Hashed on the way past, so the file is content-addressed without ever
    // being read a second time.
    const measure = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        hash.update(chunk);
        bytes += chunk.length;
        done(null, chunk);
      },
    });

    try {
      await pipeline(source, measure, createWriteStream(stagingPath));

      const digest = hash.digest('hex');
      const path = this.pathFor(digest, (extname(filename) || '.mp4').toLowerCase());
      const absolute = this.resolvePath(path);
      if (!absolute) throw new Error('Refusing to write outside the archive directory');
      await mkdir(dirname(absolute), { recursive: true });
      // Content-addressed: the same clip stored twice is one file. `rename`
      // over an existing copy is atomic and costs nothing.
      await rename(stagingPath, absolute);

      const stored: StoredImage = {
        path,
        bytes,
        thumbPath: null,
        thumbBytes: null,
        width: null,
        height: null,
      };
      this.store.setImageArchive(imageId, {
        path,
        bytes,
        encrypted: false,
        // Left alone rather than cleared: a poster captured while watching is
        // the only preview this file has, and archiving must not lose it.
        thumbPath: null,
        thumbBytes: null,
        width: null,
        height: null,
      });
      return stored;
    } finally {
      await rm(stagingPath, { force: true }).catch(() => undefined);
    }
  }

  /**
   * File a still for something this server cannot decode — a video's poster.
   *
   * Small and encrypted like any other thumbnail: it is a picture, whatever it
   * is a picture *of*, and the reasons for encrypting the archive apply to a
   * frame of a video exactly as they do to a rendered image.
   */
  async storePoster(
    imageId: number,
    poster: Buffer,
    size?: { width: number; height: number } | null,
  ): Promise<string> {
    if (!this.vault.isUnlocked) throw new VaultLockedError();

    const hash = createHash('sha256').update(poster).digest('hex');
    const path = this.pathFor(hash, '.png', '_t');
    if (!(await this.readable(path))) await this.writeEncrypted(path, poster);

    const measured = size ?? readImageSize(poster);
    this.store.setImagePoster(imageId, {
      path,
      bytes: poster.length,
      width: measured?.width ?? null,
      height: measured?.height ?? null,
    });
    return path;
  }

  /**
   * Part of a stored file, as a stream.
   *
   * What makes a video watchable: a browser asks for the first megabyte, then
   * for whatever it needs when you drag the scrubber, and answering those with
   * the whole file is the difference between a clip that starts and one that
   * downloads. Only the unencrypted files — videos — can be read from the
   * middle; anything encrypted is decrypted whole and sliced, which is correct
   * but is why videos are not encrypted in the first place.
   */
  async readRange(
    relativePath: string,
    range: { start: number; end: number } | null,
  ): Promise<{ stream: Readable; start: number; end: number; size: number } | null> {
    const absolute = this.resolvePath(relativePath);
    if (!absolute) return null;

    let fileSize: number;
    try {
      fileSize = (await stat(absolute)).size;
    } catch {
      return null;
    }

    // Six bytes is the whole question: our header, or somebody's video.
    let header: Buffer;
    try {
      header = await readHead(absolute, 8);
    } catch {
      return null;
    }

    if (Vault.isEncrypted(header)) {
      const plaintext = await this.read(relativePath);
      if (!plaintext) return null;
      const start = Math.min(range?.start ?? 0, Math.max(0, plaintext.length - 1));
      const end = Math.min(range?.end ?? plaintext.length - 1, plaintext.length - 1);
      return {
        stream: Readable.from(plaintext.subarray(start, end + 1)),
        start,
        end,
        size: plaintext.length,
      };
    }

    const start = Math.min(range?.start ?? 0, Math.max(0, fileSize - 1));
    const end = Math.min(range?.end ?? fileSize - 1, fileSize - 1);
    return {
      stream: createReadStream(absolute, { start, end }),
      start,
      end,
      size: fileSize,
    };
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

/** The first `length` bytes of a file, without reading the rest of it. */
async function readHead(absolute: string, length: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let read = 0;
  for await (const chunk of createReadStream(absolute, { start: 0, end: length - 1 })) {
    chunks.push(chunk as Buffer);
    read += (chunk as Buffer).length;
    if (read >= length) break;
  }
  return Buffer.concat(chunks);
}
