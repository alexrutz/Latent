import { useMemo, useState } from 'react';

import { overlayChoices, shortLabels } from '@latent/shared';
import type { GenerationRecord, ParamSummaryItem } from '@latent/shared';

import { cn, Sheet } from './ui';

/**
 * Showing a run's settings on top of the picture itself.
 *
 * The whole point is not having to open anything. Comparing eight results of a
 * step sweep means reading eight numbers, and tapping into each one to find them
 * loses the comparison — so the numbers go on the thumbnails, as small as they
 * can be and still be read.
 *
 * Two independent selections, because the two places have different room: a
 * thumbnail gets `St20 C8`, the full-size viewer gets room for a few more.
 */

/**
 * The values to show for one record, in the order they were chosen.
 *
 * Falls back to deriving from the raw values for runs recorded before summaries
 * existed — the label is then just the input name, which is still better than a
 * blank overlay.
 */
export function overlayValues(record: GenerationRecord, keys: string[]): ParamSummaryItem[] {
  const byKey = new Map(record.params.map((item) => [item.key, item]));

  return keys
    .map((key) => {
      const recorded = byKey.get(key);
      if (recorded) return recorded;

      const raw = record.values[key];
      if (raw === undefined || raw === null || raw === '') return null;
      return {
        key,
        label: key.split('.').pop() ?? key,
        value: String(raw),
        primary: true,
      } satisfies ParamSummaryItem;
    })
    .filter((item): item is ParamSummaryItem => item !== null);
}

/**
 * The compact form: a value, optionally prefixed by a two-letter abbreviation.
 *
 * Sized to fit inside a thumbnail without covering the picture, which is why the
 * label is abbreviated rather than dropped — three bare numbers in a row are
 * unreadable, but `St20 C8 Se4471` parses at a glance.
 */
export function ParamOverlayLine({
  items,
  withLabels,
  compact = false,
}: {
  items: ParamSummaryItem[];
  withLabels: boolean;
  compact?: boolean;
}) {
  const abbreviations = useMemo(
    () => shortLabels(items.map((item) => item.label)),
    [items],
  );

  if (items.length === 0) return null;

  return (
    <p
      data-testid="param-overlay"
      className={cn(
        'flex flex-wrap gap-x-1.5 gap-y-0.5 tabular-nums',
        compact ? 'text-[9px] leading-tight' : 'text-[11px]',
      )}
    >
      {items.map((item) => (
        <span key={item.key} className="max-w-full truncate">
          {withLabels && (
            <span className="text-white/55">{abbreviations[item.label] ?? item.label}</span>
          )}
          <span className="text-white/95">{item.value}</span>
        </span>
      ))}
    </p>
  );
}

/**
 * The picker itself: a small button that opens a list of what can be shown.
 *
 * Multi-select, and the order of selection is the order on screen — so the value
 * you care about most can be first.
 */
export function ParamOverlayPicker({
  label,
  records,
  selected,
  withLabels,
  onChange,
  onWithLabelsChange,
}: {
  label: string;
  records: GenerationRecord[];
  selected: string[];
  withLabels: boolean;
  onChange: (keys: string[]) => void;
  onWithLabelsChange: (value: boolean) => void;
}) {
  const [open, setOpen] = useState(false);

  const choices = useMemo(
    () => overlayChoices(records.map((record) => record.params)),
    [records],
  );

  const toggle = (key: string) =>
    onChange(selected.includes(key) ? selected.filter((k) => k !== key) : [...selected, key]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={label}
        className={cn(
          'flex h-7 shrink-0 items-center gap-1 rounded-full px-2 text-[11px]',
          selected.length > 0 ? 'bg-accent/20 text-accent' : 'bg-surface text-muted',
        )}
      >
        <span aria-hidden>ⓘ</span>
        {selected.length > 0 && <span className="tabular-nums">{selected.length}</span>}
        <span aria-hidden className="opacity-60">
          ▾
        </span>
      </button>

      <Sheet open={open} onClose={() => setOpen(false)} title={label}>
        <div className="space-y-3">
          <p className="text-xs text-muted">
            Chosen values are drawn over the picture, in the order you pick them.
          </p>

          {choices.length === 0 ? (
            <p className="py-4 text-sm text-muted">
              Nothing to show yet. Runs record their settings as they are queued, so this fills up
              once you generate something.
            </p>
          ) : (
            <>
              <ul className="space-y-1">
                {choices.map((choice) => {
                  const position = selected.indexOf(choice.key);
                  const picked = position >= 0;
                  return (
                    <li key={choice.key}>
                      <button
                        type="button"
                        onClick={() => toggle(choice.key)}
                        aria-pressed={picked}
                        className={cn(
                          'flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-sm',
                          picked ? 'bg-accent/15 text-accent' : 'active:bg-surface-2',
                        )}
                      >
                        <span className="min-w-0 truncate">{choice.label}</span>
                        {picked && (
                          <span className="shrink-0 text-xs tabular-nums">#{position + 1}</span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>

              <div className="flex items-center justify-between gap-3 border-t border-line pt-3">
                <div className="min-w-0">
                  <p className="text-sm">Short labels</p>
                  <p className="text-[11px] text-muted">
                    Off: bare numbers only, for the tightest fit.
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={withLabels}
                  aria-label="Short labels"
                  onClick={() => onWithLabelsChange(!withLabels)}
                  className={cn(
                    'relative h-7 w-12 shrink-0 rounded-full transition-colors',
                    withLabels ? 'bg-accent' : 'bg-surface-3',
                  )}
                >
                  <span
                    className={cn(
                      'absolute top-1 size-5 rounded-full bg-white transition-transform',
                      withLabels ? 'translate-x-6' : 'translate-x-1',
                    )}
                  />
                </button>
              </div>

              {selected.length > 0 && (
                <button
                  type="button"
                  onClick={() => onChange([])}
                  className="w-full py-2 text-center text-xs text-accent"
                >
                  Show none
                </button>
              )}
            </>
          )}
        </div>
      </Sheet>
    </>
  );
}
