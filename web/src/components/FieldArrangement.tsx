import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import {
  discreteValues,
  patchArranged,
  placeField,
  reorderArrangement,
  unplaceField,
  type ArrangedField,
  type FieldPoints,
  type FieldArrangement,
  type PoolField,
} from '@latent/shared';

import { api } from '../api/client';
import { queryKeys, useSettings, useUpdateSettings } from '../api/queries';
import { NumericInput } from './NumericInput';
import { SortableList, type DragHandleProps } from './SortableList';
import { Button, Sheet, Spinner, cn } from './ui';

/**
 * One form arrangement for every workflow.
 *
 * The per-workflow editor answers "how should *this* form read". This one
 * answers the question that was never askable: "where does `duration` go, in
 * everything". They are different questions and neither is the other — a
 * workflow with an unusual shape still wants its own editor, and an opinion
 * about a field that turns up in twelve workflows should not have to be typed
 * twelve times and then again for the thirteenth.
 *
 * Two areas side by side where there is room. On the left the arrangement: the
 * fields you have placed, in the order they will take, each with the attributes
 * to apply. On the right the pool: every field across the workflows in use,
 * with the ones that turn up most first, because those are the ones worth an
 * opinion. Neither is a list of *this* workflow's fields — that is the point.
 */
export function FieldArrangementSheet({ onClose }: { onClose: () => void }) {
  const settings = useSettings();
  const updateSettings = useUpdateSettings();
  const pool = useQuery({ queryKey: queryKeys.poolFields, queryFn: api.poolFields });

  const arrangement = settings.data?.fieldArrangement ?? [];
  const write = (next: FieldArrangement) => updateSettings.mutate({ fieldArrangement: next });

  const placed = useMemo(() => new Set(arrangement.map((entry) => entry.name)), [arrangement]);

  /*
   * What the arrangement names but no workflow in use has.
   *
   * Kept and shown rather than quietly dropped: a workflow switched off for the
   * afternoon, or a video pack not installed on this machine, would otherwise
   * silently delete an opinion that is about to matter again.
   */
  const known = useMemo(
    () => new Map((pool.data ?? []).map((entry) => [entry.name, entry])),
    [pool.data],
  );

  const unplaced = (pool.data ?? []).filter((entry) => !placed.has(entry.name));

  return (
    <Sheet open onClose={onClose} title="General arrangement" full wide>
      <div className="space-y-4">
        <p className="text-xs text-muted">
          One arrangement for every workflow, by what a field is called. A workflow without the
          field ignores it; a workflow with its own setting keeps it.
        </p>

        <div className="wide:grid wide:grid-cols-2 wide:items-start wide:gap-6">
          <section className="space-y-2">
            <h3 className="text-xs font-medium tracking-wide text-muted uppercase">
              Arranged {arrangement.length > 0 && `· ${arrangement.length}`}
            </h3>

            {arrangement.length === 0 ? (
              <p className="rounded-xl border border-dashed border-line px-3 py-6 text-center text-sm text-muted">
                Nothing arranged yet. Add a field from the pool.
              </p>
            ) : (
              <SortableList
                items={arrangement}
                idOf={(entry) => entry.name}
                onReorder={(names) => write(reorderArrangement(arrangement, names))}
                className="space-y-2"
              >
                {(entry, handle, dragging) => (
                  <ArrangedRow
                    entry={entry}
                    pool={known.get(entry.name)}
                    handle={handle}
                    dragging={dragging}
                    onPatch={(change) => write(patchArranged(arrangement, entry.name, change))}
                    onRemove={() => write(unplaceField(arrangement, entry.name))}
                  />
                )}
              </SortableList>
            )}
          </section>

          <section className="mt-4 space-y-2 wide:mt-0">
            <h3 className="text-xs font-medium tracking-wide text-muted uppercase">
              Every field in use
            </h3>

            {pool.isPending ? (
              <div className="grid place-items-center py-8">
                <Spinner className="size-6 text-muted" />
              </div>
            ) : unplaced.length === 0 ? (
              <p className="rounded-xl border border-dashed border-line px-3 py-6 text-center text-sm text-muted">
                {pool.data?.length === 0
                  ? 'No workflows are switched on, so there is nothing to arrange.'
                  : 'Every field is arranged.'}
              </p>
            ) : (
              <ul className="space-y-1">
                {unplaced.map((entry) => (
                  <li key={entry.name}>
                    <button
                      type="button"
                      aria-label={`Arrange ${entry.label}`}
                      onClick={() => write(placeField(arrangement, entry.name))}
                      className="flex w-full items-center gap-2 rounded-xl border border-line px-3 py-2 text-left active:bg-surface-2"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm">{entry.label}</span>
                        <span className="block truncate text-[11px] text-muted">
                          {entry.name} · in {entry.workflows}{' '}
                          {entry.workflows === 1 ? 'workflow' : 'workflows'}
                        </span>
                      </span>
                      <span aria-hidden className="shrink-0 text-muted">
                        +
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </Sheet>
  );
}

/**
 * One placed field.
 *
 * Every attribute here is optional in a way the per-workflow editor's are not:
 * "half a row" and "no opinion about the width" are different, and the second
 * has to stay reachable or the first workflow you arrange quietly takes over
 * the settings of every other. Hence a third state on each control — the one
 * that is on when nothing is chosen.
 */
function ArrangedRow({
  entry,
  pool,
  handle,
  dragging,
  onPatch,
  onRemove,
}: {
  entry: ArrangedField;
  pool: PoolField | undefined;
  handle: DragHandleProps;
  dragging: boolean;
  onPatch: (change: Partial<Omit<ArrangedField, 'name'>>) => void;
  onRemove: () => void;
}) {
  const name = pool?.label ?? entry.name;

  return (
    <div
      data-arranged={entry.name}
      className={cn(
        'rounded-xl border p-3',
        dragging ? 'border-accent bg-surface shadow-lg' : 'border-line',
        entry.hidden && 'opacity-60',
      )}
    >
      <div className="flex items-center gap-2">
        <span
          {...handle}
          role="button"
          aria-label={`Reorder ${name}`}
          className="grid size-9 shrink-0 cursor-grab place-items-center rounded-lg bg-surface-2 text-muted"
        >
          ⠿
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm">{name}</span>
          <span className="block truncate text-[11px] text-muted">
            {entry.name}
            {pool
              ? ` · in ${pool.workflows} ${pool.workflows === 1 ? 'workflow' : 'workflows'}`
              : ' · in none of the workflows switched on'}
          </span>
        </span>
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Stop arranging ${name}`}
          className="shrink-0 rounded-md bg-surface-2 px-2 py-1 text-[11px] text-muted"
        >
          Remove
        </button>
      </div>

      <div className="mt-2 space-y-1.5">
        <Choice
          label="Where"
          value={entry.group}
          options={[
            ['main', 'Main'],
            ['advanced', 'Advanced'],
          ]}
          field={name}
          onChange={(group) => onPatch({ group })}
          onClear={() => onPatch({ group: undefined })}
        />
        <Choice
          label="Width"
          value={entry.width}
          options={[
            ['half', 'Half'],
            ['full', 'Full row'],
          ]}
          field={name}
          onChange={(width) => onPatch({ width })}
          onClear={() => onPatch({ width: undefined })}
        />
        <Choice
          label="Shown"
          value={entry.hidden === undefined ? undefined : entry.hidden ? 'hidden' : 'shown'}
          options={[
            ['shown', 'Shown'],
            ['hidden', 'Hidden'],
          ]}
          field={name}
          onChange={(shown) => onPatch({ hidden: shown === 'hidden' })}
          onClear={() => onPatch({ hidden: undefined })}
        />

        {/*
          Only for numbers, and only when every workflow agrees it is one — see
          `PoolField.numeric`. Offering "slider or points" for a sampler name
          would be a control with no possible effect, which is worse than an
          absent one because it invites the belief that it was tried.

          Absent from the pool entirely — a field arranged before its workflow
          was switched off — is treated as numeric, because the alternative is
          silently dropping a choice somebody already made.
        */}
        {(pool?.numeric ?? true) && (
          <>
            <Choice
              label="Edited as"
              value={entry.inputMode}
              options={[
                ['input', 'Slider'],
                ['points', 'Points'],
              ]}
              field={name}
              onChange={(inputMode) => onPatch({ inputMode })}
              onClear={() => onPatch({ inputMode: undefined, points: undefined })}
            />
            {entry.inputMode === 'points' && (
              <PointRange
                field={name}
                points={entry.points}
                onChange={(points) => onPatch({ points })}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * The three numbers a point line offers.
 *
 * Spelled out rather than derived, because the arrangement has no single
 * field's range to derive from: the same `steps` is 1–150 in one workflow and
 * 1–10000 in another, and a line built from either would be wrong in the other.
 * Stating them is the only honest option — and it is also what makes one line
 * of points mean the same thing everywhere, which is the point of arranging it
 * generally at all.
 *
 * The values are shown underneath, so the answer to "what will this offer" is
 * on screen rather than arithmetic somebody has to do.
 */
function PointRange({
  field,
  points,
  onChange,
}: {
  field: string;
  points: FieldPoints | undefined;
  onChange: (points: FieldPoints) => void;
}) {
  const current: FieldPoints = points ?? { min: 20, max: 50, step: 10 };
  const preview = discreteValues(current.min, current.max, current.step);

  const set = (change: Partial<FieldPoints>) => onChange({ ...current, ...change });

  return (
    <div className="space-y-1 rounded-lg bg-surface-2 px-2 py-1.5">
      <div className="flex items-center gap-1.5">
        {(
          [
            ['min', 'from'],
            ['max', 'to'],
            ['step', 'step'],
          ] as const
        ).map(([key, word]) => (
          <label key={key} className="flex min-w-0 flex-1 items-center gap-1">
            <span className="text-[11px] text-muted">{word}</span>
            <NumericInput
              value={current[key]}
              onChange={(value) => set({ [key]: value } as Partial<FieldPoints>)}
              aria-label={`${field} points ${word}`}
              className="w-full min-w-0 rounded-md border border-line bg-surface px-1.5 py-1 text-[11px]"
            />
          </label>
        ))}
      </div>
      <p className="truncate text-[11px] text-muted">
        {preview.length > 0 ? preview.join(', ') : 'Nothing — check the range.'}
      </p>
    </div>
  );
}

/**
 * One attribute, with "no opinion" as a real choice rather than an absence.
 *
 * Three states, not two, and the third is the one that matters: "half a row"
 * and "nothing to say about the width" are different answers, and without a way
 * back to the second, arranging one attribute of a field would silently take
 * over the other two from every workflow that had settled them itself. So
 * **Leave it** is a button like the others and starts selected.
 */
function Choice<T extends string>({
  label,
  value,
  options,
  field,
  onChange,
  onClear,
}: {
  label: string;
  value: T | undefined;
  options: readonly (readonly [T, string])[];
  field: string;
  onChange: (value: T) => void;
  onClear: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[11px] text-muted">{label}</span>
      <div className="flex gap-1">
        <button
          type="button"
          aria-pressed={value === undefined}
          aria-label={`${field} ${label}: leave it to the workflow`}
          onClick={onClear}
          className={cn(
            'h-7 rounded-md px-2 text-[11px]',
            value === undefined ? 'bg-surface-3 text-body' : 'bg-surface-2 text-muted',
          )}
        >
          Leave it
        </button>
        {options.map(([option, text]) => (
          <button
            key={option}
            type="button"
            aria-pressed={value === option}
            aria-label={`${field} ${text}`}
            onClick={() => onChange(option)}
            className={cn(
              'h-7 rounded-md px-2.5 text-[11px]',
              value === option ? 'bg-accent text-white' : 'bg-surface-2 text-muted',
            )}
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}

/** The button that opens it, with a word about what is arranged so far. */
export function ArrangementButton() {
  const settings = useSettings();
  const [open, setOpen] = useState(false);
  const count = settings.data?.fieldArrangement?.length ?? 0;

  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        Arrange all {count > 0 && `· ${count}`}
      </Button>
      {open && <FieldArrangementSheet onClose={() => setOpen(false)} />}
    </>
  );
}
