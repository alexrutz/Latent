import { useMemo, useState } from 'react';

import type { PromptBlock } from '@latent/shared';

import {
  useCreatePromptBlock,
  useDeletePromptBlock,
  usePromptBlocks,
} from '../api/queries';
import { Button, cn, ErrorNote, Sheet } from '../components/ui';

/**
 * Assemble a prompt from saved fragments instead of typing it.
 *
 * Writing a long, comma-separated prompt on a phone keyboard is the single most
 * tedious part of using ComfyUI from a mobile device. Storing the phrases you
 * reuse — a lighting setup, a camera, a style — turns that into a few taps.
 */
export function PromptBuilder({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const blocks = usePromptBlocks();

  const grouped = useMemo(() => {
    const map = new Map<string, PromptBlock[]>();
    for (const block of blocks.data ?? []) {
      const key = block.category || 'General';
      map.set(key, [...(map.get(key) ?? []), block]);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [blocks.data]);

  /** Append a fragment, keeping the comma-separated shape tidy. */
  const append = (text: string) => {
    const trimmed = value.trim().replace(/,\s*$/, '');
    onChange(trimmed ? `${trimmed}, ${text}` : text);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="self-start text-xs text-accent"
      >
        + Prompt blocks
      </button>

      <Sheet open={open} onClose={() => setOpen(false)} title="Prompt blocks" full>
        <div className="space-y-4">
          {/* What the prompt looks like right now, so tapping has visible effect. */}
          <div className="rounded-xl border border-line bg-surface-2 px-3 py-2">
            <p className="text-xs tracking-wide text-muted uppercase">Current prompt</p>
            <p className="mt-1 text-sm break-words">
              {value.trim() || <span className="text-muted">empty</span>}
            </p>
          </div>

          {grouped.length === 0 && (
            <p className="text-sm text-muted">
              No blocks saved yet. Add the phrases you type over and over — they become one-tap
              chips here.
            </p>
          )}

          {grouped.map(([category, items]) => (
            <div key={category} className="space-y-2">
              <p className="text-xs font-medium tracking-wide text-muted uppercase">{category}</p>
              <div className="flex flex-wrap gap-2">
                {items.map((block) => (
                  <button
                    key={block.id}
                    type="button"
                    onClick={() => append(block.text)}
                    title={block.text}
                    className="max-w-full truncate rounded-full border border-line bg-surface px-3 py-2 text-sm active:bg-surface-2"
                  >
                    {block.name}
                  </button>
                ))}
              </div>
            </div>
          ))}

          {/* No second "Done" here: the sheet header already has one, and two
              buttons with the same label in one view is just confusing. */}
          <div className="border-t border-line pt-3">
            <Button
              variant="ghost"
              className="w-full"
              disabled={value.trim() === ''}
              onClick={() => onChange('')}
            >
              Clear prompt
            </Button>
          </div>

          <BlockManager currentPrompt={value} />
        </div>
      </Sheet>
    </>
  );
}

/** Create and delete blocks, without leaving the builder. */
function BlockManager({ currentPrompt }: { currentPrompt: string }) {
  const blocks = usePromptBlocks();
  const create = useCreatePromptBlock();
  const remove = useDeletePromptBlock();

  const [name, setName] = useState('');
  const [category, setCategory] = useState('');
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [managing, setManaging] = useState(false);

  const save = async () => {
    setError(null);
    try {
      await create.mutateAsync({ name: name.trim(), text: text.trim(), category: category.trim() });
      setName('');
      setText('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save that block');
    }
  };

  return (
    <div className="space-y-3 border-t border-line pt-4">
      <button
        type="button"
        onClick={() => setManaging((current) => !current)}
        className="flex w-full items-center justify-between text-left"
      >
        <span className="text-xs font-medium tracking-wide text-muted uppercase">
          Manage blocks
        </span>
        <span className="text-xs text-muted">{managing ? 'Hide' : 'Show'}</span>
      </button>

      {managing && (
        <div className="space-y-3">
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Name, e.g. Golden hour"
            className="w-full rounded-xl border border-line bg-surface px-4 py-3 focus:border-accent focus:outline-none"
          />
          <input
            value={category}
            onChange={(event) => setCategory(event.target.value)}
            placeholder="Group (optional), e.g. Lighting"
            className="w-full rounded-xl border border-line bg-surface px-4 py-3 focus:border-accent focus:outline-none"
          />
          <textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            rows={2}
            placeholder="warm rim light, long shadows, low sun"
            className="w-full resize-none rounded-xl border border-line bg-surface px-4 py-3 focus:border-accent focus:outline-none"
          />

          <div className="flex gap-2">
            {/* Saving what is already typed is the fastest way to build a library. */}
            <Button
              variant="ghost"
              size="sm"
              disabled={currentPrompt.trim() === ''}
              onClick={() => setText(currentPrompt.trim())}
            >
              Use current prompt
            </Button>
            <Button
              variant="primary"
              size="sm"
              busy={create.isPending}
              disabled={name.trim() === '' || text.trim() === ''}
              onClick={save}
            >
              Save block
            </Button>
          </div>

          <ErrorNote>{error}</ErrorNote>

          <ul className="space-y-1">
            {(blocks.data ?? []).map((block) => (
              <li
                key={block.id}
                className={cn(
                  'flex items-center justify-between gap-3 rounded-xl border border-line px-3 py-2',
                )}
              >
                <div className="min-w-0">
                  <p className="truncate text-sm">{block.name}</p>
                  <p className="truncate text-xs text-muted">{block.text}</p>
                </div>
                <Button variant="ghost" size="sm" onClick={() => remove.mutate(block.id)}>
                  Delete
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
