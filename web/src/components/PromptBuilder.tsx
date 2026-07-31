import { useMemo, useState } from 'react';

import { promptContainsFragment, toggleFragment } from '@latent/shared';
import type { PromptBlock } from '@latent/shared';

import { useCreatePromptBlock, usePromptBlocks } from '../api/queries';
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
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const blocks = usePromptBlocks();
  const create = useCreatePromptBlock();

  const saveBlock = async () => {
    setError(null);
    try {
      await create.mutateAsync({ name: name.trim(), text: value.trim() });
      setName('');
      setSaving(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save that block');
    }
  };

  const grouped = useMemo(() => {
    const map = new Map<string, PromptBlock[]>();
    for (const block of blocks.data ?? []) {
      const key = block.category || 'General';
      map.set(key, [...(map.get(key) ?? []), block]);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [blocks.data]);

  /**
   * Chips are toggles.
   *
   * A block only makes sense once in a prompt, so a second tap has to take it
   * back out — otherwise the only way to undo a mis-tap is to find the phrase in
   * the text and delete it by hand, which is exactly the typing this feature
   * exists to avoid.
   */
  const toggle = (text: string) => onChange(toggleFragment(value, text));

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
              No blocks saved yet. The <strong className="text-body">Blocks</strong> tab is where
              you add the phrases you type over and over; they become one-tap chips here.
            </p>
          )}

          {grouped.map(([category, items]) => (
            <div key={category} className="space-y-2">
              <p className="text-xs font-medium tracking-wide text-muted uppercase">{category}</p>
              <div className="flex flex-wrap gap-2">
                {items.map((block) => {
                  const active = promptContainsFragment(value, block.text);
                  return (
                    <button
                      key={block.id}
                      type="button"
                      onClick={() => toggle(block.text)}
                      title={block.text}
                      aria-pressed={active}
                      className={cn(
                        'flex max-w-full items-center gap-1.5 rounded-full border px-3 py-2 text-sm',
                        active
                          ? 'border-accent bg-accent/20 text-accent'
                          : 'border-line bg-surface active:bg-surface-2',
                      )}
                    >
                      <span className="truncate">{block.name}</span>
                      {/* Says which way the next tap goes. */}
                      <span aria-hidden className="shrink-0 text-xs opacity-70">
                        {active ? '✓' : '+'}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}

          {/* No second "Done" here: the sheet header already has one, and two
              buttons with the same label in one view is just confusing. */}
          <div className="flex gap-2 border-t border-line pt-3">
            <Button
              variant="ghost"
              className="flex-1"
              disabled={value.trim() === ''}
              onClick={() => onChange('')}
            >
              Clear prompt
            </Button>
            {/*
              Making a block out of what is on screen is worth keeping here —
              it is the fastest way a library ever gets built. Everything else
              about managing blocks lives in the Blocks tab.
            */}
            <Button
              variant="secondary"
              className="flex-1"
              busy={create.isPending}
              disabled={value.trim() === ''}
              onClick={() => setSaving(true)}
            >
              Save as block
            </Button>
          </div>

          {saving && (
            <div className="space-y-2 rounded-xl border border-line p-3">
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Name, e.g. Golden hour"
                aria-label="New block name"
                className="w-full rounded-xl border border-line bg-surface px-4 py-3 focus:border-accent focus:outline-none"
              />
              <ErrorNote>{error}</ErrorNote>
              <div className="flex gap-2">
                <Button variant="ghost" size="sm" onClick={() => setSaving(false)}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  busy={create.isPending}
                  disabled={name.trim() === ''}
                  onClick={saveBlock}
                >
                  Save
                </Button>
              </div>
            </div>
          )}
        </div>
      </Sheet>
    </>
  );
}
