import { describe, expect, it } from 'vitest';

import { planTiles, ROW_UNITS, tileUnits, type TileShape } from './tileRows.js';

/**
 * A shape per row, rather than a shape per tile.
 *
 * The rule being tested throughout: a row of pictures that agree gets their
 * shape, a row that disagrees gets a square, and either way every tile in a row
 * is the same height — because a row with two heights in it leaves a hole under
 * the shorter one, which is the reason galleries square everything off in the
 * first place.
 */

const portrait = (): TileShape => ({ width: 832, height: 1216 }); // 2:3
const landscape = (): TileShape => ({ width: 1216, height: 832 }); // 3:2
const square = (): TileShape => ({ width: 1024, height: 1024 });

/** Ratios are floats; compare them the way a reader would. */
const near = (value: number, expected: number) => expect(value).toBeCloseTo(expected, 2);

describe('planTiles', () => {
  it('gives a row of one shape that shape', () => {
    const plans = planTiles([portrait(), portrait(), portrait(), portrait()], 4);
    expect(plans).toHaveLength(4);
    for (const plan of plans) {
      near(plan.ratio, 832 / 1216);
      expect(plan.cols).toBe(1);
    }
  });

  it('keeps every tile in a row the same height', () => {
    // The whole point: two heights in one row is a hole under the shorter one.
    const plans = planTiles([portrait(), landscape(), square(), portrait()], 4);
    expect(new Set(plans.map((plan) => plan.ratio)).size).toBe(1);
  });

  it('squares off a row that cannot agree', () => {
    const plans = planTiles([portrait(), landscape()], 2);
    for (const plan of plans) near(plan.ratio, 1);
  });

  it('lets nearly-agreeing pictures share a shape between them', () => {
    // 3:2 and 4:3 are the same sort of picture; both get something in between
    // rather than both being squared.
    const plans = planTiles([{ width: 1216, height: 832 }, { width: 1152, height: 896 }], 2);
    expect(plans[0]!.ratio).toBeGreaterThan(1.1);
    expect(plans[0]!.ratio).toBeLessThan(1.5);
    expect(plans[0]!.ratio).toBe(plans[1]!.ratio);
  });

  it('decides each row for itself', () => {
    const plans = planTiles(
      [portrait(), portrait(), landscape(), landscape()],
      2,
    );
    near(plans[0]!.ratio, 832 / 1216);
    near(plans[1]!.ratio, 832 / 1216);
    near(plans[2]!.ratio, 1216 / 832);
    near(plans[3]!.ratio, 1216 / 832);
  });

  it('lays out a last row that is not full', () => {
    const plans = planTiles([portrait(), portrait(), portrait()], 2);
    near(plans[0]!.ratio, 832 / 1216);
    // The odd one is a row of its own, and a row of one always agrees.
    near(plans[2]!.ratio, 832 / 1216);
  });

  it('never runs a picture past the edge of the grid', () => {
    const plans = planTiles([{ tileSpan: { cols: 5, rows: 1 } }, square()], 3);
    expect(plans[0]!.cols).toBe(3);
  });

  it('holds every shape between 2:1 and 1:2', () => {
    // Otherwise a panorama is a sliver and a column of a picture is a page.
    const [wide] = planTiles([{ width: 4000, height: 500 }], 1);
    const [tall] = planTiles([{ width: 500, height: 4000 }], 1);
    expect(wide!.ratio).toBe(2);
    expect(tall!.ratio).toBe(0.5);
  });

  it('squares everything when uniform tiles are asked for', () => {
    const plans = planTiles([portrait(), landscape()], 2, { uniform: true });
    for (const plan of plans) expect(plan.ratio).toBe(1);
  });

  it('treats a picture with no known size as a square', () => {
    const plans = planTiles([{ width: null, height: null }, square()], 2);
    for (const plan of plans) near(plan.ratio, 1);
  });

  it('counts a placeholder as a slot, so the rows after it stay in step', () => {
    const withHole = planTiles([{}, portrait(), portrait(), portrait()], 2);
    // The first row is the placeholder and one portrait, which disagree.
    near(withHole[0]!.ratio, 1);
    near(withHole[1]!.ratio, 1);
    // The second is two portraits, which do not.
    near(withHole[2]!.ratio, 832 / 1216);
  });

  describe('a shape chosen by hand', () => {
    it('is used exactly, whatever the picture is', () => {
      const [plan] = planTiles([{ width: 1024, height: 1024, tileSpan: { cols: 1, rows: 2 } }], 1);
      near(plan!.ratio, 0.5);
    });

    it('is not clamped like an automatic one', () => {
      const [plan] = planTiles([{ tileSpan: { cols: 1, rows: 4 } }], 1);
      near(plan!.ratio, 0.25);
    });

    it('sets the height of its whole row, so the row stays flush', () => {
      const plans = planTiles(
        [{ tileSpan: { cols: 1, rows: 2 } }, portrait(), portrait()],
        3,
      );
      for (const plan of plans) near(plan.ratio, 0.5);
    });

    it('survives the uniform-tiles setting, which is about the rest', () => {
      const plans = planTiles([{ tileSpan: { cols: 2, rows: 1 } }], 2, { uniform: true });
      near(plans[0]!.ratio, 2);
      expect(plans[0]!.cols).toBe(2);
    });
  });
});

describe('tileUnits', () => {
  const CELL = 120;
  const GAP = 8;

  /**
   * The height the tile is actually drawn at, and how close that has to be.
   *
   * The row gap is zero and the gutter is the tile's own padding, so the height
   * asked of the grid is the picture's height plus one gap. Rows come in whole
   * units, so the answer lands within half a unit of the shape asked for —
   * a twentieth of a square tile here, and the price of a grid that never
   * leaves a hole.
   */
  const drawnAt = (ratio: number, cols = 1) => {
    const units = tileUnits({ cols, ratio }, CELL, GAP);
    return units * (CELL / ROW_UNITS) - GAP;
  };
  const half = CELL / ROW_UNITS / 2;

  it('makes a square tile as tall as a column is wide', () => {
    expect(Math.abs(drawnAt(1) - CELL)).toBeLessThanOrEqual(half);
  });

  it('makes a 2:3 tile half again as tall as it is wide', () => {
    expect(Math.abs(drawnAt(2 / 3) - CELL * 1.5)).toBeLessThanOrEqual(half);
  });

  it('counts the gap a wide tile spans across', () => {
    // Two columns of 120 with an 8px gutter between them is 248 wide, so a
    // square tile there is 248 tall — not 240.
    expect(Math.abs(drawnAt(1, 2) - 248)).toBeLessThanOrEqual(half);
  });

  it('is finer than one row per cell', () => {
    // The point of the sub-unit: 2:3 and 3:4 are different heights now, where
    // a grid of whole cells had to round them both to a square.
    const twoThirds = tileUnits({ cols: 1, ratio: 2 / 3 }, 120, 8);
    const threeQuarters = tileUnits({ cols: 1, ratio: 3 / 4 }, 120, 8);
    expect(twoThirds).toBeGreaterThan(threeQuarters);
    expect(threeQuarters).toBeGreaterThan(ROW_UNITS);
  });

  it('never asks for nothing', () => {
    expect(tileUnits({ cols: 1, ratio: 2 }, 0, 8)).toBeGreaterThan(0);
  });
});
