import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import type { InputImage, InputScanResult } from '@latent/shared';

import { inputRoot } from './comfyPaths.js';
import type { Store } from './db.js';
import { makeThumbnail, readImageSizeOfFile } from './images/png.js';

/**
 * A folder of pictures to feed *into* workflows.
 *
 * The mirror image of the output importer. That one pulls finished work in to be
 * rated and kept; this one offers reference photos, sketches and masks to
 * img2img and controlnet graphs, so the input to a render can be something
 * already sitting on the machine rather than only what is on the phone.
 *
 * Read-only by design: nothing here writes to the folder or the database. The
 * only outward action is copying a chosen file into ComfyUI's input directory,
 * and that happens through the normal upload path.
 */

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const MAX_DEPTH = 8;
const MAX_FILES = 2000;
/** Longest side of a picker thumbnail. Enough for a 3-up grid at 3x. */
const THUMBNAIL_SIZE = 256;

export class InputLibrary {
  constructor(private readonly store: Store) {}

  private root(): string | null {
    return inputRoot(this.store.getSettings());
  }

  /**
   * Turn a caller-supplied relative path into an absolute one, refusing anything
   * that escapes the configured root.
   *
   * This is the only thing between an authenticated request and reading arbitrary
   * files off the host, so it is deliberately strict — and deliberately identical
   * in shape to the importer's guard rather than cleverer than it.
   */
  resolvePath(relativePath: string): string | null {
    const root = this.root();
    if (!root) return null;

    const absolute = resolve(root, relativePath);
    return inside(root, absolute) ? absolute : null;
  }

  async scan(): Promise<InputScanResult> {
    const root = this.root();
    if (!root) {
      return {
        root: '',
        ok: false,
        message: 'No input folder is configured yet.',
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

    const files: InputImage[] = [];
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

        const absolute = join(directory, entry.name);
        if (entry.isDirectory()) {
          await walk(absolute, depth + 1);
          continue;
        }
        // Not following symlinks — they are the easy way out of the root.
        if (!entry.isFile()) continue;
        if (!IMAGE_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;

        try {
          const info = await stat(absolute);
          const size = await readImageSizeOfFile(absolute);
          files.push({
            path: relative(root, absolute).split(sep).join('/'),
            name: entry.name,
            bytes: info.size,
            modifiedAt: info.mtimeMs,
            width: size?.width ?? null,
            height: size?.height ?? null,
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

  /** Raw bytes of one file, for editing on the device. */
  async read(relativePath: string): Promise<{ data: Buffer; name: string } | null> {
    const absolute = this.resolvePath(relativePath);
    if (!absolute) return null;

    try {
      /*
       * Where the file really is, not where its name says. A link inside the
       * folder to `/etc/passwd`, or to a document on another drive, passes
       * the check on the name and then reads whatever it points at.
       */
      const [real, realRoot] = await Promise.all([realpath(absolute), realpath(this.root()!)]);
      if (!inside(realRoot, real)) return null;

      const info = await stat(absolute);
      if (!info.isFile()) return null;
      return { data: await readFile(absolute), name: relativePath.split('/').pop() ?? 'image' };
    } catch {
      return null;
    }
  }

  /**
   * A small version for the picker grid.
   *
   * Generated here rather than shipping the original: a folder of 12 MP photos
   * would otherwise be tens of megabytes to browse on a phone. Falls back to the
   * original when it cannot be resized — a JPEG, or something already small.
   */
  async thumbnail(relativePath: string): Promise<{ data: Buffer; png: boolean } | null> {
    const file = await this.read(relativePath);
    if (!file) return null;

    const generated = makeThumbnail(file.data, THUMBNAIL_SIZE);
    if (generated && generated.data.length < file.data.length) {
      return { data: generated.data, png: true };
    }
    return { data: file.data, png: false };
  }
}


/**
 * Whether `target` is somewhere under `root`, and not `root` itself.
 *
 * `isAbsolute` rather than a leading separator: on Windows, a path on another
 * drive comes back from `relative` as `D:\…`, which starts with no separator
 * and so passed. And `..` only as a whole segment, so a file called `..notes`
 * is not mistaken for a step out.
 */
function inside(root: string, target: string): boolean {
  const within = relative(root, target);
  if (within === '' || isAbsolute(within)) return false;
  return within !== '..' && !within.startsWith(`..${sep}`);
}
