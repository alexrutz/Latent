import { resolve } from 'node:path';

import type { AppSettings } from '@latent/shared';

/**
 * Where things live under a ComfyUI installation.
 *
 * A stock ComfyUI keeps its inputs, its outputs and its saved workflows in
 * fixed places under one directory, so asking the user for each of them
 * separately was asking the same question three times. One root is entered and
 * everything else follows from it.
 *
 * The explicit per-folder settings are kept as overrides rather than deleted:
 * an install that redirects its output to a network share, or a database
 * written before the root existed, still works and still wins.
 */

/** `<root>/output` — where ComfyUI writes finished pictures. */
export function outputRoot(settings: AppSettings): string | null {
  if (settings.importRoot) return resolve(settings.importRoot);
  return settings.comfyRoot ? resolve(settings.comfyRoot, 'output') : null;
}

/** `<root>/input` — the folder ComfyUI's own image loaders read from. */
export function inputRoot(settings: AppSettings): string | null {
  if (settings.inputRoot) return resolve(settings.inputRoot);
  return settings.comfyRoot ? resolve(settings.comfyRoot, 'input') : null;
}

/**
 * `<root>/user/default/workflows` — where the editor saves workflows.
 *
 * "default" is the user directory of an install with no multi-user mode turned
 * on, which is every standard install.
 */
export function workflowRoot(settings: AppSettings): string | null {
  return settings.comfyRoot ? resolve(settings.comfyRoot, 'user', 'default', 'workflows') : null;
}
