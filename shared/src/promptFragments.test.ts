import { describe, expect, it } from 'vitest';

import {
  addFragment,
  joinPrompt,
  promptContainsFragment,
  removeFragment,
  splitPrompt,
  toggleFragment,
} from './promptFragments.js';

describe('splitPrompt / joinPrompt', () => {
  it('trims parts and drops empties', () => {
    expect(splitPrompt('  a ,  b ,, c  ')).toEqual(['a', 'b', 'c']);
    expect(splitPrompt('')).toEqual([]);
    expect(splitPrompt(' , , ')).toEqual([]);
  });

  it('joins with a comma and a space', () => {
    expect(joinPrompt(['a', 'b'])).toBe('a, b');
    expect(joinPrompt([])).toBe('');
  });
});

describe('promptContainsFragment', () => {
  it('finds a fragment anywhere in the prompt', () => {
    expect(promptContainsFragment('a castle, warm rim light, at dusk', 'warm rim light')).toBe(true);
    expect(promptContainsFragment('a castle', 'warm rim light')).toBe(false);
  });

  it('ignores case and irregular whitespace', () => {
    expect(promptContainsFragment('a castle, Warm  Rim   Light', 'warm rim light')).toBe(true);
  });

  it('requires every part of a multi-part fragment', () => {
    const fragment = 'warm rim light, long shadows';
    expect(promptContainsFragment('a castle, warm rim light, long shadows', fragment)).toBe(true);
    // Only half of it is there, so the block is not "applied".
    expect(promptContainsFragment('a castle, warm rim light', fragment)).toBe(false);
  });

  it('does not match a fragment that is merely a substring of a part', () => {
    // "light" must not count as present just because "warm rim light" is.
    expect(promptContainsFragment('a castle, warm rim light', 'light')).toBe(false);
  });

  it('treats an empty fragment as absent', () => {
    expect(promptContainsFragment('a castle', '')).toBe(false);
  });
});

describe('addFragment', () => {
  it('appends to an existing prompt', () => {
    expect(addFragment('a castle', 'at dusk')).toBe('a castle, at dusk');
  });

  it('is the whole prompt when there was nothing', () => {
    expect(addFragment('', 'at dusk')).toBe('at dusk');
    expect(addFragment('   ', 'at dusk')).toBe('at dusk');
  });

  it('never duplicates something already present', () => {
    expect(addFragment('a castle, at dusk', 'at dusk')).toBe('a castle, at dusk');
    expect(addFragment('a castle, At Dusk', 'at dusk')).toBe('a castle, At Dusk');
  });

  it('adds only the missing parts of a multi-part fragment', () => {
    expect(addFragment('a castle, long shadows', 'warm rim light, long shadows')).toBe(
      'a castle, long shadows, warm rim light',
    );
  });

  it('tidies sloppy punctuation on the way in', () => {
    expect(addFragment('a castle,', 'at dusk')).toBe('a castle, at dusk');
    expect(addFragment('a castle ,, ', 'at dusk')).toBe('a castle, at dusk');
  });
});

describe('removeFragment', () => {
  it('takes a fragment back out, leaving the rest intact', () => {
    expect(removeFragment('a castle, at dusk, moody', 'at dusk')).toBe('a castle, moody');
  });

  it('removes every part of a multi-part fragment', () => {
    expect(removeFragment('a castle, warm rim light, long shadows, moody', 'warm rim light, long shadows')).toBe(
      'a castle, moody',
    );
  });

  it('is a no-op when the fragment is not there', () => {
    expect(removeFragment('a castle', 'at dusk')).toBe('a castle');
  });

  it('can empty the prompt entirely', () => {
    expect(removeFragment('at dusk', 'at dusk')).toBe('');
  });
});

describe('toggleFragment', () => {
  it('adds then removes on successive calls', () => {
    const fragment = 'warm rim light';
    const once = toggleFragment('a castle', fragment);
    expect(once).toBe('a castle, warm rim light');

    const twice = toggleFragment(once, fragment);
    expect(twice).toBe('a castle');

    // And back again, so the chip is a stable toggle.
    expect(toggleFragment(twice, fragment)).toBe(once);
  });

  it('round-trips a multi-part block', () => {
    const fragment = 'warm rim light, long shadows';
    const applied = toggleFragment('a castle', fragment);
    expect(applied).toBe('a castle, warm rim light, long shadows');
    expect(toggleFragment(applied, fragment)).toBe('a castle');
  });

  it('removes a block the user typed by hand rather than adding a duplicate', () => {
    expect(toggleFragment('a castle, at dusk', 'at dusk')).toBe('a castle');
  });
});
