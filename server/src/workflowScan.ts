import { randomUUID } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join, relative, sep } from 'node:path';

import {
  assertApiWorkflow,
  buildParamSchema,
  defaultValues,
  isUiWorkflow,
  uiToApiWorkflow,
  WorkflowFormatError,
  UiWorkflowError,
} from '@latent/shared';
import type { ApiWorkflow, ObjectInfo, WorkflowScanResult } from '@latent/shared';

import { workflowRoot } from './comfyPaths.js';
import type { Store } from './db.js';
import type { Orchestrator } from './orchestrator.js';
import type { StateFiles } from './statefile.js';

/**
 * Reads every workflow saved in the ComfyUI installation.
 *
 * Importing them one at a time through a file picker was the wrong shape of
 * work: they are already on the machine, in a known folder, and the person who
 * saved them has no reason to export each one again. This walks that folder and
 * imports the lot.
 *
 * What comes out of it is deliberately *not* all switched on. A long-running
 * install holds dozens of workflows, most of them experiments, and a generate
 * screen listing all of them is worse than one listing none. Everything is
 * imported hidden; Settings is where you say which handful you actually use.
 */

const MAX_DEPTH = 6;
const MAX_FILES = 500;

export class WorkflowScanner {
  constructor(
    private readonly store: Store,
    private readonly orchestrator: Orchestrator,
    private readonly stateFiles: StateFiles,
  ) {}

  async scan(): Promise<WorkflowScanResult> {
    const directory = workflowRoot(this.store.getSettings());
    const result: WorkflowScanResult = {
      ok: false,
      directory: directory ?? '',
      imported: 0,
      skipped: 0,
      failed: [],
    };

    if (!directory) {
      result.message = 'No ComfyUI folder is configured yet.';
      return result;
    }

    try {
      const info = await stat(directory);
      if (!info.isDirectory()) {
        result.message = 'That path is not a folder.';
        return result;
      }
    } catch {
      result.message =
        'No workflows folder under that path. A standard install keeps them in user/default/workflows.';
      return result;
    }

    /*
     * Converting the editor format needs `/object_info`: the widget values are
     * a bare positional list, and only ComfyUI knows what order the inputs go
     * in. Without it every editor-format file fails, so say that once here
     * rather than repeating it per file.
     */
    let objectInfo: ObjectInfo = {};
    let haveObjectInfo = true;
    try {
      objectInfo = await this.orchestrator.objectInfo();
    } catch {
      haveObjectInfo = false;
    }

    const files = await collectFiles(directory);
    result.ok = true;

    const prefix = this.store.getSettings().workflowPrefix?.trim() ?? '';

    for (const absolute of files) {
      const relativePath = relative(directory, absolute).split(sep).join('/');

      if (this.store.findWorkflowBySourcePath(absolute)) {
        result.skipped += 1;
        continue;
      }

      /*
       * Only the workflows meant for the phone.
       *
       * An install that has been used accumulates every experiment anybody
       * ever saved, and importing all of them produces a list nobody can find
       * anything in — the reason everything arrives hidden in the first place.
       * A prefix on the file name is a mark you make once in the editor and
       * costs nothing thereafter, and it turns the scan into exactly the
       * handful you meant.
       *
       * Matched on the file's own name rather than the whole relative path, so
       * a folder that happens to start with the prefix does not sweep in
       * everything under it.
       */
      if (!matchesPrefix(relativePath, prefix)) {
        result.skipped += 1;
        continue;
      }

      try {
        const raw = await readFile(absolute, 'utf8');
        const parsed: unknown = JSON.parse(raw);

        let graph: ApiWorkflow;
        if (isUiWorkflow(parsed)) {
          if (!haveObjectInfo) {
            throw new Error('ComfyUI is unreachable, so its editor format cannot be read');
          }
          graph = uiToApiWorkflow(parsed, objectInfo);
        } else {
          graph = assertApiWorkflow(parsed);
        }

        const schema = buildParamSchema(graph, objectInfo);
        // The prefix marks the file on disk; repeating it on every row in the
        // app would waste width that the name itself needs.
        const name = stripPrefix(relativePath.replace(/\.json$/i, ''), prefix);
        const id = randomUUID();

        this.store.insertWorkflow({
          id,
          name,
          graph,
          schema,
          lastValues: defaultValues(schema),
          sourcePath: absolute,
          // Hidden until chosen: see the note at the top of this file.
          visible: false,
        });
        this.stateFiles.adopt(id, name);
        result.imported += 1;
      } catch (error) {
        result.failed.push({ path: relativePath, reason: describe(error) });
      }
    }

    if (result.imported === 0 && result.failed.length === 0 && result.skipped === 0) {
      result.message = 'No workflow files in that folder.';
    } else if (result.imported === 0 && prefix !== '' && result.failed.length === 0) {
      // The commonest way to get nothing back, and the least obvious: the
      // folder is full of workflows and none of them carries the prefix.
      result.message = `Nothing there starts with “${prefix}”. Rename the workflows you want on the phone, or clear the prefix in Settings.`;
    }
    return result;
  }
}

/**
 * Whether a workflow file is one of the marked ones.
 *
 * The check is on the file's own name, not the path: a folder called `API_old`
 * should not quietly sweep in everything inside it. Case-insensitive, because
 * `api_` and `API_` are the same intention typed on two different keyboards.
 */
export function matchesPrefix(relativePath: string, prefix: string): boolean {
  if (prefix === '') return true;
  const leaf = relativePath.split('/').pop() ?? relativePath;
  return leaf.toLowerCase().startsWith(prefix.toLowerCase());
}

/** The name without its marker, folders left intact. */
export function stripPrefix(name: string, prefix: string): string {
  if (prefix === '') return name;
  const cut = name.lastIndexOf('/');
  const folder = cut < 0 ? '' : name.slice(0, cut + 1);
  const leaf = cut < 0 ? name : name.slice(cut + 1);
  if (!leaf.toLowerCase().startsWith(prefix.toLowerCase())) return name;
  // A file called exactly `API_.json` would otherwise become nameless.
  const stripped = leaf.slice(prefix.length).trim();
  return stripped === '' ? name : folder + stripped;
}

function describe(error: unknown): string {
  if (error instanceof UiWorkflowError || error instanceof WorkflowFormatError) return error.message;
  if (error instanceof SyntaxError) return 'Not valid JSON';
  return error instanceof Error ? error.message : 'Could not read that file';
}

async function collectFiles(root: string): Promise<string[]> {
  const found: string[] = [];

  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || found.length >= MAX_FILES) return;

    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return; // An unreadable subfolder is not worth failing the whole scan.
    }

    for (const entry of entries) {
      if (found.length >= MAX_FILES) return;
      if (entry.name.startsWith('.')) continue;

      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (extname(entry.name).toLowerCase() !== '.json') continue;
      found.push(absolute);
    }
  };

  await walk(root, 0);
  found.sort();
  return found;
}
