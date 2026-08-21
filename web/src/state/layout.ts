import { useEffect, useState } from 'react';

/**
 * How much screen there is, for the decisions CSS cannot make.
 *
 * Most of tablet mode is styling and belongs in the stylesheet, where the
 * `tablet:` and `wide:` variants do it with no JavaScript at all. Some of it is
 * not styling: whether the navigation is a rail or a bar, whether the Generate
 * screen renders a second pane, whether the chat has a column of pictures beside
 * it. Those are different trees, not different rules, and this is what decides
 * them.
 *
 * The two queries are the same strings as the variants in `index.css`, written
 * out rather than imported because CSS cannot export them. They have to stay in
 * step: a rail that appears at one width while the padding that makes room for
 * it appears at another is a layout with a seam in it.
 */
export const TABLET_QUERY = '(min-width: 600px) and (min-height: 600px)';
export const WIDE_QUERY = '(min-width: 900px) and (min-height: 600px)';

/**
 * Whether a media query matches, kept current.
 *
 * Read synchronously on the first render so the first paint is already right —
 * a rail that appears one frame late is a visible jump on every cold start —
 * and then updated from the query itself, which fires on rotation, on a
 * split-screen drag, and on a desktop window being resized.
 */
function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(query).matches,
  );

  useEffect(() => {
    const list = window.matchMedia(query);
    const update = () => setMatches(list.matches);
    update();
    list.addEventListener('change', update);
    return () => list.removeEventListener('change', update);
  }, [query]);

  return matches;
}

/** Big in both directions: a tablet, or a desktop window the size of one. */
export function useTablet(): boolean {
  return useMediaQuery(TABLET_QUERY);
}

/** Wide enough to put two panes side by side and have both of them work. */
export function useWide(): boolean {
  return useMediaQuery(WIDE_QUERY);
}
