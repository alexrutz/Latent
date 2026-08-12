/**
 * Working out how much of a picture is actually on screen.
 *
 * A screen has a couple of million pixels. A recent output has sixteen, and
 * every one past the first two million is fetched, decoded and thrown away —
 * on a phone that is often rendering the next picture at the same time. So the
 * viewer asks for what it can show: the whole picture scaled into the screen,
 * and, once zoomed, the rectangle it is looking at scaled the same way.
 *
 * The arithmetic is here rather than in the component because it is the part
 * that can be wrong in ways nobody notices — an off-by-a-half in the centre of
 * a zoom is a crop that drifts, and that is much easier to see in a test than
 * on a phone.
 */

export interface Size {
  width: number;
  height: number;
}

/** A rectangle of the source, in the source's own pixels. */
export interface SourceRegion extends Size {
  x: number;
  y: number;
}

/** The same rectangle as fractions of the picture, each between 0 and 1. */
export type RegionFraction = SourceRegion;

/** What the viewer is doing to the picture: `translate(offset) scale(scale)`. */
export interface ViewTransform {
  scale: number;
  offsetX: number;
  offsetY: number;
}

/** Nothing is ever asked for above this, whatever the screen claims to be. */
export const MAX_VIEW_EDGE = 4096;

/**
 * The box a view should be rendered into, in device pixels.
 *
 * The viewport times the device's pixel ratio: that is the most a screen can
 * actually resolve, and asking for more is asking to throw it away. Capped,
 * because `devicePixelRatio` is whatever the browser says it is.
 *
 * `scale` multiplies that, for the setting that says how much of the screen's
 * resolution to render at. Above 1 is not waste in the way it sounds: it is
 * what makes the first moments of a zoom sharp, before the crop for it has
 * been fetched. The cap still applies, so a large scale on a large screen
 * quietly stops rather than asking for something absurd.
 */
export function viewBox(viewport: Size, pixelRatio: number, scale = 1): Size {
  const ratio = Number.isFinite(pixelRatio) && pixelRatio > 0 ? pixelRatio : 1;
  const factor = Number.isFinite(scale) && scale > 0 ? scale : 1;
  return {
    width: Math.max(1, Math.min(Math.round(viewport.width * ratio * factor), MAX_VIEW_EDGE)),
    height: Math.max(1, Math.min(Math.round(viewport.height * ratio * factor), MAX_VIEW_EDGE)),
  };
}

/**
 * The part of the source the viewport is showing, in source pixels.
 *
 * The picture is laid out `object-contain` — scaled to fit, centred — and then
 * the viewer's own `translate(offset) scale(scale)` is applied about the centre.
 * This inverts both steps for the viewport's two corners.
 *
 * Deliberately *not* clamped to the picture's bounds: whether the rectangle
 * runs off the edge is the thing the caller needs to know, and clamping it
 * first throws that away. See `regionIsInside`.
 */
export function visibleRegion(
  source: Size,
  viewport: Size,
  transform: ViewTransform,
): SourceRegion {
  const base = Math.min(viewport.width / source.width, viewport.height / source.height);
  const shownWidth = source.width * base;
  const shownHeight = source.height * base;
  const left = (viewport.width - shownWidth) / 2;
  const top = (viewport.height - shownHeight) / 2;

  const centreX = viewport.width / 2;
  const centreY = viewport.height / 2;
  const scale = transform.scale > 0 ? transform.scale : 1;

  const toSource = (x: number, y: number) => ({
    x: (centreX + (x - centreX - transform.offsetX) / scale - left) / base,
    y: (centreY + (y - centreY - transform.offsetY) / scale - top) / base,
  });

  const start = toSource(0, 0);
  const end = toSource(viewport.width, viewport.height);
  return {
    x: start.x,
    y: start.y,
    width: end.x - start.x,
    height: end.y - start.y,
  };
}

/** True when the rectangle lies wholly within the picture. */
export function regionIsInside(region: SourceRegion, source: Size): boolean {
  return (
    region.x >= 0 &&
    region.y >= 0 &&
    region.x + region.width <= source.width &&
    region.y + region.height <= source.height
  );
}

/**
 * The same rectangle as fractions of the picture.
 *
 * Why the wire format is fractions and not pixels: the viewer measures the
 * picture it was *given*, which is a copy scaled to the screen, so it does not
 * know — and must not have to know — how many pixels the file has. Every
 * quantity above scales linearly with the assumed size, so the ratio is exact
 * whatever that assumption was, and the server multiplies by the size it just
 * decoded. A wrong idea of the file's dimensions can therefore no longer
 * produce a crop of the wrong part of the picture.
 */
export function regionFraction(region: SourceRegion, source: Size): RegionFraction {
  return {
    x: region.x / source.width,
    y: region.y / source.height,
    width: region.width / source.width,
    height: region.height / source.height,
  };
}

/**
 * Whether a rectangle is worth asking the server to render.
 *
 * `rendered` is the picture currently on screen — the fitted copy, not the
 * file. Three reasons not to bother:
 *
 * - The rectangle is not wholly inside the picture. Zoomed out, or panned past
 *   an edge, a crop would not cover the viewport, so the fitted view is right.
 * - The fitted copy came back smaller than the box in both directions, which
 *   only happens because the server refused to enlarge it — so the file has no
 *   more pixels than are already on screen and a crop cannot add detail.
 * - Barely zoomed, where the crop would be the picture again.
 */
export function worthRendering(region: SourceRegion, rendered: Size, box: Size): boolean {
  if (!regionIsInside(region, rendered)) return false;
  if (rendered.width < box.width && rendered.height < box.height) return false;
  return region.width < rendered.width * 0.95 || region.height < rendered.height * 0.95;
}

/**
 * A stable name for one rendered rectangle.
 *
 * Rounded to four decimals — about a thousandth of the picture. A pinch
 * produces a new transform every frame, and re-fetching for a fraction of a
 * pixel of drift would be a request per frame for a picture nobody could tell
 * apart.
 */
export function regionKey(region: RegionFraction): string {
  return [region.x, region.y, region.width, region.height]
    .map((value) => value.toFixed(4))
    .join(',');
}
