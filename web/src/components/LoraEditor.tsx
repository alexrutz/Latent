import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';

import { parseLoraTags, removeLoraTag, serializeLoraTags, updateLoraTag } from '@latent/shared';
import type { LoraTag } from '@latent/shared';

import { api } from '../api/client';
import { NumericInput } from './NumericInput';
import { Button, cn, Sheet, Spinner } from './ui';

/**
 * Structured editing of `<lora:name:0.8>` tags held in a text field.
 *
 * Typing those by hand is the single most tedious thing about driving a
 * LoRA-heavy workflow from a phone: you have to remember exact filenames and
 * punctuate a tag correctly on a keyboard with no easy `<` or `:`. The text
 * field remains the source of truth — this just edits it.
 */
export function LoraEditor({
  value,
  onChange,
  label = 'LoRAs',
  /**
   * Keep the full editor visible even with nothing in it.
   *
   * True for a field that exists solely to hold LoRAs. False under a prompt,
   * where a permanent empty LoRA panel would be clutter on every plain
   * text-to-image workflow — those get a single unobtrusive button instead.
   */
  alwaysShow = false,
}: {
  value: string;
  onChange: (next: string) => void;
  label?: string;
  alwaysShow?: boolean;
}) {
  const [picking, setPicking] = useState(false);
  const parsed = useMemo(() => parseLoraTags(value), [value]);

  const setTags = (tags: LoraTag[]) => onChange(serializeLoraTags(value, tags));

  const picker = (
    <LoraPicker
      open={picking}
      onClose={() => setPicking(false)}
      onPick={(name) => {
        setTags([...parsed.tags, { name, strength: 1 }]);
        setPicking(false);
      }}
      alreadyUsed={parsed.tags.map((tag) => tag.name)}
    />
  );

  if (parsed.tags.length === 0 && !alwaysShow) {
    return (
      <>
        <button
          type="button"
          onClick={() => setPicking(true)}
          className="-mt-1 self-start text-xs text-accent"
        >
          + Add a LoRA
        </button>
        {picker}
      </>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium tracking-wide text-muted uppercase">{label}</span>
        <Button variant="ghost" size="sm" onClick={() => setPicking(true)}>
          + Add
        </Button>
      </div>

      {parsed.tags.length === 0 ? (
        <button
          type="button"
          onClick={() => setPicking(true)}
          className="w-full rounded-xl border border-dashed border-line px-3 py-3 text-sm text-muted active:bg-surface-2"
        >
          No LoRAs — tap to add one
        </button>
      ) : (
        <ul className="space-y-1.5">
          {/*
            One row per LoRA. These used to be tall cards with their own slider
            underneath, which pushed the prompt and the sampler settings off
            screen for something that is rarely the thing you came to adjust.
          */}
          {/*
            A grid, not a flex row. With flex, a long filename and a fixed-width
            slider fight over the same space and the slider is the one that loses
            — it ran off the right edge of the screen. Here the name gets one
            column that can shrink to nothing and the controls get theirs, so the
            slider is always fully on screen no matter how the LoRA is named.
          */}
          {parsed.tags.map((tag, index) => (
            <li
              key={`${tag.name}-${index}`}
              className="grid grid-cols-[minmax(0,1fr)_5.5rem_2.5rem_1.75rem] items-center gap-1.5 rounded-lg border border-line bg-surface px-2 py-1"
            >
              <span className="min-w-0 truncate text-xs" title={tag.name}>
                {prettyName(tag.name)}
              </span>
              <input
                type="range"
                min={-1}
                max={2}
                step={0.05}
                value={tag.strength}
                onChange={(event) =>
                  setTags(updateLoraTag(parsed.tags, index, { strength: Number(event.target.value) }))
                }
                aria-label={`${tag.name} strength slider`}
                className="h-7 w-full min-w-0 accent-[var(--color-accent)]"
              />
              <NumericInput
                value={tag.strength}
                onChange={(strength) => setTags(updateLoraTag(parsed.tags, index, { strength }))}
                min={-4}
                max={4}
                step={0.05}
                aria-label={`${tag.name} strength`}
                className="w-full min-w-0 border-0 bg-transparent px-0 py-0.5 text-right text-sm"
              />
              <button
                type="button"
                onClick={() => setTags(removeLoraTag(parsed.tags, index))}
                aria-label={`Remove ${tag.name}`}
                className="grid size-7 place-items-center justify-self-end rounded-md text-muted active:bg-surface-2"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}

      {/*
        The exact string that goes to ComfyUI, and editable.

        It used to be a readout only, which was fine while the assumption held
        that a field like this contains `<lora:name:0.8>` tags. It does not:
        the LoRA manager nodes have a syntax of their own, and for those the
        structured rows above find nothing and there was then no way to type
        anything at all — the field simply had no input. The text is the source
        of truth, so it gets to be edited. Collapsed to a line by default;
        tapping opens it.
      */}
      {alwaysShow && <RawField value={value} onChange={onChange} />}

      {picker}
    </div>
  );
}

function prettyName(name: string): string {
  return (name.split(/[\\/]/).pop() ?? name).replace(/\.(safetensors|ckpt|pt)$/i, '');
}

/** One line of the field's literal contents, expandable when you need all of it. */
function RawField({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-expanded={false}
        aria-label="Raw field value"
        className="block w-full text-left"
      >
        <span className="block truncate rounded-md bg-surface-2 px-2 py-1 font-mono text-[10px] leading-snug text-muted">
          {value.trim() === '' ? 'empty — tap to type' : value}
        </span>
      </button>
    );
  }

  return (
    <div className="space-y-1">
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        rows={3}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        aria-label="Raw field value"
        className="w-full resize-none rounded-md border border-line bg-surface px-2 py-1 font-mono text-[11px] leading-snug focus:border-accent focus:outline-none"
      />
      <button
        type="button"
        onClick={() => setOpen(false)}
        className="text-[11px] text-accent"
      >
        Done
      </button>
    </div>
  );
}

function LoraPicker({
  open,
  onClose,
  onPick,
  alreadyUsed,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (name: string) => void;
  alreadyUsed: string[];
}) {
  const [filter, setFilter] = useState('');
  const [manual, setManual] = useState('');

  // Only fetched when the sheet actually opens — the list can be large.
  const loras = useQuery({ queryKey: ['loras'], queryFn: api.loras, enabled: open });

  const filtered = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const all = loras.data ?? [];
    return needle ? all.filter((name) => name.toLowerCase().includes(needle)) : all;
  }, [filter, loras.data]);

  return (
    <Sheet open={open} onClose={onClose} title="Add a LoRA" full>
      <div className="space-y-3">
        <input
          type="search"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filter…"
          className="w-full rounded-xl border border-line bg-surface px-4 py-3 focus:border-accent focus:outline-none"
        />

        {loras.isLoading && (
          <div className="grid place-items-center py-8">
            <Spinner className="size-5 text-muted" />
          </div>
        )}

        <ul className="space-y-1">
          {filtered.map((name) => {
            const used = alreadyUsed.includes(name);
            return (
              <li key={name}>
                <button
                  type="button"
                  disabled={used}
                  onClick={() => onPick(name)}
                  className={cn(
                    'flex w-full items-center justify-between gap-3 rounded-xl px-4 py-3 text-left',
                    used ? 'text-muted opacity-50' : 'active:bg-surface-2',
                  )}
                >
                  <span className="min-w-0 truncate">{prettyName(name)}</span>
                  {used && <span className="shrink-0 text-xs">added</span>}
                </button>
              </li>
            );
          })}
        </ul>

        {/*
          The server may not expose a model list (older ComfyUI has no
          /models/{folder}), and a LoRA can be referenced before it is
          installed. Never make the picker the only way in.
        */}
        {!loras.isLoading && filtered.length === 0 && (
          <p className="px-1 py-2 text-sm text-muted">
            {loras.data?.length
              ? `Nothing matches “${filter}”.`
              : 'ComfyUI did not return a LoRA list. Type the filename instead.'}
          </p>
        )}

        <div className="space-y-2 border-t border-line pt-3">
          <span className="text-xs tracking-wide text-muted uppercase">Or type a filename</span>
          <div className="flex gap-2">
            <input
              value={manual}
              onChange={(event) => setManual(event.target.value)}
              placeholder="my_lora.safetensors"
              className="min-w-0 flex-1 rounded-xl border border-line bg-surface px-4 py-3 focus:border-accent focus:outline-none"
            />
            <Button
              variant="primary"
              disabled={manual.trim() === ''}
              onClick={() => {
                onPick(manual.trim());
                setManual('');
              }}
            >
              Add
            </Button>
          </div>
        </div>
      </div>
    </Sheet>
  );
}
