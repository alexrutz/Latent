import { randomUUID } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';

import type { ImportCandidate, ImportResult, ImportScanResult } from '@latent/shared';

import type { Archive } from './archive.js';
import type { Store } from './db.js';
import { readImageSize } from './images/png.js';

/**
 * Pulls existing images out of a ComfyUI output folder.
 *
 * Everything ComfyUI made before Latent existed is sitting in a directory doing
 * nothing. This walks that directory, and anything you rate gets copied into the
 * same encrypted archive as freshly generated work — one library, one rating
 * system, whether the image is five minutes or five months old.
 *
 * The folder is read from the machine running Latent. If ComfyUI is a remote
 * vast.ai instance, its outputs are not on this filesystem; point this at a
 * local ComfyUI, a network mount, or a synced folder.
 */

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
/** Guards against a pathological tree, and against symlink loops. */
const MAX_DEPTH = 8;
const MAX_FILES = 2000;

export class Importer {
  constructor(
    private readonly store: Store,
    private readonly archive: Archive,
  ) {}

  private root(): string | null {
    const configured = this.store.getSettings().importRoot;
    return configured ? resolve(configured) : null;
  }

  /**
   * Turn a caller-supplied relative path into an absolute one, refusing
   * anything that escapes the configured root. This is the only thing standing
   * between an authenticated request and reading arbitrary files, so it is
   * deliberately strict.
   */
  private safeJoin(root: string, relativePath: string): string | null {
    const absolute = resolve(root, relativePath);
    const within = relative(root, absolute);
    if (within === '' || within.startsWith('..') || within.startsWith(sep)) return null;
    return absolute;
  }

  async scan(): Promise<ImportScanResult> {
    const root = this.root();
    if (!root) {
      return {
        root: '',
        ok: false,
        message: 'No import folder is configured yet.',
        files: [],
        truncated: false,
      };
    }

    try {
      const info = await stat(root);
      if (!info.isDirectory()) {
        return { root, ok: false, message: 'That path is not a folder.', files: [], truncated: false };
      }
    } catch {
      return {
        root,
        ok: false,
        message: 'That folder does not exist, or Latent cannot read it.',
        files: [],
        truncated: false,
      };
    }

    const alreadyImported = this.store.importedPaths();
    const files: ImportCandidate[] = [];
    let truncated = false;

    const walk = async (directory: string, depth: number): Promise<void> => {
      if (depth > MAX_DEPTH || files.length >= MAX_FILES) return;

      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch {
        return; // Unreadable subdirectory: skip it rather than failing the scan.
      }

      for (const entry of entries) {
        if (files.length >= MAX_FILES) {
          truncated = true;
          return;
        }
        if (entry.name.startsWith('.')) continue;

        const absolute = join(directory, entry.name);
        if (entry.isDirectory()) {
          await walk(absolute, depth + 1);
          continue;
        }
        // Deliberately not following symlinks — they are the easy way out of
        // the configured root.
        if (!entry.isFile()) continue;
        if (!IMAGE_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;

        try {
          const info = await stat(absolute);
          const relativePath = relative(root, absolute).split(sep).join('/');

          // Read only the header for dimensions; these files can be large and
          // there can be thousands of them.
          const size = await readImageHeader(absolute);

          files.push({
            path: relativePath,
            name: entry.name,
            bytes: info.size,
            modifiedAt: info.mtimeMs,
            width: size?.width ?? null,
            height: size?.height ?? null,
            imported: alreadyImported.has(relativePath),
          });
        } catch {
          // A file that vanished mid-scan is not worth failing over.
        }
      }
    };

    await walk(root, 0);
    files.sort((a, b) => b.modifiedAt - a.modifiedAt);

    return { root, ok: true, files, truncated };
  }

  /**
   * Copy the chosen files into the encrypted archive as rated gallery entries.
   */
  async importFiles(paths: string[], rating = 0): Promise<ImportResult> {
    const root = this.root();
    const result: ImportResult = { imported: 0, skipped: 0, failed: [] };
    if (!root) {
      result.failed.push({ path: '', reason: 'No import folder is configured.' });
      return result;
    }

    const alreadyImported = this.store.importedPaths();

    for (const path of paths) {
      if (alreadyImported.has(path)) {
        result.skipped += 1;
        continue;
      }

      const absolute = this.safeJoin(root, path);
      if (!absolute) {
        result.failed.push({ path, reason: 'Path is outside the import folder' });
        continue;
      }

      try {
        const info = await stat(absolute);
        if (!info.isFile()) {
          result.failed.push({ path, reason: 'Not a file' });
          continue;
        }

        const data = await readFile(absolute);
        const segments = path.split('/');
        const filename = segments.pop() as string;
        const subfolder = segments.join('/');

        const imageId = this.store.insertImportedImage({
          generationId: randomUUID(),
          promptId: `import:${path}`,
          // Nothing better to call it than where it came from — there are no
          // prompt metadata to recover from an arbitrary file.
          title: subfolder ? `${subfolder}/${filename}` : filename,
          filename,
          subfolder,
          modifiedAt: Math.round(info.mtimeMs),
        });

        await this.archive.storeBytes(imageId, filename, data);
        if (rating > 0) this.store.setImageRating(imageId, rating);

        result.imported += 1;
      } catch (error) {
        result.failed.push({
          path,
          reason: error instanceof Error ? error.message : 'Could not read that file',
        });
      }
    }

    return result;
  }
}

/** Read just enough of a file to learn its pixel size. */
async function readImageHeader(path: string) {
  const handle = await import('node:fs/promises').then((fs) => fs.open(path, 'r'));
  try {
    // 64 KB covers a PNG's IHDR and a JPEG's frame header comfortably.
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return readImageSize(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}
