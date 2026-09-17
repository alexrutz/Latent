import type { TileSpan } from './apiTypes.js';

/**
 * What shape each thumbnail is drawn at.
 *
 * A grid of squares crops everything to a square, which for a 2:3 portrait
 * throws away a third of the picture — and a gallery of generated images is
 * mostly *not* square, because the ratio was chosen deliberately when the
 * picture was made. So a tile should be the shape of its picture.
 *
 * The catch is that a grid row with tiles of different heights leaves holes:
 * CSS grid places the next item in the next free column, and a short tile
 * beside a tall one leaves the space under it empty until something happens to
 * fit. That is the whole reason galleries default to squares.
 *
 * The way out is to decide a shape per *row* rather than per tile. Pictures
 * that agree on a shape get that shape — a row of 2:3 portraits is a row of 2:3
 * tiles, flush on both edges — and a row that disagrees falls back to square,
 * which is exactly what it did before. Nothing is ever ragged, because every
 * tile in a row is the same height by construction.
 *
 * Ratios here are always width ÷ height, so 2:3 is 0.667 and 3:2 is 1.5.
 */

/**
 * How many sub-rows one column width is divided into.
 *
 * The grid's rows used to be one cell tall, which meant a tile's shape could
 * only ever be a ratio of small whole numbers — 1:1, 2:1, 1:2 — and a 2:3
 * picture had nowhere to go but a square. Twelfths give every shape between 2:1
 * and 1:2 a place to land, with 2:3, 3:4, 4:3 and 3:2 all falling exactly on a
 * unit.
 *
 * Twelve rather than more: these become implicit grid rows, and a gallery of
 * two hundred pictures already runs to a few thousand of them.
 */
export const ROW_UNITS = 12;

/** The widest and tallest a tile may be drawn, whatever the picture is. */
export const WIDEST_TILE = 2;
export const TALLEST_TILE = 0.5;

/**
 * How far apart two pictures' shapes may be and still share a row.
 *
 * A fraction of each other rather than a difference, because shape is
 * multiplicative: 3:2 and 4:3 are as far apart as 2:3 and 3:4, and both pairs
 * read as "the same sort of picture". At 1.25 those pairs share a row and get a
 * shape between them, costing a few per cent of crop each; a portrait and a
 * landscape do not, and their row is square.
 */
const ROW_TOLERANCE = 1.25;

/** One picture, as much of it as the layout cares about. */
export interface TileShape {
  width?: number | null;
  height?: number | null;
  /** A shape chosen by hand for this one picture, which always wins. */
  tileSpan?: TileSpan | null;
}

/** Where one tile goes: how many columns, and what shape to draw it. */
export interface TilePlan {
  cols: number;
  /** Width ÷ height of the tile itself. */
  ratio: number;
}

function clampRatio(ratio: number): number {
  if (!Number.isFinite(ratio) || ratio <= 0) return 1;
  return Math.min(WIDEST_TILE, Math.max(TALLEST_TILE, ratio));
}

/** The shape a picture would like, before its row has a say. */
function wanted(shape: TileShape, uniform: boolean): TilePlan & { fixed: boolean } {
  const span = shape.tileSpan;
  if (span && span.cols > 0 && span.rows > 0) {
    // Chosen by hand, so it is not clamped and not up for negotiation.
    return { cols: Math.max(1, Math.round(span.cols)), ratio: span.cols / span.rows, fixed: true };
  }
  if (uniform) return { cols: 1, ratio: 1, fixed: false };

  const { width, height } = shape;
  if (!width || !height) return { cols: 1, ratio: 1, fixed: false };
  return { cols: 1, ratio: clampRatio(width / height), fixed: false };
}

/**
 * The one shape a row is drawn at.
 *
 * A hand-picked tile fixes it: the point of choosing a shape is that it is the
 * shape you get, and the rest of the row matching it is what keeps the row
 * flush. Otherwise the row agrees or it does not — and when it does, the shape
 * is the geometric mean, which is the middle of a set of ratios in the sense
 * that matters (equally far from both ends as a fraction).
 */
function rowRatio(row: readonly (TilePlan & { fixed: boolean })[]): number {
  const fixed = row.find((entry) => entry.fixed);
  if (fixed) return fixed.ratio;

  let lowest = Infinity;
  let highest = 0;
  let logSum = 0;
  for (const entry of row) {
    lowest = Math.min(lowest, entry.ratio);
    highest = Math.max(highest, entry.ratio);
    logSum += Math.log(entry.ratio);
  }
  if (highest / lowest > ROW_TOLERANCE) return 1;
  return Math.exp(logSum / row.length);
}

/**
 * Lay out a list of pictures, a row at a time.
 *
 * The order is the order they are shown in, placeholders included — a run with
 * no picture yet still takes a slot, and leaving it out here would put every
 * row after it out of step with what is on screen.
 */
export function planTiles(
  shapes: readonly TileShape[],
  columns: number,
  options: { uniform?: boolean } = {},
): TilePlan[] {
  const width = Math.max(1, Math.floor(columns));
  const wants = shapes.map((shape) => wanted(shape, options.uniform === true));
  const plans: TilePlan[] = new Array(shapes.length);

  let at = 0;
  while (at < wants.length) {
    const row: number[] = [];
    let used = 0;
    while (at < wants.length) {
      const cols = Math.min(wants[at]!.cols, width);
      // A tile that would overhang starts the next row instead of being cut in
      // half — but a row always takes at least one, or nothing would ever move.
      if (row.length > 0 && used + cols > width) break;
      row.push(at);
      used += cols;
      at += 1;
      if (used >= width) break;
    }

    const ratio = rowRatio(row.map((index) => wants[index]!));
    for (const index of row) {
      plans[index] = { cols: Math.min(wants[index]!.cols, width), ratio };
    }
  }

  return plans;
}

/**
 * One tile's grid placement, in columns and row units.
 *
 * The row unit is a twelfth of a column's *width*, and the row gap is zero —
 * with a gap between every sub-row the gaps would add up to more than the tile.
 * The gutter is the tile's own bottom padding instead, which is why the height
 * asked for here is the picture's height plus one gap.
 */
export function tileUnits(plan: TilePlan, cell: number, gap: number): number {
  const width = plan.cols * cell + (plan.cols - 1) * gap;
  const height = width / (plan.ratio > 0 ? plan.ratio : 1);
  const unit = cell / ROW_UNITS;
  if (!Number.isFinite(unit) || unit <= 0) return ROW_UNITS;
  return Math.max(1, Math.round((height + gap) / unit));
}
