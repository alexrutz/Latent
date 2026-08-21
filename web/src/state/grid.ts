import { useEffect, useState } from 'react';

import { DEFAULT_GRID_SETTINGS, type GenerationImage, type GridSettings, type TileSpan } from '@latent/shared';

import { TABLET_QUERY } from './layout';

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
export function useGridSettings(): [GridSettings, (patch: Partial<GridSettings>) => void] {
  const [settings, setSettings] = useState<GridSettings>(() => {
    const initial =
      typeof window !== 'undefined' && window.matchMedia(TABLET_QUERY).matches
        ? { ...DEFAULT_GRID_SETTINGS, columns: 4 }
        : DEFAULT_GRID_SETTINGS;
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      return stored ? { ...initial, ...JSON.parse(stored) } : initial;
    } catch {
      return initial;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // Private browsing, quota — not worth failing over.
    }
  }, [settings]);

  return [settings, (patch) => setSettings((current) => ({ ...current, ...patch }))];
}

/**
 * How many grid cells a thumbnail should occupy.
 *
 * The goal is to show as much of each picture as possible: a wide image gets a
 * wide tile, a tall one a tall tile, so nothing has to be cropped to a square.
 * A manual override always wins, and without known dimensions we fall back to
 * a single cell rather than guessing and making the layout jump later.
 */
export function tileSpanFor(
  image: Pick<GenerationImage, 'width' | 'height' | 'tileSpan'>,
  settings: GridSettings,
): TileSpan {
  if (image.tileSpan) return image.tileSpan;
  if (settings.uniformTiles) return { cols: 1, rows: 1 };
  if (!image.width || !image.height) return { cols: 1, rows: 1 };

  const ratio = image.width / image.height;

  // Thresholds sit near the common aspect ratios: 16:9 is 1.78, 3:2 is 1.5,
  // 4:3 is 1.33. Anything past 1.6 reads as "wide" and is worth two columns.
  if (ratio >= 1.6 && settings.columns > 1) return { cols: 2, rows: 1 };
  if (ratio <= 0.625) return { cols: 1, rows: 2 };
  return { cols: 1, rows: 1 };
}

/**
 * CSS for one tile.
 *
 * The grid uses fixed-height rows so a `row-span` is meaningful; `aspect-ratio`
 * alone would not let a tall image actually occupy two rows.
 */
export function tileStyle(span: TileSpan, columns: number): React.CSSProperties {
  return {
    gridColumn: `span ${Math.min(span.cols, columns)}`,
    gridRow: `span ${span.rows}`,
  };
}

export const TILE_OPTIONS: { label: string; span: TileSpan | null }[] = [
  { label: 'Auto', span: null },
  { label: '1×1', span: { cols: 1, rows: 1 } },
  { label: '2×1', span: { cols: 2, rows: 1 } },
  { label: '1×2', span: { cols: 1, rows: 2 } },
  { label: '2×2', span: { cols: 2, rows: 2 } },
];
