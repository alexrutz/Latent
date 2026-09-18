import type { ParamValues } from './paramTypes.js';

/**
 * A list of pictures in one image slot, worked through one render at a time.
 *
 * The thing people actually want from an "img2img batch" is not a mode. It is
 * this: the twelve photographs you are about to run the same graph over, ticked
 * once, and then Generate pressed twelve times without going back to the picker
 * in between. A separate batch *mode* would mean two ways to fill an image slot,
 * two things to explain, and a switch to remember to turn off.
 *
 * So there is no mode. The slot always holds a list, and picking one picture is
 * a list of one. After every run the slot advances to the next entry and wraps
 * at the end — which for a list of one is the same picture again, exactly as
 * before this existed. Nothing about the ordinary case changes, and the
 * extraordinary one is a second tick.
 *
 * The *position* is not stored anywhere. Where you are in the list is simply
 * which picture the slot is holding, which means the state cannot drift out of
 * step with what is on screen, a reload resumes where it left off, and picking
 * something by hand mid-way through is not a thing anybody has to handle.
 */

/**
 * The entry after this one, wrapping at the end.
 *
 * Three cases and all three are ordinary:
 *
 * - An empty list means no batch, so the slot keeps whatever it has. Advancing
 *   to nothing would silently empty an image field between runs.
 * - A value that is not in the list starts at the beginning. That is somebody
 *   having picked a picture by hand while a list was set, and beginning again
 *   is the only answer that does not depend on a position nobody can see.
 * - Otherwise, the next one — which for a single-entry list is itself.
 */
export function advanceBatch(list: string[], current: string | null): string | null {
  if (list.length === 0) return current;
  const at = current === null ? -1 : list.indexOf(current);
  if (at < 0) return list[0] ?? current;
  return list[(at + 1) % list.length] ?? current;
}

/** The batch list held against each image field, by field id. */
export type InputBatches = Record<string, string[]>;

/**
 * Every batched slot moved on by one.
 *
 * All of them together, because a workflow can take two pictures — a subject
 * and a style reference, a frame and a mask — and advancing one while leaving
 * the other would pair them up differently on every pass. Slots without a list,
 * and slots whose list has one entry, come back holding exactly what they held.
 */
export function advanceBatches(values: ParamValues, batches: InputBatches): ParamValues {
  let changed = false;
  const next: ParamValues = { ...values };

  for (const [fieldId, list] of Object.entries(batches)) {
    if (!Array.isArray(list) || list.length === 0) continue;
    const current = typeof values[fieldId] === 'string' ? (values[fieldId] as string) : null;
    const advanced = advanceBatch(list, current);
    if (advanced !== null && advanced !== current) {
      next[fieldId] = advanced;
      changed = true;
    }
  }

  return changed ? next : values;
}

/**
 * How many runs it takes to get through every list once.
 *
 * The longest list, not the total and not the product: two slots of four are
 * four pairings, not eight runs and certainly not sixteen. Used to say what
 * "Generate" is about to do, which is the one place the count is worth stating
 * — pressing it twelve times is a decision, and a decision wants a number.
 */
export function batchLength(batches: InputBatches): number {
  return Object.values(batches).reduce(
    (longest, list) => Math.max(longest, Array.isArray(list) ? list.length : 0),
    0,
  );
}

/**
 * Where in the list the slot currently is, counting from one.
 *
 * `0` when the value is not in the list at all, which the caller shows as
 * nothing rather than as a position — a picture chosen by hand is not at a
 * place in a list it is not in.
 */
export function batchPosition(list: string[], current: string | null): number {
  if (current === null) return 0;
  return list.indexOf(current) + 1;
}

/** The lists with the empty ones dropped, so an emptied slot stops being one. */
export function pruneBatches(batches: InputBatches): InputBatches {
  return Object.fromEntries(
    Object.entries(batches).filter(([, list]) => Array.isArray(list) && list.length > 0),
  );
}
