/**
 * A small, deliberate subset of Markdown.
 *
 * Models write Markdown whether or not you ask them to — `**this**`, a numbered
 * list, the occasional fenced block — and showing it raw makes a reply look
 * like a bug. So it is parsed. What it is *not* is a general Markdown engine:
 *
 * - Parsing to a tree that the UI renders as React elements means no HTML is
 *   ever constructed, so there is nothing for a model's output to inject into.
 *   A full engine would hand back a string and the sanitising problem with it.
 * - The subset is what actually turns up in a chat reply. Tables, footnotes,
 *   reference links and setext headings do not, and every construct that is
 *   parsed is a construct that can be got wrong.
 *
 * Anything unrecognised is left as the text it was, which is the right failure:
 * a stray `~~` reads as two tildes rather than as a missing feature.
 */

/** A run of text with the marks that apply to it. */
export interface MarkdownSpan {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  strike?: boolean;
  /** Set on a link; `text` is what it reads as. */
  href?: string;
}

export type MarkdownBlock =
  | { kind: 'paragraph'; spans: MarkdownSpan[] }
  | { kind: 'heading'; level: number; spans: MarkdownSpan[] }
  | { kind: 'code'; language: string; text: string }
  | { kind: 'quote'; spans: MarkdownSpan[] }
  | { kind: 'rule' }
  | { kind: 'list'; ordered: boolean; items: MarkdownSpan[][] };

const FENCE = /^\s{0,3}(?:```|~~~)\s*(\S*)/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*)$/;
const BULLET = /^\s{0,3}[-*+]\s+(.*)$/;
const NUMBERED = /^\s{0,3}(\d{1,9})[.)]\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const RULE = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;

/**
 * Split text into blocks.
 *
 * Line-based, because every block this cares about is decided by how its first
 * line starts. The one exception is a fenced code block, which owns every line
 * until its closing fence — including blank ones, and including lines that look
 * like other blocks.
 */
export function parseMarkdown(source: string): MarkdownBlock[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];

  const flush = () => {
    if (paragraph.length === 0) return;
    blocks.push({ kind: 'paragraph', spans: parseSpans(paragraph.join('\n')) });
    paragraph = [];
  };

  for (let at = 0; at < lines.length; at += 1) {
    const line = lines[at]!;

    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      at += 1;
      // An unclosed fence runs to the end, which is what a half-streamed reply
      // looks like — and showing it as code is better than showing the ```.
      while (at < lines.length && !FENCE.test(lines[at]!)) {
        body.push(lines[at]!);
        at += 1;
      }
      blocks.push({ kind: 'code', language: fence[1] ?? '', text: body.join('\n') });
      continue;
    }

    if (line.trim() === '') {
      flush();
      continue;
    }

    if (RULE.test(line)) {
      flush();
      blocks.push({ kind: 'rule' });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      blocks.push({
        kind: 'heading',
        level: heading[1]!.length,
        spans: parseSpans(heading[2]!.trim()),
      });
      continue;
    }

    const quote = QUOTE.exec(line);
    if (quote) {
      flush();
      const body = [quote[1]!];
      while (at + 1 < lines.length && QUOTE.test(lines[at + 1]!)) {
        at += 1;
        body.push(QUOTE.exec(lines[at]!)![1]!);
      }
      blocks.push({ kind: 'quote', spans: parseSpans(body.join('\n')) });
      continue;
    }

    const bullet = BULLET.exec(line);
    const numbered = NUMBERED.exec(line);
    if (bullet || numbered) {
      flush();
      const ordered = numbered !== null;
      const items: MarkdownSpan[][] = [];
      for (;;) {
        const current = lines[at]!;
        const match = ordered ? NUMBERED.exec(current) : BULLET.exec(current);
        if (!match) break;
        // A wrapped item is an indented line under it, not a new one.
        const text = [ordered ? match[2]! : match[1]!];
        while (
          at + 1 < lines.length &&
          /^\s{2,}\S/.test(lines[at + 1]!) &&
          !BULLET.test(lines[at + 1]!) &&
          !NUMBERED.test(lines[at + 1]!)
        ) {
          at += 1;
          text.push(lines[at]!.trim());
        }
        items.push(parseSpans(text.join(' ')));
        if (at + 1 >= lines.length) break;
        at += 1;
      }
      blocks.push({ kind: 'list', ordered, items });
      continue;
    }

    paragraph.push(line);
  }

  flush();
  return blocks;
}

