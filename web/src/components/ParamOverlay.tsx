import { useMemo, useState } from 'react';

import { overlayChoices, shortLabels, TEXT_OVERLAY_PREFIX } from '@latent/shared';
import type { GenerationRecord, ParamSummaryItem } from '@latent/shared';

import { Toggle } from './ParamControl';
import { cn, CONTROL_FACE, CONTROL_FACE_SET, Sheet } from './ui';

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

      // Text a node produced, chosen by the node's title.
      if (key.startsWith(TEXT_OVERLAY_PREFIX)) {
        const title = key.slice(TEXT_OVERLAY_PREFIX.length);
        const said = record.texts.filter((output) => output.nodeTitle === title);
        if (said.length === 0) return null;
        return {
          key,
          label: title,
          value: said.map((output) => output.text).join(' · '),
          primary: true,
        } satisfies ParamSummaryItem;
      }

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
        'flex max-w-full flex-wrap gap-x-1.5 gap-y-0.5 tabular-nums',
        compact ? 'text-[9px] leading-tight' : 'text-[11px]',
      )}
    >
      {items.map((item) => (
        <span
          key={item.key}
          /*
           * `min-w-0` is the one that matters: a flex item defaults to
           * `min-width: auto`, so a single long token — which is exactly what a
           * model's answer or a file path is — pushes the line wider than the
           * screen and the whole page starts panning sideways.
           */
          className={cn(
            'min-w-0 max-w-full',
            item.key.startsWith(TEXT_OVERLAY_PREFIX)
              ? 'break-words [overflow-wrap:anywhere]'
              : 'truncate',
          )}
        >
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
  caption,
  records,
  selected,
  withLabels,
  onChange,
  onWithLabelsChange,
  className,
}: {
  label: string;
  /**
   * A word under the glyph, for callers that lay their buttons out in a column.
   *
   * Without it the column stacked the glyph, the count and the caret into three
   * rows, which made this one button taller than every other cell in the bar and
   * cost a strip of the picture underneath.
   */
  caption?: string;
  records: GenerationRecord[];
  selected: string[];
  withLabels: boolean;
  onChange: (keys: string[]) => void;
  onWithLabelsChange: (value: boolean) => void;
  /** Lets a caller size it like the buttons it sits among. */
  className?: string;
}) {
  const [open, setOpen] = useState(false);

  const choices = useMemo(
    () =>
      overlayChoices(
        records.map((record) => record.params),
        records.flatMap((record) => record.texts),
      ),
    [records],
  );

  /*
   * Chosen values that these runs know nothing about.
   *
   * Switching workflow does this: a value you picked when you were using one
   * graph is not among the choices the next graph offers, so it vanished from
   * the list while staying switched on — selected, invisible, and impossible to
   * turn off. They are listed here so a choice can always be undone where it
   * was made.
   */
  const orphans = useMemo(
    () => selected.filter((key) => !choices.some((choice) => choice.key === key)),
    [selected, choices],
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
          'flex h-9 shrink-0 items-center gap-1 rounded-full px-2.5 text-[11px] leading-none',
          // Visible as a control, not only as a glyph: see `CONTROL_FACE`.
          selected.length > 0 ? CONTROL_FACE_SET : CONTROL_FACE,
          className,
        )}
      >
        <span aria-hidden className="text-base leading-none">
          ⓘ
        </span>
        {/* One row, whichever way the button is laid out. */}
        <span className="flex max-w-full items-center gap-0.5 truncate leading-none">
          {caption && <span className="truncate text-[9px]">{caption}</span>}
          {selected.length > 0 && <span className="tabular-nums">{selected.length}</span>}
          <span aria-hidden className="opacity-60">
            ▾
          </span>
        </span>
      </button>

      <Sheet open={open} onClose={() => setOpen(false)} title={label}>
        <div className="space-y-3">
          <p className="text-xs text-muted">
            Chosen values are drawn over the picture, in the order you pick them.
          </p>

          {choices.length === 0 && orphans.length === 0 ? (
            <p className="py-4 text-sm text-muted">
              Nothing to show yet. Runs record their settings as they are queued, so this fills up
              once you generate something.
            </p>
          ) : (
            <>
              {/* Two columns: this list is as long as the workflow has knobs,
                  and one name per row turns a choice into a scroll. */}
              <ul data-testid="overlay-choices" className="grid grid-cols-2 gap-1">
                {choices.map((choice) => (
                  <ChoiceRow
                    key={choice.key}
                    itemKey={choice.key}
                    label={choice.label}
                    position={selected.indexOf(choice.key)}
                    onToggle={toggle}
                  />
                ))}
                {orphans.map((key) => (
                  <ChoiceRow
                    key={key}
                    itemKey={key}
                    label={orphanLabel(key)}
                    position={selected.indexOf(key)}
                    absent
                    onToggle={toggle}
                  />
                ))}
              </ul>

              {orphans.length > 0 && (
                <p className="text-[11px] text-warn">
                  Dimmed values are not recorded by these runs — from another workflow, most
                  likely. Tap to stop showing them.
                </p>
              )}

              {/*
                The shared switch, not one of its own.

                This used to be a hand-rolled copy, and its knob sat outside the
                track — which made the sheet wider than the screen and left the
                whole panel draggable sideways. One switch, fixed once.
              */}
              <div className="flex items-center justify-between gap-3 border-t border-line pt-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm">Short labels</p>
                  <p className="text-[11px] text-muted">
                    Off: bare numbers only, for the tightest fit.
                  </p>
                </div>
                <Toggle
                  checked={withLabels}
                  onChange={onWithLabelsChange}
                  label="Short labels"
                />
              </div>
            </>
          )}

          {/* Outside the list on purpose: the one time you most need this is
              when the list no longer contains what is switched on. */}
          {selected.length > 0 && (
            <button
              type="button"
              onClick={() => onChange([])}
              className="w-full py-2 text-center text-xs text-accent"
            >
              Show none
            </button>
          )}
        </div>
      </Sheet>
    </>
  );
}

function ChoiceRow({
  itemKey,
  label,
  position,
  absent = false,
  onToggle,
}: {
  itemKey: string;
  label: string;
  position: number;
  absent?: boolean;
  onToggle: (key: string) => void;
}) {
  const picked = position >= 0;

  return (
    <li className="min-w-0">
      <button
        type="button"
        onClick={() => onToggle(itemKey)}
        aria-pressed={picked}
        className={cn(
          'flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left text-xs',
          picked ? 'bg-accent/15 text-accent' : 'bg-surface-2/60 active:bg-surface-2',
          absent && 'opacity-50',
        )}
      >
        <span className="min-w-0 truncate">{label}</span>
        {picked && <span className="shrink-0 text-[10px] tabular-nums">#{position + 1}</span>}
      </button>
    </li>
  );
}

/** The best name we can give a key no run in view describes. */
function orphanLabel(key: string): string {
  if (key.startsWith(TEXT_OVERLAY_PREFIX)) return key.slice(TEXT_OVERLAY_PREFIX.length);
  return key.split('.').pop() ?? key;
}
