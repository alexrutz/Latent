/**
 * What changed between one prompt and the next.
 *
 * Iterating on a prompt means changing a clause and leaving the rest alone, and
 * two paragraphs of near-identical prose are genuinely hard to compare by eye —
 * which is how you end up regenerating something you meant to change and not
 * noticing. Marking the difference turns that into a glance.
 *
 * Word-level rather than character-level: a character diff on prose produces
 * highlighted fragments inside words, which is noise. Whitespace rides along
 * with the word before it, so concatenating the `same` and `added` parts gives
 * back the new prompt exactly. The `removed` parts are context rather than a
 * second document — where the two prompts differ only in spacing or case, the
 * new spelling is what is kept, so the old side does not round-trip.
 */

export type DiffKind = 'same' | 'added' | 'removed';

export interface DiffPart {
  kind: DiffKind;
  text: string;
}

/**
 * Split into words, each carrying the whitespace that follows it.
 *
 * Keeping the trailing space attached is what lets the parts be concatenated
 * back into the original — a renderer that had to re-insert spaces would get
 * the ones around punctuation wrong.
 */
function tokenise(text: string): string[] {
  return text.match(/\S+\s*/g) ?? [];
}

/** The word a token is, for comparison: no surrounding space, no case. */
function key(token: string): string {
  return token.trim().toLowerCase();
}

/**
 * The longest common subsequence of two token lists, as a table of lengths.
 *
 * The textbook dynamic program. Prompts are a paragraph — a few hundred words
 * at the very most — so the quadratic table costs nothing worth optimising
 * away, and the alternatives are all more code for the same answer.
 */
function lcsTable(a: string[], b: string[]): number[][] {
  const table: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );

  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i]![j] =
        key(a[i]!) === key(b[j]!)
          ? table[i + 1]![j + 1]! + 1
          : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }

  return table;
}

/**
 * How `next` differs from `previous`.
 *
 * Adjacent parts of the same kind are merged, so a run of new words is one
 * highlight rather than six. With no previous prompt everything is `same`:
 * a first prompt has not changed from anything, and marking all of it would
 * say nothing.
 */
export function diffPrompts(previous: string, next: string): DiffPart[] {
  if (previous.trim() === '') return next === '' ? [] : [{ kind: 'same', text: next }];

  const before = tokenise(previous);
  const after = tokenise(next);
  const table = lcsTable(before, after);

  const parts: DiffPart[] = [];
  const push = (kind: DiffKind, text: string) => {
    if (text === '') return;
    const last = parts[parts.length - 1];
    if (last?.kind === kind) last.text += text;
    else parts.push({ kind, text });
  };

  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (key(before[i]!) === key(after[j]!)) {
      // The *new* spelling wins on a case-only difference: this describes what
      // the next prompt says, not what the last one did.
      push('same', after[j]!);
      i += 1;
      j += 1;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      push('removed', before[i]!);
      i += 1;
    } else {
      push('added', after[j]!);
      j += 1;
    }
  }

  while (i < before.length) push('removed', before[i++]!);
  while (j < after.length) push('added', after[j++]!);

  return parts;
}

/** True when anything at all is different. Cheaper to read than a length check. */
export function hasChanges(parts: DiffPart[]): boolean {
  return parts.some((part) => part.kind !== 'same');
}
