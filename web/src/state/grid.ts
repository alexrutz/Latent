import { create } from 'zustand';

import { DEFAULT_GRID_SETTINGS, type GridSettings, type TileSpan } from '@latent/shared';

import { DESK_QUERY, TABLET_QUERY } from './layout';

const STORAGE_KEY = 'latent.grid';

/**
 * How many columns the grid may be set to on this screen.
 *
 * Five is as many as a phone can show and still have each picture be a picture
 * rather than a swatch. A tablet is twice the width, and the same argument that
 * caps a phone at five puts the cap at eight here — three columns on a
 * nine-inch screen is four hundred pixels a thumbnail, which is not a grid, it
 * is a slideshow with the scrollbar doing the work.
 *
 * Read once, not watched. It is the ceiling on a slider, and a number that
 * moved while somebody was dragging would be worse than one that is briefly
 * generous after a rotation.
 */
export function maxColumns(): number {
  return typeof window !== 'undefined' && window.matchMedia(TABLET_QUERY).matches ? 8 : 5;
}

/**
 * Grid layout preferences.
 *
 * Kept on the device rather than the server: how many columns feel right
 * depends on the screen you are holding, not on the account. Which is also why
 * the first-run default is not a constant — two columns is right for a phone
 * and absurd on a tablet, where it means two pictures the size of postcards and
 * a scroll for the third.
 */
/**
 * One store, not a copy per component.
 *
 * This was `useState` seeded from `localStorage`, which is fine while exactly
 * one thing reads it and quietly wrong the moment two do. Every consumer wrote
 * the *whole* settings object on every change, so two mounted copies drifted
 * apart the first time either changed anything and then took turns reverting
 * the other — the gallery's column count undone by a viewer opened from
 * somewhere else, with nothing on screen to say why.
 *
 * It was always latent: the chat and the viewer over it are two, so are the
 * gallery and its viewer. The bench panel made it reachable everywhere, because
 * it is mounted on every screen at a desk. A shared store is the fix for all of
 * them and not only for that one.
 */
interface GridStore {
  settings: GridSettings;
  patch: (change: Partial<GridSettings>) => void;
}

const useGridStore = create<GridStore>((set) => ({
  settings: load(),
  patch: (change) =>
    set((state) => {
      const settings = { ...state.settings, ...change };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
      } catch {
        // Private browsing, quota — not worth failing over.
      }
      return { settings };
    }),
}));

export function useGridSettings(): [GridSettings, (patch: Partial<GridSettings>) => void] {
  const settings = useGridStore((state) => state.settings);
  const patch = useGridStore((state) => state.patch);
  return [settings, patch];
}

/**
 * What the grid starts as, once, when the module loads.
 *
 * Three defaults, because the right answer is the screen's. Two columns is
 * right for a phone and absurd on a tablet; four is right on a tablet and thin
 * at a desk, where the grid has a sidebar and a panel beside it and *still* has
 * more width than a tablet has in total — four there is four postcards on a
 * table with room for eight.
 */
function load(): GridSettings {
  const columns =
    typeof window === 'undefined'
      ? null
      : window.matchMedia(DESK_QUERY).matches
        ? 6
        : window.matchMedia(TABLET_QUERY).matches
          ? 4
          : null;
  const initial = columns ? { ...DEFAULT_GRID_SETTINGS, columns } : DEFAULT_GRID_SETTINGS;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored ? { ...initial, ...(JSON.parse(stored) as Partial<GridSettings>) } : initial;
  } catch {
    return initial;
  }
}

/**
 * The shapes a picture can be pinned to by hand.
 *
 * `cols` is whole columns; `rows` is that many column-widths of height, and it
 * may be fractional — which is the point. A tile used to be a whole number of
 * square cells, so the only shapes it could take were 1:1, 2:1 and 1:2, and a
 * 2:3 picture had nowhere to go but a square. The grid's rows are a twelfth of
 * a column now (see `planTiles`), so any of these is drawable at one column
 * wide, and the list can say what it means: a ratio rather than a cell count.
 *
 * Old stored overrides are whole numbers and still mean exactly what they did.
 *
 * "Wide" and "Tall" at the end are the two that take more than one column —
 * for a picture worth featuring rather than one worth showing straight.
 */
export const TILE_OPTIONS: { label: string; span: TileSpan | null }[] = [
  { label: 'Auto', span: null },
  { label: '2:1', span: { cols: 1, rows: 0.5 } },
  { label: '16:9', span: { cols: 1, rows: 9 / 16 } },
  { label: '3:2', span: { cols: 1, rows: 2 / 3 } },
  { label: '4:3', span: { cols: 1, rows: 0.75 } },
  { label: '1:1', span: { cols: 1, rows: 1 } },
  { label: '3:4', span: { cols: 1, rows: 4 / 3 } },
  { label: '2:3', span: { cols: 1, rows: 1.5 } },
  { label: '9:16', span: { cols: 1, rows: 16 / 9 } },
  { label: '1:2', span: { cols: 1, rows: 2 } },
  { label: 'Wide', span: { cols: 2, rows: 1 } },
  { label: 'Big', span: { cols: 2, rows: 2 } },
];
