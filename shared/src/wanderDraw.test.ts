import { describe, expect, it } from 'vitest';

import { DEFAULT_WANDER_DRAW } from './apiTypes.js';
import type { TasteEntry, TasteProfile, WanderDraw } from './apiTypes.js';
import { wanderCount, wanderReach } from './wanderDraw.js';

function note(fields: Partial<TasteEntry> & { text: string }): TasteEntry {
  return {
    id: fields.text,
    categoryId: null,
    active: true,
    always: false,
    position: 0,
    createdAt: 1,
    ...fields,
  };
}

/** Three headings with several notes each, and one note under none. */
function profile(): TasteProfile {
  return {
    categories: [
      { id: 'colour', name: 'Colour', active: true, position: 0, createdAt: 1 },
      { id: 'films', name: 'Films', active: true, position: 1, createdAt: 2 },
      { id: 'mood', name: 'Mood', active: true, position: 2, createdAt: 3 },
    ],
    entries: [
      note({ id: 'a', categoryId: 'colour', text: 'washed-out teal' }),
      note({ id: 'b', categoryId: 'colour', text: 'sodium orange' }),
      note({ id: 'c', categoryId: 'films', text: 'Portra 400' }),
      note({ id: 'd', categoryId: 'films', text: 'Ilford HP5' }),
      note({ id: 'e', categoryId: 'films', text: 'Cinestill 800T' }),
      note({ id: 'f', categoryId: 'mood', text: 'low fog' }),
      note({ id: 'g', categoryId: null, text: 'rain at night' }),
    ],
  };
}

const rules = (over: Partial<WanderDraw> = {}): WanderDraw => ({
  ...DEFAULT_WANDER_DRAW,
  ...over,
});

describe('how many notes the rules allow', () => {
  /*
   * The point of the default. Three headings and a loose note is four, however
   * many are filed under each — where an uncapped draw would happily take three
   * films and no colour at all.
   */
  it('is one per heading under the default cap', () => {
    expect(wanderReach(profile(), rules())).toBe(4);
  });

  it('is every eligible note when nothing is capped', () => {
    expect(wanderReach(profile(), rules({ perCategory: 0 }))).toBe(7);
  });

  it('follows a heading that overrides the general cap', () => {
    const draw = rules({ categories: { films: { role: 'draw', max: 2 } } });
    // Colour 1, films 2, mood 1, loose 1.
    expect(wanderReach(profile(), draw)).toBe(5);
  });

  it('drops a heading that is out of wandering, and the loose notes when they are', () => {
    expect(wanderReach(profile(), rules({ categories: { films: { role: 'off', max: 0 } } }))).toBe(3);
    expect(wanderReach(profile(), rules({ loose: 'off' }))).toBe(3);
  });

  it('ignores a switched-off note, a switched-off heading and an empty one', () => {
    const base = profile();
    base.entries.push(
      note({ id: 'h', categoryId: 'mood', text: 'unused', active: false }),
      note({ id: 'i', categoryId: 'mood', text: '   ' }),
    );
    base.categories.push({ id: 'later', name: 'Later', active: false, position: 3, createdAt: 4 });
    base.entries.push(note({ id: 'j', categoryId: 'later', text: 'someday' }));
    expect(wanderReach(base, rules())).toBe(4);
  });
});

describe('the count a round asks for', () => {
  it('is the number set, when one is set', () => {
    expect(wanderCount(profile(), rules(), 3)).toBe(3);
    // Above what the rules reach is still what was asked for — the draw is
    // what comes up short, and it says so in the sheet.
    expect(wanderCount(profile(), rules(), 6)).toBe(6);
  });

  /*
   * Zero is not "no notes". It is "no ceiling" — the whole point of the
   * default, and the one thing about this sentinel worth a test of its own.
   */
  it('is everything the rules reach when no ceiling is set', () => {
    expect(wanderCount(profile(), rules(), 0)).toBe(4);
    expect(wanderCount(profile(), rules({ perCategory: 0 }), 0)).toBe(7);
  });

  it('is nothing at all behind a locked vault', () => {
    expect(wanderCount(null, rules(), 0)).toBe(0);
    // A number that was set is still meaningless with no notes to draw from.
    expect(wanderCount(null, rules(), 3)).toBe(3);
  });

  it('takes a nonsense setting as no ceiling rather than as a crash', () => {
    expect(wanderCount(profile(), rules(), -2)).toBe(4);
    expect(wanderCount(profile(), rules(), Number.NaN)).toBe(4);
  });
});

describe('the shipped default', () => {
  it('caps a heading at one', () => {
    expect(DEFAULT_WANDER_DRAW.perCategory).toBe(1);
  });
});
