import type { BrowseFavorite } from './apiTypes.js';
import { mediaKindOf, type MediaKind } from './media.js';

/**
 * The starred entries of the folder browser.
 *
 * Two rules, both small enough to be tempting to write inline in the picker and
 * both wrong in a way that is invisible there. The star is a toggle, so adding
 * and removing are the same gesture and have to be the same function — a second
 * tap that appends a duplicate looks like nothing happening until the list is
 * full of the same picture. And what a slot may offer is not what is stored: a
 * clip in a picture slot would be offered, picked, and refused by the node.
 */

/** On, or off, depending on where it already is. Newest first. */
export function toggleFavorite(
  favorites: BrowseFavorite[],
  ref: string,
  kind: BrowseFavorite['kind'],
  now: number,
): BrowseFavorite[] {
  const without = favorites.filter((entry) => entry.ref !== ref);
  if (without.length !== favorites.length) return without;
  return [{ ref, kind, addedAt: now }, ...favorites];
}

/**
 * The ones a slot of this kind can actually use.
 *
 * A folder always survives: what is inside it is the question the browser is
 * there to answer, and it may well hold both. A file has to be the right sort
 * of media, which its name already says.
 */
export function favoritesFor(favorites: BrowseFavorite[], kind: MediaKind): BrowseFavorite[] {
  return favorites.filter((entry) => entry.kind === 'folder' || mediaKindOf(entry.ref) === kind);
}

/**
 * Split a reference back into the root it lives under and the path within it.
 *
 * `output/monday/render.png` is the root `output` and the path
 * `monday/render.png`; a bare `output` is the root and nothing else, which is
 * what a starred root itself looks like.
 */
export function splitRef(ref: string): { root: string; path: string } {
  const cut = ref.indexOf('/');
  return cut === -1 ? { root: ref, path: '' } : { root: ref.slice(0, cut), path: ref.slice(cut + 1) };
}

/** The last segment of a reference, for a row with no listing behind it. */
export function nameOfRef(ref: string): string {
  return ref.split('/').filter(Boolean).pop() ?? ref;
}
