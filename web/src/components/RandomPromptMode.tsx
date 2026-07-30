import { useMemo, useState } from 'react';

import { randomPromptPool } from '@latent/shared';
import type { PromptBlock, RandomPromptConfig, RandomPromptRoll } from '@latent/shared';

import { api } from '../api/client';
import { usePromptBlocks, usePromptMode, useUpdatePromptMode } from '../api/queries';
import { Toggle } from './ParamControl';
import { Button, cn, ErrorNote, Sheet, Spinner } from './ui';

/**
 * Random prompt mode.
 *
 * Once you have a library of phrases, the interesting thing to do with it is not
 * picking four by hand — it is letting the machine pick four and seeing what
 * comes out, again and again, without touching the keyboard between runs.
 *
 * The draw itself happens on the server, once per queued item, so a batch of
 * eight is eight different pictures rather than the same prompt eight times. This
 * sheet only configures it, and previews it by asking the server for example
 * draws through the same code path a real submit uses.
 */
export function RandomPromptMode({ base }: { base: string }) {
  const [open, setOpen] = useState(false);
  const mode = usePromptMode();
  const enabled = mode.data?.enabled ?? false;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-pressed={enabled}
        className={cn('self-start text-xs', enabled ? 'text-accent' : 'text-muted')}
      >
        🎲 {enabled ? 'Random prompt on' : 'Random prompt'}
      </button>

      {open && <RandomPromptSheet base={base} onClose={() => setOpen(false)} />}
    </>
  );
}

