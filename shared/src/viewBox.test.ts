import { describe, expect, it } from 'vitest';

import {
  MAX_VIEW_EDGE,
  regionFraction,
  regionIsInside,
  regionKey,
  viewBox,
  visibleRegion,
  worthRendering,
} from './viewBox.js';

/**
 * The arithmetic behind "show me what this screen can actually use".
 *
 * Worth testing rather than eyeballing: a crop that is a few percent off looks
 * like a picture that drifts as you zoom, which is the kind of wrong that is
 * obvious in a number and invisible on a phone.
 */

const SQUARE = { width: 4000, height: 4000 };
/** A portrait phone, as CSS pixels. */
const PHONE = { width: 390, height: 844 };

describe('the box a view is asked for', () => {
  it('is the viewport in device pixels', () => {
    expect(viewBox(PHONE, 3)).toEqual({ width: 1170, height: 2532 });
  });

  it('treats a missing or nonsense ratio as one', () => {
    expect(viewBox(PHONE, Number.NaN)).toEqual({ width: 390, height: 844 });
    expect(viewBox(PHONE, 0)).toEqual({ width: 390, height: 844 });
  });

  it('caps what a browser claims', () => {
    const box = viewBox({ width: 4000, height: 4000 }, 4);
    expect(box).toEqual({ width: MAX_VIEW_EDGE, height: MAX_VIEW_EDGE });
  });
});

describe('the part of the picture on screen', () => {
  const still = { scale: 1, offsetX: 0, offsetY: 0 };

  it('is the whole picture when nothing is zoomed', () => {
    const region = visibleRegion(SQUARE, PHONE, still);
    expect(Math.round(region.x)).toBe(0);
    expect(Math.round(region.width)).toBe(4000);
    // Taller than the picture: `object-contain` letterboxes, so the viewport
    // sees past the top and bottom edges.
    expect(region.y).toBeLessThan(0);
    expect(region.height).toBeGreaterThan(4000);
  });

  it('halves in each direction at twice the scale', () => {
    const region = visibleRegion(SQUARE, PHONE, { ...still, scale: 2 });
    expect(Math.round(region.width)).toBe(2000);
    // Still centred: the same amount is cut from each side.
    expect(Math.round(region.x)).toBe(1000);
  });

  it('follows a pan', () => {
    const centred = visibleRegion(SQUARE, PHONE, { ...still, scale: 2 });
    const panned = visibleRegion(SQUARE, PHONE, { scale: 2, offsetX: -100, offsetY: 0 });
    // Dragging the picture left shows what was off to the right.
    expect(panned.x).toBeGreaterThan(centred.x);
    expect(Math.round(panned.width)).toBe(Math.round(centred.width));
  });

  it('keeps the viewport’s shape, so a crop covers it exactly', () => {
    const region = visibleRegion(SQUARE, PHONE, { ...still, scale: 3 });
    expect(region.width / region.height).toBeCloseTo(PHONE.width / PHONE.height, 5);
  });

  it('says when the rectangle runs off the picture', () => {
    expect(regionIsInside(visibleRegion(SQUARE, PHONE, still), SQUARE)).toBe(false);
    expect(regionIsInside(visibleRegion(SQUARE, PHONE, { ...still, scale: 4 }), SQUARE)).toBe(true);
  });
});

describe('a rectangle as fractions', () => {
  /*
   * The property the whole design rests on: the viewer measures the copy it was
   * handed, not the file, so the size it works in is arbitrary. Fractions have
   * to come out the same either way, or a crop lands on the wrong part of the
   * picture whenever that guess is off.
   */
  it('is the same whatever size the picture is thought to be', () => {
    const transform = { scale: 2.5, offsetX: -40, offsetY: 30 };
    const big = regionFraction(visibleRegion(SQUARE, PHONE, transform), SQUARE);
    const thumb = { width: 384, height: 384 };
    const small = regionFraction(visibleRegion(thumb, PHONE, transform), thumb);

    expect(small.x).toBeCloseTo(big.x, 6);
    expect(small.y).toBeCloseTo(big.y, 6);
    expect(small.width).toBeCloseTo(big.width, 6);
    expect(small.height).toBeCloseTo(big.height, 6);
  });

  it('is the whole picture when nothing is zoomed and nothing is cut', () => {
    const wide = { width: 1000, height: 500 };
    const viewport = { width: 400, height: 200 };
    const fraction = regionFraction(
      visibleRegion(wide, viewport, { scale: 1, offsetX: 0, offsetY: 0 }),
      wide,
    );
    expect(fraction).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });
});

describe('whether a rectangle is worth rendering', () => {
  const box = viewBox(PHONE, 3);
  /** What the server sends back for a big file: the box, letterboxed to shape. */
  const RENDERED = { width: box.width, height: box.width };

  it('is not, when it is not wholly inside the picture', () => {
    const region = visibleRegion(RENDERED, PHONE, { scale: 1, offsetX: 0, offsetY: 0 });
    expect(worthRendering(region, RENDERED, box)).toBe(false);
  });

  it('is, once the zoom is past the edges of the picture', () => {
    /*
     * Three, not two. A square picture on a portrait phone is letterboxed, so
     * the viewport keeps seeing past its top and bottom until roughly 844/390 —
     * and until it does, a crop would not cover the screen.
     */
    const region = visibleRegion(RENDERED, PHONE, { scale: 3, offsetX: 0, offsetY: 0 });
    expect(regionIsInside(region, RENDERED)).toBe(true);
    expect(worthRendering(region, RENDERED, box)).toBe(true);
  });

  it('is never worth it for a picture the screen already outresolves', () => {
    // Smaller than the box in both directions: the server declined to enlarge
    // it, which is how the viewer learns the file has nothing more to give.
    const small = { width: 512, height: 512 };
    const region = visibleRegion(small, PHONE, { scale: 3, offsetX: 0, offsetY: 0 });
    expect(worthRendering(region, small, box)).toBe(false);
  });

  it('is not worth it for a zoom that has barely moved', () => {
    const region = visibleRegion(RENDERED, PHONE, { scale: 1.01, offsetX: 0, offsetY: 0 });
    expect(worthRendering(region, RENDERED, box)).toBe(false);
  });
});

describe('naming a rectangle', () => {
  it('ignores sub-pixel drift, so a pinch is not a request per frame', () => {
    const a = { x: 0.250001, y: 0.5, width: 0.2, height: 0.2 };
    const b = { x: 0.250009, y: 0.500004, width: 0.200002, height: 0.199998 };
    expect(regionKey(a)).toBe(regionKey(b));
  });

  it('tells genuinely different rectangles apart', () => {
    expect(regionKey({ x: 0, y: 0, width: 0.5, height: 0.5 })).not.toBe(
      regionKey({ x: 0.1, y: 0, width: 0.5, height: 0.5 }),
    );
  });
});
