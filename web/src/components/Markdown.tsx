import { Fragment, useMemo } from 'react';

import { parseMarkdown } from '@latent/shared';
import type { MarkdownBlock, MarkdownSpan } from '@latent/shared';

import { cn } from './ui';

/**
 * A model's reply, as the Markdown it was written in.
 *
 * Rendered from a parsed tree into React elements, never through
 * `dangerouslySetInnerHTML`: the text comes from a model, and a model repeating
 * something it read on the internet is exactly the case where injected HTML
 * would matter. Building elements means there is no HTML to inject into.
 *
 * The type scale is deliberately flat. A chat reply is a few paragraphs on a
 * phone; headings that step up in size the way an article's do just make one
 * message shout over the others, so a heading here is weight and spacing.
 */
export function Markdown({ text, className }: { text: string; className?: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);

  return (
    <div className={cn('space-y-2 text-sm leading-relaxed break-words', className)}>
      {blocks.map((block, index) => (
        <Block key={index} block={block} />
      ))}
    </div>
  );
}

function Block({ block }: { block: MarkdownBlock }) {
  switch (block.kind) {
    case 'heading':
      return (
        <p className={cn('font-semibold', block.level <= 2 ? 'text-[15px]' : 'text-sm')}>
          <Spans spans={block.spans} />
        </p>
      );

    case 'code':
      return (
        // Scrolls inside itself rather than widening the message: one long line
        // of code otherwise makes the whole conversation pan sideways.
        <pre className="overflow-x-auto rounded-lg bg-surface-2 px-3 py-2 text-xs leading-relaxed">
          <code>{block.text}</code>
        </pre>
      );

    case 'quote':
      return (
        <blockquote className="border-l-2 border-line pl-3 text-muted">
          <Spans spans={block.spans} />
        </blockquote>
      );

    case 'rule':
      return <hr className="border-line" />;

    case 'list':
      return (
        <ul className="space-y-1">
          {block.items.map((item, index) => (
            <li key={index} className="flex gap-2">
              <span className="shrink-0 text-muted tabular-nums">
                {block.ordered ? `${index + 1}.` : '•'}
              </span>
              <span className="min-w-0 flex-1">
                <Spans spans={item} />
              </span>
            </li>
          ))}
        </ul>
      );

    default:
      return (
        // `whitespace-pre-wrap` so a hard-wrapped paragraph keeps its breaks,
        // which is how a model lays out a short list it did not mark up.
        <p className="whitespace-pre-wrap">
          <Spans spans={block.spans} />
        </p>
      );
  }
}

function Spans({ spans }: { spans: MarkdownSpan[] }) {
  return (
    <>
      {spans.map((span, index) => {
        const content = span.code ? (
          <code className="rounded bg-surface-2 px-1 py-0.5 text-[0.85em]">{span.text}</code>
        ) : (
          span.text
        );

        const marked = (
          <span
            className={cn(
              span.bold && 'font-semibold',
              span.italic && 'italic',
              span.strike && 'line-through',
            )}
          >
            {content}
          </span>
        );

        if (span.href) {
          return (
            <a
              key={index}
              href={span.href}
              target="_blank"
              // `noreferrer` as much as `noopener`: the link came from a model,
              // and the page it opens has no business knowing where it came
              // from.
              rel="noopener noreferrer"
              className="text-accent underline"
            >
              {marked}
            </a>
          );
        }

        return <Fragment key={index}>{marked}</Fragment>;
      })}
    </>
  );
}
