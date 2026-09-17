import { describe, expect, it } from 'vitest';

import type { BrowseFavorite } from './apiTypes.js';
import { favoritesFor, nameOfRef, splitRef, toggleFavorite } from './browseFavorites.js';

const file = (ref: string, addedAt = 1): BrowseFavorite => ({ ref, kind: 'file', addedAt });
const folder = (ref: string, addedAt = 1): BrowseFavorite => ({ ref, kind: 'folder', addedAt });

describe('starring an entry', () => {
  it('adds it at the front, where the eye already is', () => {
    const before = [file('output/a.png', 1)];
    const after = toggleFavorite(before, 'output/b.png', 'file', 9);

    expect(after.map((entry) => entry.ref)).toEqual(['output/b.png', 'output/a.png']);
    expect(after[0]).toEqual({ ref: 'output/b.png', kind: 'file', addedAt: 9 });
    // The list handed in is left alone: it is query cache data.
    expect(before).toHaveLength(1);
  });

  it('takes it away again rather than adding it twice', () => {
    const once = toggleFavorite([], 'output/a.png', 'file', 1);
    expect(toggleFavorite(once, 'output/a.png', 'file', 2)).toEqual([]);
  });

  /*
   * A folder and a file are told apart by their reference, not their kind, so
   * starring a folder that happens to share a name with nothing else still
   * removes exactly the entry it matches.
   */
  it('matches on the reference, whatever kind is passed', () => {
    const before = [folder('output/monday'), file('output/monday.png')];
    expect(toggleFavorite(before, 'output/monday', 'file', 5).map((entry) => entry.ref)).toEqual([
      'output/monday.png',
    ]);
  });
});

describe('what a slot may offer', () => {
  const all = [
    folder('output/monday'),
    file('output/render.png'),
    file('output/clip.mp4'),
    file('output/take.wav'),
  ];

  it('keeps every folder, whatever the slot loads', () => {
    for (const kind of ['image', 'video', 'audio'] as const) {
      expect(favoritesFor(all, kind).map((entry) => entry.ref)).toContain('output/monday');
    }
  });

  it('keeps only the files that slot can load', () => {
    expect(favoritesFor(all, 'image').map((entry) => entry.ref)).toEqual([
      'output/monday',
      'output/render.png',
    ]);
    expect(favoritesFor(all, 'video').map((entry) => entry.ref)).toEqual([
      'output/monday',
      'output/clip.mp4',
    ]);
    expect(favoritesFor(all, 'audio').map((entry) => entry.ref)).toEqual([
      'output/monday',
      'output/take.wav',
    ]);
  });
});

describe('reading a reference', () => {
  it('splits the root off the path', () => {
    expect(splitRef('output/monday/render.png')).toEqual({
      root: 'output',
      path: 'monday/render.png',
    });
    expect(splitRef('output')).toEqual({ root: 'output', path: '' });
  });

  it('names an entry by its last segment', () => {
    expect(nameOfRef('output/monday/render.png')).toBe('render.png');
    expect(nameOfRef('output/monday/')).toBe('monday');
    expect(nameOfRef('output')).toBe('output');
  });
});
