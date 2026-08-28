import type { TasteProfile, WanderDraw } from './apiTypes.js';

/**
 * How many notes a wandering round actually gets, under the rules in force.
 *
 * Two questions that used to be answered in two places. The server drew the
 * notes (`drawTaste`) and the settings sheet told you how many a round could
 * reach, and the second was a hand-written re-derivation of the first — so a
 * cap changed on one side and not the other would show you a number the draw
 * did not agree with. The formula lives here now and both ask it.
 */

/**
 * The most notes these rules can produce: every heading in play, capped.
 *
 * Not "how many notes you have". A heading capped at one contributes one
 * however many are filed under it, and a heading switched out of wandering
 * contributes none — which is exactly why "as many as the rules allow" is a
 * meaningful number rather than a synonym for the size of the profile.
 */
export function wanderReach(profile: TasteProfile, draw: WanderDraw): number {
  const categories = new Map(profile.categories.map((category) => [category.id, category]));

  const cap = (categoryId: string | null): number => {
    const rule = (categoryId ? draw.categories[categoryId] : undefined) ?? {
      role: 'draw' as const,
      max: 0,
    };
    if (rule.role === 'off') return 0;
    const own = rule.max || draw.perCategory;
    return own > 0 ? own : Number.POSITIVE_INFINITY;
  };

  const available = new Map<string | null, number>();
  for (const entry of profile.entries) {
    if (!entry.active) continue;
    const category = entry.categoryId ? categories.get(entry.categoryId) : undefined;
    if (entry.categoryId && (!category || !category.active)) continue;
    if (entry.text.trim() === '') continue;
    if (entry.always && draw.pinned === 'off') continue;
    const key = category?.id ?? null;
    if (key === null && draw.loose === 'off') continue;
    available.set(key, (available.get(key) ?? 0) + 1);
  }

  let reach = 0;
  for (const [key, count] of available) reach += Math.min(count, cap(key));
  return reach;
}

/**
 * The count a round asks for — a number you set, or the rules' own answer.
 *
 * `attributes` is normally a ceiling: three notes a picture, whatever the
 * profile holds. **Zero means there is no ceiling** — draw as many as the rules
 * reach, which with the default cap of one per heading is one note from each
 * heading, every round. That is the default, and it is the shape the mode
 * wants: the headings are the things you curated, so a picture that takes one
 * of each is a picture made of your list rather than of a random corner of it.
 *
 * A sentinel rather than a second setting beside it. "How many" and "one from
 * each" are answers to the same question, and two switches that have to agree
 * about it is the arrangement where they eventually do not.
 *
 * `null` for the profile — a locked vault — is zero either way: there is
 * nothing to draw, and the round is told so rather than being given a number
 * it cannot fill.
 */
export function wanderCount(
  profile: TasteProfile | null,
  draw: WanderDraw,
  attributes: number,
): number {
  const asked = Math.max(0, Math.floor(attributes) || 0);
  if (asked > 0) return asked;
  return profile ? wanderReach(profile, draw) : 0;
}
