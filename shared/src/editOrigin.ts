import { bypassFieldId } from './bypass.js';
import type { ParamSchema, ParamValues } from './paramTypes.js';

/**
 * What an edit was made from.
 *
 * An edit workflow takes a picture and gives back a changed one, and the only
 * interesting question about the result is what changed — which needs both
 * pictures side by side, or better, one wiped across the other. The result is
 * in the gallery; the picture it started from is a filename in ComfyUI's input
 * directory that nothing was keeping hold of.
 *
 * Which input is *the* origin is not something a graph says. A serious edit
 * workflow often takes two: the picture being edited, and a second one it is
 * being made to look like, or take a pose from. Both are `LoadImage` nodes
 * feeding the same sampler, and from the graph they are indistinguishable.
 *
 * So the node's title says. `Input Image [Reference]` is the picture the edit
 * started from — the one worth comparing against — and `Input Image [Context]`
 * is the other kind. That convention is the whole of the detection: a tag in
 * brackets, matched without case, on a node that feeds a picture in.
 */

/** The two things an input picture can be to an edit. */
export type EditOriginRole = 'reference' | 'context';

export interface EditOrigin {
  role: EditOriginRole;
  /** The field it came from — `${nodeId}.${inputName}`. */
  fieldId: string;
  /** The node's title, as the workflow spells it. */
  nodeTitle: string;
  /** The name ComfyUI's input directory knows the file by. */
  filename: string;
  /** The directory under it, or `''`. */
  subfolder: string;
  /**
   * Which of ComfyUI's folders it is in. Left out for its input folder, which
   * is where every origin was before comfyllama's folder picture could point
   * at the output folder — so a record written then still reads correctly.
   */
  type?: 'output' | 'temp';
}

/** The folders of ComfyUI's own that its `/view` serves, and so a comparison can show. */
const COMFY_FOLDERS = new Set(['input', 'output', 'temp']);

/**
 * A comfyllama folder picture's value, as ComfyUI's `/view` addresses it.
 *
 * It holds `<root>/<path>` — `input/latent_x.png` for an upload,
 * `output/monday/render.png` for an earlier result. Only ComfyUI's own three
 * folders can be fetched whole; an extra folder the environment names is
 * browsable but has nothing to serve it full size, so it is no origin.
 */
export function splitFolderImage(
  value: string,
): { filename: string; subfolder: string; type?: 'output' | 'temp' } | null {
  const cut = value.indexOf('/');
  if (cut < 0) return null;
  const root = value.slice(0, cut);
  if (!COMFY_FOLDERS.has(root)) return null;
  const parts = splitInputImage(value.slice(cut + 1));
  if (!parts) return null;
  return root === 'input' ? parts : { ...parts, type: root as 'output' | 'temp' };
}

/**
 * The tag in a node's title, if it carries one.
 *
 * The last bracketed group rather than the first, so a title that already has
 * brackets for something else — `LoadImage (batch) [Reference]` — is still read
 * by its tag. Returns lower case, because the convention is about the word and
 * not about how it was typed.
 */
export function originTagOf(nodeTitle: string): string | null {
  const groups = [...nodeTitle.matchAll(/\[([^\]]*)\]/g)];
  const last = groups[groups.length - 1];
  const tag = last?.[1]?.trim().toLowerCase();
  return tag ? tag : null;
}

function roleOf(nodeTitle: string): EditOriginRole | null {
  const tag = originTagOf(nodeTitle);
  if (tag === 'reference') return 'reference';
  if (tag === 'context') return 'context';
  return null;
}

/**
 * A `LoadImage` value split the way `/api/view` wants it.
 *
 * Two shapes reach us. The picker writes `sub/name.png`, because that is how
 * ComfyUI addresses an upload in a subfolder. A value copied out of ComfyUI's
 * own dropdown carries a trailing annotation — `name.png [input]` — naming the
 * directory it lives in, and that has to come off or the filename does not
 * exist.
 */
export function splitInputImage(value: string): { filename: string; subfolder: string } | null {
  const trimmed = value
    .trim()
    .replace(/\s*\[(input|output|temp)\]$/i, '')
    .trim();
  if (!trimmed) return null;
  // A path that climbs out of the input directory is not one we will ask for.
  if (trimmed.includes('..') || trimmed.startsWith('/') || trimmed.includes('\\')) return null;

  const cut = trimmed.lastIndexOf('/');
  const filename = cut >= 0 ? trimmed.slice(cut + 1) : trimmed;
  const subfolder = cut >= 0 ? trimmed.slice(0, cut) : '';
  return filename ? { filename, subfolder } : null;
}

/**
 * The input pictures this run was given, in the order they matter.
 *
 * Reference first, so a caller that wants "the origin" can take the first one
 * and be right. Untagged image inputs are left out entirely: an edit workflow
 * that has not been labelled has not said which of its pictures is the origin,
 * and guessing would put a pose reference under a portrait and call it the
 * before.
 *
 * Falls back to a field's default like `buildParamSummary` does — a value
 * nobody touched is still what the job ran with.
 */
export function findEditOrigins(schema: ParamSchema, values: ParamValues): EditOrigin[] {
  const origins: EditOrigin[] = [];

  for (const field of schema.fields) {
    // Both kinds of picture slot: ComfyUI's upload, and comfyllama's folder
    // picture — which holds an upload too, as `input/<name>`, and was missed.
    if (field.role !== 'image_input' && field.role !== 'folder_image') continue;

    const role = roleOf(field.nodeTitle);
    if (!role) continue;
    // Left out of the run, so not what the result was made from.
    if (values[bypassFieldId(field.nodeId)] === true) continue;

    const raw = field.id in values ? values[field.id] : field.defaultValue;
    if (typeof raw !== 'string') continue;
    const parts: { filename: string; subfolder: string; type?: 'output' | 'temp' } | null =
      field.role === 'folder_image' ? splitFolderImage(raw) : splitInputImage(raw);
    if (!parts) continue;

    origins.push({
      role,
      fieldId: field.id,
      nodeTitle: field.nodeTitle,
      filename: parts.filename,
      subfolder: parts.subfolder,
      ...(parts.type ? { type: parts.type } : {}),
    });
  }

  return origins.sort((a, b) => rank(a.role) - rank(b.role));
}

function rank(role: EditOriginRole): number {
  return role === 'reference' ? 0 : 1;
}

/**
 * The one picture a result should be compared against.
 *
 * `null` for everything that is not an edit — which is most of what a gallery
 * holds, and the reason this is a lookup rather than an assumption.
 */
export function referenceOrigin(origins: EditOrigin[]): EditOrigin | null {
  return origins.find((origin) => origin.role === 'reference') ?? null;
}
