/**
 * A long list of pictures, cut into the days that made them.
 *
 * After a few months of use the gallery is thousands of tiles and the
 * favourites are hundreds, and both are one unbroken column. Scrolling is the
 * only way through, which makes "the ones from the weekend" a minute of
 * flicking past everything since.
 *
 * Days are the division that already exists in the work: a session is an
 * evening, and the pictures from one are the ones you were thinking about
 * together. So the list is cut on the day boundary, today and yesterday are
 * left open because that is what you came back for, and everything older is
 * folded away — but folded with a *sample* showing rather than shut blank, so
 * a closed day is still something you can recognise at a glance instead of a
 * date you have to open to identify.
 *
 * Shared between the gallery and the favourites because they are the same
 * problem with different rows in it. Neither knows what the other's item looks
 * like, so everything here works off two accessors — when it happened, and
 * whether it was rated — and never off the item itself.
 */

/** The local day something belongs to, as a key that compares and sorts. */
export function dayKeyOf(at: number): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

/**
 * How that day reads.
 *
 * Today and yesterday by name, because those are the two you look for most and
 * a date tells you less than the word does. The year only when it is not this
 * one — otherwise every heading carries four digits nobody needed.
 */
export function dayLabelOf(at: number, now = Date.now()): string {
  const date = new Date(at);
  const today = new Date(now);
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);

  if (dayKeyOf(at) === dayKeyOf(today.getTime())) return 'Today';
  if (dayKeyOf(at) === dayKeyOf(yesterday.getTime())) return 'Yesterday';

  return date.toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(date.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }),
  });
}

/**
 * Whether a day is one of the two that stay open.
 *
 * Today and yesterday, and no further. "This week" was the obvious alternative
 * and it is wrong on a Monday, where it means six days of open grid before the
 * first fold — and right for the same reason on a Friday, which is what makes
 * it a rule you cannot predict. Two days is two days whatever the date is.
 */
export function isRecentDay(key: string, now = Date.now()): boolean {
  const today = new Date(now);
  const yesterday = new Date(now);
  yesterday.setDate(today.getDate() - 1);
  return key === dayKeyOf(today.getTime()) || key === dayKeyOf(yesterday.getTime());
}

/** One day's worth of whatever was passed in, in the order it arrived. */
export interface DaySection<T> {
  key: string;
  label: string;
  items: T[];
}

/**
 * Consecutive runs of one day, as a walk rather than a sort.
 *
 * The list already arrives ordered, so this only has to notice where the day
 * changes — which also keeps it correct when the order is oldest-first, where
 * grouping by a sorted key would silently reverse the sections.
 */
export function groupByDay<T>(
  items: T[],
  atOf: (item: T) => number,
  now = Date.now(),
): DaySection<T>[] {
  const out: DaySection<T>[] = [];
  for (const item of items) {
    const at = atOf(item);
    const key = dayKeyOf(at);
    const last = out[out.length - 1];
    if (last?.key === key) last.items.push(item);
    else out.push({ key, label: dayLabelOf(at, now), items: [item] });
  }
  return out;
}

/** How many items a folded day skips between the ones it shows. */
export const DEFAULT_GALLERY_PREVIEW_EVERY = 20;
export const DEFAULT_FAVORITE_PREVIEW_EVERY = 5;

/**
 * What a folded day shows: a thinning of it, plus everything you rated.
 *
 * Two rules, and the second is the one that matters. Every n-th item is a fair
 * sample of an evening — it catches the subject changing, which is what you are
 * skimming for — but it is blind to whether anything in the gap was any good,
 * and a sample that can leave out the one five-star picture of the week is a
 * sample nobody will trust enough to leave folded. So anything rated is always
 * in, at whatever position it holds, and the thinning fills in around it.
 *
 * Order is preserved and nothing appears twice: a rated item that also lands on
 * the stride is one tile, not two.
 *
 * `every` of 1 or less means every item, which is the honest reading of "show
 * me one in every one" and keeps a misconfigured setting from emptying the
 * preview instead of filling it.
 */
export function previewOf<T>(items: T[], every: number, rated: (item: T) => boolean): T[] {
  const stride = Number.isFinite(every) && every > 1 ? Math.floor(every) : 1;
  if (stride <= 1) return [...items];
  return items.filter((item, at) => at % stride === 0 || rated(item));
}

/**
 * The stride as a number a picker can offer, given whatever was stored.
 *
 * A setting that arrives as a string, a nothing, or a number somebody typed
 * badly must not turn a folded day blank — which is what a stride of zero or a
 * negative one would do to the modulo above.
 */
export function previewEveryOf(value: unknown, fallback: number): number {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(1, Math.min(500, Math.floor(number)));
}
