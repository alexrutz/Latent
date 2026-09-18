import { useCallback, useEffect, useMemo, useState } from 'react';

import { isRecentDay } from '@latent/shared';

/**
 * Which days are open, and which the rule decided.
 *
 * The rule is `isRecentDay`: today and yesterday open, everything older folded.
 * It is a rule rather than stored state because it is the answer that stays
 * right without anybody maintaining it — a day that was "today" when you folded
 * it is not today tomorrow, and a list of folded days grows by one every day
 * whether or not you touch the app.
 *
 * What *is* stored is disagreement: the days somebody deliberately opened
 * although the rule would have folded them, and the days they folded although
 * it would not. That is a handful of keys rather than one per day of the
 * installation's life, and it means the rule keeps working underneath a
 * decision made once about one particular evening.
 *
 * Kept on the device, like the grid settings next door: which days you have
 * finished looking at is a fact about this screen and this phone, not about the
 * pictures.
 */
export function useDayFolds(storageKey: string): {
  /** Whether a day's grid is shown in full. */
  isOpen: (key: string) => boolean;
  /** Open a shut day, or shut an open one. */
  toggle: (key: string) => void;
} {
  const [overrides, setOverrides] = useState<Record<string, boolean>>(() => load(storageKey));

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(overrides));
    } catch {
      /* Private browsing or a full quota: it just will not survive a reload. */
    }
  }, [storageKey, overrides]);

  const isOpen = useCallback(
    (key: string) => overrides[key] ?? isRecentDay(key),
    [overrides],
  );

  const toggle = useCallback(
    (key: string) =>
      setOverrides((current) => {
        const next = { ...current, [key]: !(current[key] ?? isRecentDay(key)) };
        /*
         * Agreeing with the rule again is forgetting, not recording.
         *
         * Folding today and then opening it back up leaves nothing behind, so
         * tomorrow — when the rule would fold it anyway — there is no stale
         * "but they wanted this one open" to override it. It also keeps the
         * stored object to the days somebody genuinely disagreed about.
         */
        if (next[key] === isRecentDay(key)) delete next[key];
        return next;
      }),
    [],
  );

  return useMemo(() => ({ isOpen, toggle }), [isOpen, toggle]);
}

function load(storageKey: string): Record<string, boolean> {
  try {
    const stored = localStorage.getItem(storageKey);
    if (!stored) return {};
    const parsed: unknown = JSON.parse(stored);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    /*
     * Only the booleans.
     *
     * The key this replaced in the gallery held an array, which is caught
     * above; anything else with the right shape but the wrong values would
     * otherwise make `?? isRecentDay(key)` read a truthy string as "open".
     */
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        (entry): entry is [string, boolean] => typeof entry[1] === 'boolean',
      ),
    );
  } catch {
    return {};
  }
}