function RandomPromptSheet({ base, onClose }: { base: string; onClose: () => void }) {
  const mode = usePromptMode();
  const update = useUpdatePromptMode();
  const blocks = usePromptBlocks();

  const [rolls, setRolls] = useState<RandomPromptRoll[] | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const config = mode.data;
  const library = blocks.data ?? [];

  const grouped = useMemo(() => {
    const map = new Map<string, PromptBlock[]>();
    for (const block of library) {
      const key = block.category || 'Ungrouped';
      map.set(key, [...(map.get(key) ?? []), block]);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [library]);

  const patch = (change: Partial<RandomPromptConfig>) => {
    setError(null);
    // Stale previews are worse than none: they would show draws from settings
    // that are no longer in force.
    setRolls(null);
    update.mutate(change, {
      onError: (cause) =>
        setError(cause instanceof Error ? cause.message : 'Could not save that setting'),
    });
  };

  const preview = async () => {
    if (!config) return;
    setPreviewing(true);
    setError(null);
    try {
      const result = await api.previewPromptMode(base, config);
      setRolls(result.rolls);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not draw a preview');
    } finally {
      setPreviewing(false);
    }
  };

  if (!config) {
    return (
      <Sheet open onClose={onClose} title="Random prompt" full>
        <div className="grid place-items-center py-12">
          <Spinner className="size-6 text-muted" />
        </div>
      </Sheet>
    );
  }

  const pool = randomPromptPool(library, config);
  const narrowed = config.blockIds.length > 0;

  return (
    <Sheet open onClose={onClose} title="Random prompt" full>
      <div className="space-y-4">
        <div className="flex items-center justify-between rounded-xl border border-line bg-surface px-3 py-2">
          <div className="min-w-0">
            <p className="text-sm">Draw the prompt</p>
            <p className="text-xs text-muted">
              Every queued run gets its own draw, so a batch varies.
            </p>
          </div>
          <Toggle
            checked={config.enabled}
            onChange={(next) => patch({ enabled: next })}
            label="Draw the prompt"
          />
        </div>

        {library.length === 0 && (
          <p className="text-sm text-muted">
            No prompt blocks saved yet. There is nothing to draw from — save a few phrases under
            Prompt blocks first.
          </p>
        )}

        {library.length > 0 && (
          <>
            <div className="space-y-2">
              <p className="text-xs font-medium tracking-wide text-muted uppercase">
                Blocks per prompt
              </p>
              <div className="flex items-center gap-2">
                <CountPicker
                  label="At least"
                  value={config.minBlocks}
                  max={Math.max(1, pool.length)}
                  onChange={(minBlocks) => patch({ minBlocks })}
                />
                <CountPicker
                  label="At most"
                  value={config.maxBlocks}
                  max={Math.max(1, pool.length)}
                  onChange={(maxBlocks) => patch({ maxBlocks })}
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <OptionRow
                label="Keep what I typed"
                hint="Off: the prompt is built only from blocks."
                checked={config.keepTyped}
                onChange={(keepTyped) => patch({ keepTyped })}
              />
              <OptionRow
                label="One block per group"
                hint="Stops two lighting styles landing in the same prompt."
                checked={config.onePerGroup}
                onChange={(onePerGroup) => patch({ onePerGroup })}
              />
            </div>

            {/*
              The pool. Empty selection means the whole library, which is both the
              default and the thing you want most of the time — narrowing is for
              when you have blocks that belong to a different kind of picture.
            */}
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-medium tracking-wide text-muted uppercase">
                  Pool ({pool.length} of {library.length})
                </p>
                {narrowed && (
                  <button
                    type="button"
                    onClick={() => patch({ blockIds: [] })}
                    className="text-xs text-accent"
                  >
                    Use all blocks
                  </button>
                )}
              </div>
              <p className="text-xs text-muted">
                {narrowed
                  ? 'Drawing from the blocks you picked.'
                  : 'Drawing from every block. Tap any to narrow it down.'}
              </p>

              {grouped.map(([group, items]) => (
                <div key={group} className="space-y-1.5">
                  <p className="text-[11px] tracking-wide text-muted uppercase">{group}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {items.map((block) => {
                      // With no explicit pool every block is in, so the chips show
                      // "all selected" rather than "none" — which is the truth.
                      const picked = narrowed ? config.blockIds.includes(block.id) : true;
                      return (
                        <button
                          key={block.id}
                          type="button"
                          title={block.text}
                          aria-pressed={picked}
                          onClick={() => patch({ blockIds: toggleId(config, library, block.id) })}
                          className={cn(
                            'flex max-w-full items-center gap-1 rounded-full border px-2.5 py-1 text-xs',
                            picked
                              ? 'border-accent bg-accent/20 text-accent'
                              : 'border-line bg-surface text-muted',
                          )}
                        >
                          <span className="truncate">{block.name}</span>
                          <span aria-hidden className="shrink-0 opacity-70">
                            {picked ? '✓' : '+'}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>

            <ErrorNote>{error}</ErrorNote>

            {/* Seeing three examples before committing eight renders to it. */}
            <div className="space-y-2 border-t border-line pt-3">
              <Button
                variant="secondary"
                className="w-full"
                busy={previewing}
                disabled={pool.length === 0}
                onClick={preview}
              >
                Draw three examples
              </Button>

              {rolls && (
                <ul className="space-y-1.5" data-testid="random-prompt-preview">
                  {rolls.map((roll, index) => (
                    <li
                      key={index}
                      className="rounded-lg border border-line bg-surface-2 px-3 py-2 text-xs"
                    >
                      <p className="break-words">{roll.prompt || <span className="text-muted">empty</span>}</p>
                      {roll.blocks.length > 0 && (
                        <p className="mt-1 truncate text-[11px] text-muted">
                          {roll.blocks.map((block) => block.name).join(' · ')}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              )}

              {pool.length === 0 && (
                <p className="text-xs text-warn">
                  The pool is empty, so nothing would be drawn and your typed prompt would be used
                  unchanged.
                </p>
              )}
            </div>
          </>
        )}
      </div>
    </Sheet>
  );
}

/**
 * Turn a chip tap into the next pool.
 *
 * The subtlety: an empty `blockIds` means "everything", so the first tap on a
 * chip has to mean "everything except this one" rather than "only this one" —
 * otherwise tapping a chip that already looks selected would deselect the other
 * twenty, which is the opposite of what the tap said.
 */
function toggleId(config: RandomPromptConfig, library: PromptBlock[], id: string): string[] {
  const current = config.blockIds.length > 0 ? config.blockIds : library.map((block) => block.id);
  const next = current.includes(id)
    ? current.filter((candidate) => candidate !== id)
    : [...current, id];

  // Back to the whole library: store that as "no pool" so blocks added later are
  // included automatically.
  return next.length === library.length ? [] : next;
}

function CountPicker({
  label,
  value,
  max,
  onChange,
}: {
  label: string;
  value: number;
  max: number;
  onChange: (value: number) => void;
}) {
  const options = Array.from({ length: Math.min(max, 8) }, (_unused, index) => index + 1);

  return (
    <div className="min-w-0 flex-1 space-y-1">
      <p className="text-[11px] text-muted">{label}</p>
      <div className="flex flex-wrap gap-1">
        {options.map((option) => (
          <button
            key={option}
            type="button"
            aria-label={`${label} ${option}`}
            aria-pressed={value === option}
            onClick={() => onChange(option)}
            className={cn(
              'size-7 rounded-md text-xs tabular-nums',
              value === option ? 'bg-accent text-white' : 'bg-surface-2 text-muted',
            )}
          >
            {option}
          </button>
        ))}
      </div>
    </div>
  );
}

function OptionRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-line bg-surface px-3 py-1.5">
      <div className="min-w-0">
        <p className="text-sm">{label}</p>
        <p className="truncate text-[11px] text-muted">{hint}</p>
      </div>
      <Toggle checked={checked} onChange={onChange} label={label} />
    </div>
  );
}
