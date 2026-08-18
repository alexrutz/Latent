import { describe, expect, it } from 'vitest';

import { parseMarkdown, parseSpans } from './markdown.js';

/**
 * Models write Markdown whether or not you ask them to, and a chat that shows
 * the asterisks looks broken. What matters here is that the common shapes are
 * read and that everything else survives unharmed — a parser that mangles the
 * text it does not understand is worse than one that renders nothing.
 */

/** The plain text of a block, ignoring how it is marked. */
const flat = (spans: { text: string }[]) => spans.map((span) => span.text).join('');

describe('blocks', () => {
  it('separates paragraphs on a blank line', () => {
    const blocks = parseMarkdown('First one.\n\nSecond one.');
    expect(blocks).toHaveLength(2);
    expect(blocks.every((block) => block.kind === 'paragraph')).toBe(true);
  });

  it('keeps a hard-wrapped paragraph as one block', () => {
    const blocks = parseMarkdown('a line\nand another');
    expect(blocks).toHaveLength(1);
  });

  it('reads headings at every level', () => {
    const blocks = parseMarkdown('# One\n\n### Three');
    expect(blocks).toMatchObject([
      { kind: 'heading', level: 1 },
      { kind: 'heading', level: 3 },
    ]);
  });

  it('reads both kinds of list', () => {
    const bullets = parseMarkdown('- one\n- two');
    expect(bullets[0]).toMatchObject({ kind: 'list', ordered: false });
    expect((bullets[0] as { items: { text: string }[][] }).items).toHaveLength(2);

    const numbers = parseMarkdown('1. one\n2. two');
    expect(numbers[0]).toMatchObject({ kind: 'list', ordered: true });
  });

  it('joins a wrapped list item onto the item it belongs to', () => {
    const [list] = parseMarkdown('- a rather long item\n  that wrapped\n- the next one');
    const items = (list as { items: { text: string }[][] }).items;
    expect(items).toHaveLength(2);
    expect(flat(items[0]!)).toBe('a rather long item that wrapped');
  });

  it('takes a fenced block whole, markup and blank lines included', () => {
    const [block] = parseMarkdown('```py\nif x:\n\n  # not a heading\n```');
    expect(block).toEqual({
      kind: 'code',
      language: 'py',
      text: 'if x:\n\n  # not a heading',
    });
  });

  /** Half a reply is what a stream looks like before it finishes. */
  it('closes an unterminated fence at the end', () => {
    const [block] = parseMarkdown('```\nstill arriving');
    expect(block).toMatchObject({ kind: 'code', text: 'still arriving' });
  });

  it('reads a quote spanning several lines as one', () => {
    const [block] = parseMarkdown('> one\n> two');
    expect(block).toMatchObject({ kind: 'quote' });
    expect(flat((block as { spans: { text: string }[] }).spans)).toBe('one\ntwo');
  });

  it('reads a rule', () => {
    expect(parseMarkdown('---')).toEqual([{ kind: 'rule' }]);
  });
});

describe('inline marks', () => {
  it('reads bold, italic and code', () => {
    expect(parseSpans('a **b** c *d* e `f`')).toEqual([
      { text: 'a ' },
      { text: 'b', bold: true },
      { text: ' c ' },
      { text: 'd', italic: true },
      { text: ' e ' },
      { text: 'f', code: true },
    ]);
  });

  it('nests marks', () => {
    expect(parseSpans('**bold with *italic* inside**')).toEqual([
      { text: 'bold with ', bold: true },
      { text: 'italic', bold: true, italic: true },
      { text: ' inside', bold: true },
    ]);
  });

  /** A run of three, which read as bold would leave a stray asterisk behind. */
  it('reads a triple marker as both marks', () => {
    expect(parseSpans('***both***')).toEqual([{ text: 'both', bold: true, italic: true }]);
  });

  /** The point of backticks: what is inside them is text. */
  it('does not mark up the inside of code', () => {
    expect(parseSpans('`**not bold**`')).toEqual([{ text: '**not bold**', code: true }]);
  });

  it('reads a link and keeps its target', () => {
    expect(parseSpans('see [the docs](https://example.com/x) now')).toEqual([
      { text: 'see ' },
      { text: 'the docs', href: 'https://example.com/x' },
      { text: ' now' },
    ]);
  });

  /**
   * Underscores inside a word are a filename, not emphasis. Getting this wrong
   * turns `some_file_name` into `somefilename` with a stray italic in the
   * middle, which is exactly the kind of quiet corruption worth a test.
   */
  it('leaves underscores inside a word alone', () => {
    expect(parseSpans('a some_file_name here')).toEqual([{ text: 'a some_file_name here' }]);
  });

  it('leaves an unmatched marker as the character it is', () => {
    expect(parseSpans('2 * 3 = 6')).toEqual([{ text: '2 * 3 = 6' }]);
    expect(parseSpans('a ~~ b')).toEqual([{ text: 'a ~~ b' }]);
  });

  it('returns plain text unchanged', () => {
    expect(parseSpans('nothing to see')).toEqual([{ text: 'nothing to see' }]);
  });
});