/**
 * The inline marks, in the order a tie is broken.
 *
 * Code first, so `` `**not bold**` `` stays literal. `***both***` before the
 * two-marker forms, because a run of three read as bold would leave a stray
 * asterisk behind. Bold allows a lone `*` inside it — that is what makes
 * `**bold with *italic* inside**` nest instead of stopping at the first inner
 * marker.
 *
 * This is not CommonMark's delimiter-run algorithm and does not try to be:
 * genuinely ambiguous runs like `**a *b***` are rare in a chat reply and cost
 * far more to get exactly right than they are worth here.
 */
const INLINE: { pattern: RegExp; marks: Omit<MarkdownSpan, 'text'> }[] = [
  { pattern: /`([^`]+)`/, marks: { code: true } },
  { pattern: /\*\*\*([^*]+)\*\*\*/, marks: { bold: true, italic: true } },
  { pattern: /\*\*((?:[^*]|\*(?!\*))+)\*\*/, marks: { bold: true } },
  { pattern: /__((?:[^_]|_(?!_))+)__/, marks: { bold: true } },
  { pattern: /(?<![*\w])\*([^*\n]+)\*(?!\*)/, marks: { italic: true } },
  { pattern: /(?<![_\w])_([^_\n]+)_(?!_)/, marks: { italic: true } },
  { pattern: /~~([^~]+)~~/, marks: { strike: true } },
];

const LINK = /\[([^\]\n]+)\]\(([^)\s]+)\)/;

/**
 * Split one run of text into marked spans.
 *
 * Recursive on purpose: the earliest mark wins, its contents are parsed again
 * so nesting works, and everything after it is parsed again too. Code is the
 * exception — what is inside backticks is text, not markup, which is the whole
 * point of backticks.
 */
export function parseSpans(text: string, inherited: Omit<MarkdownSpan, 'text'> = {}): MarkdownSpan[] {
  if (text === '') return [];

  interface Found {
    at: number;
    length: number;
    inner: string;
    extra: Omit<MarkdownSpan, 'text'>;
  }

  const candidates: Found[] = [];
  for (const { pattern, marks } of INLINE) {
    const match = pattern.exec(text);
    if (match) {
      candidates.push({
        at: match.index,
        length: match[0].length,
        inner: match[1] ?? '',
        extra: marks,
      });
    }
  }
  const link = LINK.exec(text);
  if (link) {
    candidates.push({
      at: link.index,
      length: link[0].length,
      inner: link[1] ?? '',
      extra: { href: link[2] },
    });
  }

  // Earliest wins; on a tie the order of INLINE decides, which is why code
  // comes first there — `**a `b` c**` should read as bold containing code.
  const found = candidates.reduce<Found | null>(
    (best, candidate) => (best === null || candidate.at < best.at ? candidate : best),
    null,
  );
  if (!found) return [{ ...inherited, text }];

  const spans: MarkdownSpan[] = [];
  if (found.at > 0) spans.push({ ...inherited, text: text.slice(0, found.at) });

  const marks = { ...inherited, ...found.extra };
  if (found.extra.code) {
    // Literal by definition.
    spans.push({ ...marks, text: found.inner });
  } else {
    spans.push(...parseSpans(found.inner, marks));
  }

  spans.push(...parseSpans(text.slice(found.at + found.length), inherited));
  return spans.filter((span) => span.text !== '');
}
