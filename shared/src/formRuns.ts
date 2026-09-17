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

/**
 * Whether a field is drawn as a chip, half a row wide, in the shared grid.
 *
 * A point line normally takes a whole row — the reason to switch a number to
 * one is that its values are on screen, and that needs the width. But the
 * width switch is *offered* for numeric fields, so an explicit half has to
 * mean something: a switch that cannot change the outcome is worse than an
 * absent one. Asked for half, a point line gets half.
 */
export function isChip(field: ParamField): boolean {
  if (DEDICATED_ROLES.has(field.role)) return false;
  if (usesPointLine(field)) return field.width === 'half';
  return true;
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

/** One node's worth of the Advanced list, with a heading that names it. */
export interface FieldGroup {
  nodeId: string;
  /** What the heading says. See `groupByNode` for how a clash is settled. */
  title: string;
  fields: ParamField[];
}

/**
 * Advanced, cut into the nodes the settings came from.
 *
 * A big workflow puts thirty inputs behind Advanced, and as one flat run of
 * chips they are thirty unrelated words: `denoise`, `end_at_step`, `tile_size`,
 * `strength` — none of which mean anything until you know which node they
 * belong to, and two of which are often the same word on different nodes. The
 * heading is the missing half of the label.
 *
 * The order is the arrangement's own: groups appear in the order their first
 * field does, and the fields inside a group keep the order they were given. So
 * dragging a field in the form editor still moves it, and moving one past the
 * last field of its node moves its whole group — which is the only behaviour
 * that can be explained in a sentence.
 *
 * **Titles are disambiguated, not deduplicated.** Two KSamplers in one graph are
 * two groups with one name, and a heading that cannot tell them apart is worse
 * than no heading — so where a title is used twice, every group carrying it
 * gets its node id appended. Only where it clashes: `#7` on every heading in a
 * graph that has no clashes at all would be noise.
 */
export function groupByNode(fields: ParamField[]): FieldGroup[] {
  const groups: FieldGroup[] = [];
  const byNode = new Map<string, FieldGroup>();

  for (const field of fields) {
    const existing = byNode.get(field.nodeId);
    if (existing) {
      existing.fields.push(field);
      continue;
    }
    const group: FieldGroup = {
      nodeId: field.nodeId,
      title: field.nodeTitle || field.classType || field.nodeId,
      fields: [field],
    };
    byNode.set(field.nodeId, group);
    groups.push(group);
  }

  const seen = new Map<string, number>();
  for (const group of groups) seen.set(group.title, (seen.get(group.title) ?? 0) + 1);
  for (const group of groups) {
    if ((seen.get(group.title) ?? 0) > 1) group.title = `${group.title} #${group.nodeId}`;
  }

  return groups;
}
