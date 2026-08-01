import { randomUUID } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';

import { buildParamSummary, matchPrompt, parsePromptMetadata } from '@latent/shared';
import type {
  ImportBrowseResult,
  ImportCandidate,
  ImportFolder,
  ImportResult,
  ImportScanResult,
  ParamSummaryItem,
  ParamValues,
  WorkflowCandidate,
} from '@latent/shared';

import type { Archive } from './archive.js';
import type { Store } from './db.js';
import { readImageSize, readPngText } from './images/png.js';

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
/** How many files one folder listing returns before it says "and more". */
const BROWSE_PAGE = 300;
/** Ceiling on a single folder import, so one tap cannot run for an hour. */
const MAX_IMPORT = 1000;

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

        const recovered = this.recoverSettings(data);

        const imageId = this.store.insertImportedImage({
          generationId: randomUUID(),
          promptId: `import:${path}`,
          // The prompt when the image carried one, otherwise where it came
          // from — a filename is a poor title but it is better than nothing.
          title: recovered?.title || (subfolder ? `${subfolder}/${filename}` : filename),
          filename,
          subfolder,
          modifiedAt: Math.round(info.mtimeMs),
          workflowId: recovered?.workflowId ?? null,
          workflowName: recovered?.workflowName,
          values: recovered?.values,
          params: recovered?.params,
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

  /**
   * Everything one folder holds, one level at a time.
   *
   * A ComfyUI output directory is routinely tens of thousands of files across
   * dozens of dated folders. Flattening that into one list — which is what the
   * original scan did — produces something nobody can find anything in, and
   * makes the server read the whole tree to answer a question about one corner
   * of it.
   */
  async browse(relativePath = ''): Promise<ImportBrowseResult> {
    const root = this.root();
    const empty = { folders: [], files: [], truncated: false, path: '', parent: null };
    if (!root) {
      return { root: '', ok: false, message: 'No import folder is configured yet.', ...empty };
    }

    const here = relativePath ? this.safeJoin(root, relativePath) : root;
    if (!here) {
      return { root, ok: false, message: 'That folder is outside the import root.', ...empty };
    }

    let entries;
    try {
      entries = await readdir(here, { withFileTypes: true });
    } catch {
      return {
        root,
        ok: false,
        message: 'That folder does not exist, or Latent cannot read it.',
        ...empty,
      };
    }

    const alreadyImported = this.store.importedPaths();
    const folders: ImportFolder[] = [];
    const files: ImportCandidate[] = [];
    let truncated = false;

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const absolute = join(here, entry.name);
      const childPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        folders.push(await this.summariseFolder(absolute, childPath, alreadyImported));
        continue;
      }
      if (!entry.isFile()) continue;
      if (!IMAGE_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
      if (files.length >= BROWSE_PAGE) {
        truncated = true;
        continue;
      }

      try {
        const info = await stat(absolute);
        files.push({
          path: childPath,
          name: entry.name,
          bytes: info.size,
          modifiedAt: info.mtimeMs,
          // Dimensions are read for the files on screen only — doing it for a
          // whole tree is what made the old scan slow.
          width: null,
          height: null,
          imported: alreadyImported.has(childPath),
        });
      } catch {
        // Vanished mid-listing; not worth failing the whole folder.
      }
    }

    folders.sort((a, b) => b.name.localeCompare(a.name));
    files.sort((a, b) => b.modifiedAt - a.modifiedAt);

    const parent = relativePath
      ? relativePath.split('/').slice(0, -1).join('/')
      : null;

    return { root, ok: true, path: relativePath, parent, folders, files, truncated };
  }

  /** Image and subfolder counts for a folder, without descending into it. */
  private async summariseFolder(
    absolute: string,
    relativePath: string,
    alreadyImported: Set<string>,
  ): Promise<ImportFolder> {
    let images = 0;
    let imported = 0;
    let folders = 0;

    try {
      for (const entry of await readdir(absolute, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        if (entry.isDirectory()) {
          folders += 1;
          continue;
        }
        if (!IMAGE_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
        images += 1;
        if (alreadyImported.has(`${relativePath}/${entry.name}`)) imported += 1;
      }
    } catch {
      // Unreadable: reported as empty rather than hidden, so it is visibly there.
    }

    return { path: relativePath, name: relativePath.split('/').pop() ?? relativePath, images, imported, folders };
  }

  /** Every image in a folder, optionally including its subfolders. */
  async listFolder(relativePath: string, recursive: boolean): Promise<string[]> {
    const root = this.root();
    if (!root) return [];
    const start = relativePath ? this.safeJoin(root, relativePath) : root;
    if (!start) return [];

    const found: string[] = [];
    const walk = async (directory: string, prefix: string, depth: number): Promise<void> => {
      if (found.length >= MAX_IMPORT || depth > MAX_DEPTH) return;
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (found.length >= MAX_IMPORT) return;
        if (entry.name.startsWith('.')) continue;
        const childPath = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (recursive) await walk(join(directory, entry.name), childPath, depth + 1);
          continue;
        }
        if (!entry.isFile()) continue;
        if (IMAGE_EXTENSIONS.has(extname(entry.name).toLowerCase())) found.push(childPath);
      }
    };

    await walk(start, relativePath, 0);
    return found;
  }

  /**
   * Recover the settings ComfyUI wrote into the image.
   *
   * Every PNG it saves carries the API-format graph that produced it. Matching
   * that against the workflows already imported here is what turns a file on
   * disk into something you can re-run — the alternative is looking at a
   * picture you like and having no way back to it.
   */
  private recoverSettings(data: Buffer): {
    workflowId: string;
    workflowName: string;
    values: ParamValues;
    params: ParamSummaryItem[];
    title: string;
  } | null {
    const prompt = parsePromptMetadata(readPngText(data));
    if (!prompt) return null;

    const candidates: WorkflowCandidate[] = [];
    for (const summary of this.store.listWorkflows()) {
      const detail = this.store.getWorkflow(summary.id);
      if (detail) {
        candidates.push({
          id: detail.id,
          name: detail.name,
          graph: detail.graph,
          schema: detail.schema,
        });
      }
    }

    const match = matchPrompt(prompt, candidates);
    if (!match) return null;

    const workflow = this.store.getWorkflow(match.workflowId);
    if (!workflow) return null;

    const promptField = workflow.schema.fields.find((field) => field.role === 'prompt');
    const title = promptField ? String(match.values[promptField.id] ?? '').trim() : '';

    return {
      workflowId: match.workflowId,
      workflowName: match.workflowName,
      values: match.values,
      params: buildParamSummary(workflow.schema, match.values),
      title: title.length > 140 ? `${title.slice(0, 139)}…` : title,
    };
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
