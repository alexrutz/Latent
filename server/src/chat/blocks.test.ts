import { describe, expect, it } from 'vitest';

import type { ProposedBlock, PromptBlock } from '@latent/shared';

import { blockLibrary, resolveProposedBlocks } from './blocks.js';

/**
 * Matching a proposal to the library it is about.
 *
 * The fault this covers looked like "it cannot delete blocks". It could not:
 * the tool asked for an id, the model had never been shown one, and a removal
 * without an id was dropped on the floor without anybody being told. So the
 * cases that matter here are the ones a model actually produces — a name and a
 * group, spelled a little differently, sometimes with a fragment invented to
 * satisfy a required field.
 */

function block(name: string, category: string, text: string, id = name.toLowerCase()): PromptBlock {
  return { id, name, category, text, position: 0, createdAt: 0 };
}

const LIBRARY: PromptBlock[] = [
  block('Golden hour', 'Lighting', 'warm low sun, long shadows'),
  block('Overcast', 'Lighting', 'flat grey daylight'),
  block('Wide shot', 'Camera', 'wide establishing framing'),
];

describe('resolveProposedBlocks', () => {
  it('finds the block a removal names, without an id and without its text', () => {
    const [resolved] = resolveProposedBlocks(
      [{ action: 'remove', name: 'Golden hour', category: 'Lighting', text: '' }],
      LIBRARY,
    );

    expect(resolved?.id).toBe('golden hour');
    expect(resolved?.missing).toBeUndefined();
    // Described by the block itself, so the dialog shows what will actually go.
    expect(resolved?.text).toBe('warm low sun, long shadows');
  });

  it('does not care about case or stray spaces', () => {
    const [resolved] = resolveProposedBlocks(
      [{ action: 'remove', name: '  golden HOUR ', category: 'lighting', text: '' }],
      LIBRARY,
    );

    expect(resolved?.id).toBe('golden hour');
  });

  it('finds one by name alone when the model puts it in the wrong group', () => {
    const [resolved] = resolveProposedBlocks(
      [{ action: 'remove', name: 'Wide shot', category: 'Framing', text: '' }],
      LIBRARY,
    );

    expect(resolved?.id).toBe('wide shot');
  });

  it('ignores the fragment a removal invented for the block it wants gone', () => {
    const [resolved] = resolveProposedBlocks(
      [
        {
          action: 'remove',
          name: 'Overcast',
          category: 'Lighting',
          text: 'something the model made up',
        },
      ],
      LIBRARY,
    );

    expect(resolved?.id).toBe('overcast');
    expect(resolved?.text).toBe('flat grey daylight');
  });

  it('marks what it cannot find rather than guessing', () => {
    const [resolved] = resolveProposedBlocks(
      [{ action: 'remove', name: 'Moonlight', category: 'Lighting', text: '' }],
      LIBRARY,
    );

    expect(resolved?.missing).toBe(true);
    expect(resolved?.id).toBeUndefined();
  });

  it('refuses to pick between two blocks with the same name', () => {
    const ambiguous = [
      ...LIBRARY,
      block('Golden hour', 'Mood', 'nostalgic warmth', 'golden-mood'),
    ];

    const [byName] = resolveProposedBlocks(
      [{ action: 'remove', name: 'Golden hour', category: '', text: '' }],
      ambiguous,
    );
    expect(byName?.missing).toBe(true);

    // Unless the group settles it.
    const [byGroup] = resolveProposedBlocks(
      [{ action: 'remove', name: 'Golden hour', category: 'Mood', text: '' }],
      ambiguous,
    );
    expect(byGroup?.id).toBe('golden-mood');
  });

  it('keeps a change’s new wording and fills the rest back in', () => {
    const [resolved] = resolveProposedBlocks(
      [{ action: 'update', name: 'Golden hour', category: '', text: 'warm low sun, hazy air' }],
      LIBRARY,
    );

    expect(resolved?.id).toBe('golden hour');
    expect(resolved?.text).toBe('warm low sun, hazy air');
    // Left out means "leave it alone", not "blank it".
    expect(resolved?.category).toBe('Lighting');
  });

  it('leaves additions alone', () => {
    const add: ProposedBlock = {
      action: 'add',
      name: 'Golden hour',
      category: 'Lighting',
      text: 'anything',
    };

    expect(resolveProposedBlocks([add], LIBRARY)).toEqual([add]);
  });

  it('honours an id when the model manages to send one', () => {
    const [resolved] = resolveProposedBlocks(
      [{ action: 'remove', id: 'overcast', name: 'nothing like it', category: '', text: '' }],
      LIBRARY,
    );

    expect(resolved?.id).toBe('overcast');
    expect(resolved?.name).toBe('Overcast');
  });
});

describe('blockLibrary', () => {
  it('lists what there is, grouped, with the wording of each', () => {
    const section = blockLibrary(LIBRARY);

    expect(section).toContain('**Lighting**');
    expect(section).toContain('**Camera**');
    expect(section).toContain('**Golden hour** — warm low sun, long shadows');
  });

  it('says so when there is nothing yet', () => {
    expect(blockLibrary([])).toContain('empty');
  });

  it('counts the ones it does not list', () => {
    const many = Array.from({ length: 70 }, (_, index) =>
      block(`Block ${index}`, 'Lighting', 'text', String(index)),
    );

    expect(blockLibrary(many)).toContain('And 10 more');
  });
});
