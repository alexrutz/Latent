import type { ParamField, ParamRole } from './paramTypes.js';
import { usesPointLine } from './randomParams.js';

/**
 * How the fields of a form fall into rows.
 *
 * The generate screen draws this, and the form editor draws a preview of it
 * beside the controls that change it. Those two have to agree about *everything*
 * — which fields sit side by side, which take a whole row, where a run of chips
 * breaks — because the entire purpose of the preview is to answer "what will
 * this look like on the phone", and a preview that answers it almost correctly
 * is worse than none.
 *
 * So the arrangement is one function rather than a rule written out twice.
 */

/**
 * Roles that get a control of their own rather than a chip in the grid.
 *
 * A prompt is a text area, an image is a preview with buttons under it, a seed
 * has a dice and a padlock. None of them fit in half a row beside a number, so
 * none of them are laid out as one.
 */
export const DEDICATED_ROLES = new Set<ParamRole>([
  'prompt',
  'negative_prompt',
  'image_input',
  // The folder browser draws the same control as an uploaded picture — an
  // 80px preview with two buttons beside it — so it needs the same whole row.
  'folder_image',
  'seed',
  'lora_text',
]);

/** Whether a field is drawn as a chip, half a row wide, in the shared grid. */
export function isChip(field: ParamField): boolean {
  return !DEDICATED_ROLES.has(field.role) && !usesPointLine(field);
}

export interface FormRun {
  /** `chips` is a grid of half-width controls; `block` is one field, full width. */
  kind: 'chips' | 'block';
  fields: ParamField[];
}

/**
 * The visible fields of one group, gathered into rows.
 *
 * Only *adjacent* chips are merged, so the order somebody dragged them into is
 * preserved exactly — moving a prompt into the middle of four numbers splits
 * them into two grids rather than quietly floating the prompt to the end.
 */
export function planFormRuns(fields: ParamField[]): FormRun[] {
  const runs: FormRun[] = [];
  for (const field of fields) {
    const chip = isChip(field);
    const last = runs[runs.length - 1];
    if (chip && last?.kind === 'chips') last.fields.push(field);
    else runs.push({ kind: chip ? 'chips' : 'block', fields: [field] });
  }
  return runs;
}

/**
 * Whether a field's width is somebody's to choose.
 *
 * A field with a control of its own always takes the whole row, so offering it
 * a half/full switch would be a control that does nothing — which is worse than
 * an absent one, because it invites the belief that it was tried and ignored.
 */
export function isSizeable(field: ParamField): boolean {
  if (DEDICATED_ROLES.has(field.role)) return false;
  return !['textarea', 'text', 'image', 'folderImage'].includes(field.control);
}
