import { useMemo } from 'react';

import { diffPrompts, hasChanges } from '@latent/shared';

import { cn } from './ui';

/**
 * A prompt with what changed since the last one marked on it.
 *
 * Iterating means changing a clause and leaving the rest, and two paragraphs of
 * near-identical prose are genuinely hard to compare by eye — which is how you
 * regenerate something you meant to change and do not notice. The colours are
 * the whole feature; the text underneath is the new prompt exactly.
 *
 * Removed words are struck through rather than hidden. They are context: "dawn
 * became dusk" is one glance, while "dusk is new" leaves you working out what
 * it replaced.
 */
export function PromptDiff({
  previous,
  next,
  className,
}: {
  previous: string;
  next: string;
  className?: string;
}) {
  const parts = useMemo(() => diffPrompts(previous, next), [previous, next]);

  return (
    <p className={cn('text-sm leading-relaxed break-words whitespace-pre-wrap', className)}>
      {parts.map((part, index) => (
        <span
          key={index}
          className={cn(
            part.kind === 'added' && 'rounded-sm bg-success/20 text-success',
            part.kind === 'removed' && 'text-danger/70 line-through',
          )}
        >
          {part.text}
        </span>
      ))}
    </p>
  );
}

/** Whether marking this pair would say anything. */
export function promptChanged(previous: string, next: string): boolean {
  return previous.trim() !== '' && hasChanges(diffPrompts(previous, next));
}
