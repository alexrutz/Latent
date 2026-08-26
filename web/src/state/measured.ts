import { useSyncExternalStore } from 'react';

import type { ComfyImageRef } from '@latent/shared';

/**
 * How big a picture turned out to be, as this browser found out.
 *
 * The server learns a picture's dimensions from whoever first loads it — see
 * `reportImageDimensions` — and that report is deliberately one-way: telling
 * the gallery query to refetch after every thumbnail in a hundred-picture grid
 * was a re-render storm, and it was measured and removed.
 *
 * Which was fine while a tile's shape barely depended on the answer. It does
 * now: a tile is the shape of its picture, so a run whose sizes the client's
 * copy of the gallery does not carry yet would lay out as squares and only come
 * right on some later refetch — which for the pictures you just made is exactly
 * the wrong moment to be wrong.
 *
 * The browser already knows, though. It measured the image to report it. So it
 * is kept here too, and the layout reads it without anybody going near the
 * network.
 */

const sizes = new Map<string, { width: number; height: number }>();
const listeners = new Set<() => void>();
let version = 0;

/** The same key `reportImageDimensions` uses, so the two cannot disagree. */
export function sizeKey(image: Pick<ComfyImageRef, 'type' | 'subfolder' | 'filename'>): string {
  return `${image.type}/${image.subfolder}/${image.filename}`;
}

/** Record what the browser measured. Idempotent; the first answer stands. */
export function noteMeasured(
  image: Pick<ComfyImageRef, 'type' | 'subfolder' | 'filename'>,
  width: number,
  height: number,
): void {
  if (!(width > 0) || !(height > 0)) return;
  const key = sizeKey(image);
  if (sizes.has(key)) return;
  sizes.set(key, { width, height });
  version += 1;
  for (const listener of listeners) listener();
}

export function measuredSize(
  image: Pick<ComfyImageRef, 'type' | 'subfolder' | 'filename'>,
): { width: number; height: number } | null {
  return sizes.get(sizeKey(image)) ?? null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * A number that changes whenever a new picture has been measured.
 *
 * For putting in a `useMemo`'s dependencies: the layout is worked out for a
 * whole grid at once, so what it needs is "something changed, work it out
 * again" rather than a value per picture.
 */
export function useMeasuredVersion(): number {
  return useSyncExternalStore(
    subscribe,
    () => version,
    () => version,
  );
}
