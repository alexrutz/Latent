import { useState } from 'react';

import { usePromptBlocks, usePromptMode, useUpdatePromptMode } from '../api/queries';
import { cn, Sheet } from './ui';

/**
 * The blocks that go on every prompt.
 *
 * Distinct from tapping chips into the text: a quality tail or a house style is
 * not part of *this* picture's description, it is part of every request you
 * make, and re-adding it each time is the tedium the whole block library exists
 * to remove. Chosen here, appended on the server at submit time, so it lands on
 * a drawn prompt just as surely as a typed one.
 */
export function AlwaysBlocks() {
  const mode = usePromptMode();
  const update = useUpdatePromptMode();
  const blocks = usePromptBlocks();
  const [open, setOpen] = useState(false);

  const chosen = mode.data?.alwaysBlockIds ?? [];
  const library = blocks.data ?? [];
  // Only the ones that still exist: a deleted block must not be counted.
  const active = library.filter((block) => chosen.includes(block.id));

  const toggle = (id: string) => {
    const next = chosen.includes(id) ? chosen.filter((item) => item !== id) : [...chosen, id];
    update.mutate({ alwaysBlockIds: next });
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex min-w-0 items-center gap-1 self-start text-xs text-accent"
      >
        <span className="truncate">
          {active.length === 0
            ? '+ Always append'
            : `Always: ${active.map((block) => block.name).join(', ')}`}
        </span>
        <span aria-hidden className="shrink-0 opacity-70">
          ▾
        </span>
      </button>

      <Sheet open={open} onClose={() => setOpen(false)} title="Always append">
        <div className="space-y-3">
          <p className="text-xs text-muted">
            These go on the end of every prompt — typed or drawn — without being tapped in each
            time.
          </p>

          {library.length === 0 ? (
            <p className="text-sm text-muted">
              No blocks yet. The <strong className="text-body">Blocks</strong> tab is where they are
              made.
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {library.map((block) => {
                const on = chosen.includes(block.id);
                return (
                  <button
                    key={block.id}
                    type="button"
                    title={block.text}
                    aria-pressed={on}
                    onClick={() => toggle(block.id)}
                    className={cn(
                      'flex max-w-full items-center gap-1.5 rounded-full border px-3 py-2 text-sm',
                      on
                        ? 'border-accent bg-accent/20 text-accent'
                        : 'border-line bg-surface active:bg-surface-2',
                    )}
                  >
                    <span className="truncate">{block.name}</span>
                    <span aria-hidden className="shrink-0 text-xs opacity-70">
                      {on ? '✓' : '+'}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {active.length > 0 && (
            <div className="rounded-xl border border-line bg-surface-2 px-3 py-2">
              <p className="text-[11px] tracking-wide text-muted uppercase">Appended to everything</p>
              <p className="mt-1 text-xs break-words">
                {active.map((block) => block.text).join(', ')}
              </p>
            </div>
          )}
        </div>
      </Sheet>
    </>
  );
}
