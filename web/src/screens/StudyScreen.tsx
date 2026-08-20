import { useEffect, useMemo, useRef, useState } from 'react';

import {
  DISTRIBUTIONS,
  SAMPLINGS,
  describeSignificance,
  factorLevels,
  levelLabel,
  playsInAudioElement,
  playsInVideoElement,
} from '@latent/shared';
import type {
  CategoricalFactor,
  FactorResult,
  NumericFactor,
  ParamField,
  StudyDetail,
  StudyDistribution,
  StudyFactor,
  StudyRating,
  StudySamplingName,
  StudySummary,
} from '@latent/shared';

import { imageUrl } from '../api/client';
import {
  useCreateStudy,
  useDeleteStudy,
  useKeepStudyShot,
  useNextStudyShot,
  useRateStudyShot,
  useStudies,
  useStudy,
  useStudyFields,
  useStudyPreview,
  useStudyRun,
  useStudyStats,
  useUpdateStudy,
  useWorkflows,
} from '../api/queries';
import { NumericInput } from '../components/NumericInput';
import { Button, Card, cn, EmptyState, ErrorNote, Sheet, Spinner } from '../components/ui';
import { useBlur } from '../state/blur';

/**
 * Parameter studies.
 *
 * The rest of the app is built around making *a* picture. This is the opposite:
 * it makes hundreds on purpose, all nearly the same, and the pictures are not
 * the output — the answer to "which of these settings actually matters" is.
 *
 * Two phases, deliberately apart. Rendering is a long unattended stretch the
 * machine does on its own; rating is a short attentive one you do with your
 * thumb. Doing them together would mean forming an opinion about a parameter
 * while still choosing its values, which is how you confirm what you already
 * believed instead of finding anything out.
 */

/** How costly a factor is to change, as words rather than a number. */
const COSTS: { value: number; label: string; hint: string }[] = [
  { value: 0, label: 'Free', hint: 'steps, CFG, a seed' },
  { value: 1, label: 'Slight', hint: 'resolution' },
  { value: 3, label: 'Costly', hint: 'a LoRA' },
  { value: 5, label: 'Very costly', hint: 'a checkpoint' },
];

/* ------------------------------------------------------------------ */
/* Setting a study up                                                  */
/* ------------------------------------------------------------------ */

/**
 * Which of a workflow's fields can be varied, and how.
 *
 * A combo field varies over the options ComfyUI advertises, so a model list or
 * a sampler list needs no typing at all. A numeric field varies over a range.
 * Everything else — prompts, image inputs — is held constant: a study that
 * varies the prompt is not a study of the settings, it is a different picture
 * every time and nothing is comparable.
 */
function candidateFields(fields: ParamField[]): ParamField[] {
  return fields.filter(
    (field) =>
      field.control === 'combo' ||
      field.control === 'boolean' ||
      field.control === 'int' ||
      field.control === 'float',
  );
}

/** A first guess at a factor for a field, so adding one is a single tap. */
function defaultFactor(field: ParamField): StudyFactor {
  if (field.control === 'combo' || field.control === 'boolean') {
    const levels =
      field.control === 'boolean' ? [true, false] : (field.options ?? []).slice(0, 8);
    return {
      kind: 'categorical',
      key: field.id,
      label: field.label,
      levels,
      /*
       * A model list is guessed as expensive, because it almost always is —
       * and getting this wrong the other way costs an afternoon of loading
       * checkpoints one shot at a time.
       */
      cost: field.role === 'model' ? 5 : field.role === 'lora' ? 3 : 0,
    };
  }

  /*
   * The soft range, not the hard one. `/object_info` advertises steps up to
   * 10000, and a study spanning that would spend most of its shots somewhere
   * nobody has ever set it.
   */
  const min = field.softMin ?? field.min ?? 0;
  const max = field.softMax ?? field.max ?? Math.max(min + 1, Number(field.defaultValue) || 1);

  return {
    kind: 'numeric',
    key: field.id,
    label: field.label,
    min,
    max,
    quantise: { mode: 'samples', count: 5 },
    distribution: 'uniform',
    integer: field.control === 'int',
    cost: field.role === 'width' || field.role === 'height' ? 1 : 0,
  };
}

function FactorEditor({
  factor,
  onChange,
  onRemove,
}: {
  factor: StudyFactor;
  onChange: (next: StudyFactor) => void;
  onRemove: () => void;
}) {
  const levels = factorLevels(factor);

  return (
    <Card className="space-y-3">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{factor.label}</span>
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Stop varying ${factor.label}`}
          className="shrink-0 rounded-lg px-2 py-1 text-xs text-muted active:bg-surface-2"
        >
          Remove
        </button>
      </div>

      {factor.kind === 'numeric' ? (
        <NumericFactorFields factor={factor} onChange={onChange} />
      ) : (
        <CategoricalFactorFields factor={factor} onChange={onChange} />
      )}

      {/*
        The levels, spelled out.

        A range plus a sample count is two numbers that do not obviously mean
        "10, 20, 30, 40, 50" — and getting that wrong is a study of the wrong
        thing, discovered after it has finished rendering.
      */}
      <div className="space-y-1">
        <p className="text-[11px] tracking-wide text-muted uppercase">
          {levels.length} value{levels.length === 1 ? '' : 's'}
        </p>
        <div className="flex flex-wrap gap-1">
          {levels.slice(0, 12).map((level) => (
            <span
              key={String(level)}
              className="max-w-full truncate rounded-md bg-surface-2 px-1.5 py-0.5 text-[11px] text-muted"
            >
              {levelLabel(level)}
            </span>
          ))}
          {levels.length > 12 && (
            <span className="px-1 py-0.5 text-[11px] text-muted">+{levels.length - 12}</span>
          )}
        </div>
      </div>

      {/*
        How expensive it is to change this between shots.

        This is the one setting that decides whether a study takes an afternoon
        or a weekend: the plan is ordered so the dearest factors change least
        often, so 200 shots over four checkpoints load four checkpoints rather
        than two hundred.
      */}
      <div className="space-y-1">
        <p className="text-[11px] tracking-wide text-muted uppercase">Cost to change</p>
        <div className="flex gap-1">
          {COSTS.map((cost) => (
            <button
              key={cost.value}
              type="button"
              aria-pressed={factor.cost === cost.value}
              onClick={() => onChange({ ...factor, cost: cost.value })}
              className={cn(
                'flex-1 rounded-lg px-1 py-1.5 text-[11px]',
                factor.cost === cost.value ? 'bg-accent text-white' : 'bg-surface-2 text-muted',
              )}
            >
              {cost.label}
            </button>
          ))}
        </div>
      </div>
    </Card>
  );
}

function NumericFactorFields({
  factor,
  onChange,
}: {
  factor: NumericFactor;
  onChange: (next: StudyFactor) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <NumericInput
          value={factor.min}
          onChange={(min) => onChange({ ...factor, min })}
          aria-label={`${factor.label} lowest`}
          className="min-w-0 flex-1"
        />
        <span className="shrink-0 text-xs text-muted">to</span>
        <NumericInput
          value={factor.max}
          onChange={(max) => onChange({ ...factor, max })}
          aria-label={`${factor.label} highest`}
          className="min-w-0 flex-1"
        />
      </div>

      {/*
        Two ways to say the same thing, because both are how people think.
        "Try five values" when you want a fixed budget; "every 5" when the
        spacing is what matters.
      */}
      <div className="flex gap-2">
        <div className="flex shrink-0 gap-1">
          {(['samples', 'interval'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              aria-pressed={factor.quantise.mode === mode}
              onClick={() =>
                onChange({
                  ...factor,
                  quantise:
                    mode === 'samples' ? { mode, count: 5 } : { mode, step: 1 },
                })
              }
              className={cn(
                'rounded-lg px-2 py-1.5 text-[11px]',
                factor.quantise.mode === mode ? 'bg-accent text-white' : 'bg-surface-2 text-muted',
              )}
            >
              {mode === 'samples' ? 'Count' : 'Step'}
            </button>
          ))}
        </div>
        <NumericInput
          value={factor.quantise.mode === 'samples' ? factor.quantise.count : factor.quantise.step}
          onChange={(value) =>
            onChange({
              ...factor,
              quantise:
                factor.quantise.mode === 'samples'
                  ? { mode: 'samples', count: value }
                  : { mode: 'interval', step: value },
            })
          }
          aria-label={factor.quantise.mode === 'samples' ? 'How many values' : 'Step between values'}
          className="min-w-0 flex-1"
        />
      </div>

      <div className="space-y-1">
        <p className="text-[11px] tracking-wide text-muted uppercase">Spread</p>
        <div className="grid grid-cols-2 gap-1">
          {DISTRIBUTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={factor.distribution === option.value}
              onClick={() =>
                onChange({ ...factor, distribution: option.value as StudyDistribution })
              }
              className={cn(
                'rounded-lg px-2 py-1.5 text-left text-[11px]',
                factor.distribution === option.value
                  ? 'bg-accent/15 text-accent'
                  : 'bg-surface-2 text-muted',
              )}
            >
              <span className="block">{option.label}</span>
              <span className="block text-[10px] opacity-70">{option.hint}</span>
            </button>
          ))}
        </div>
      </div>

      {(factor.distribution === 'normal' || factor.distribution === 'triangular') && (
        <div className="flex items-center gap-2">
          <span className="shrink-0 text-[11px] text-muted">Peak at</span>
          <NumericInput
            value={factor.centre ?? (factor.min + factor.max) / 2}
            onChange={(centre) => onChange({ ...factor, centre })}
            aria-label={`${factor.label} peak`}
            className="min-w-0 flex-1"
          />
        </div>
      )}
    </div>
  );
}

function CategoricalFactorFields({
  factor,
  onChange,
}: {
  factor: CategoricalFactor;
  onChange: (next: StudyFactor) => void;
}) {
  /*
   * Which of the options to include, rather than a free-text list. The values
   * have to match what the node will accept exactly — a checkpoint filename
   * typed by hand is a study that fails on its first shot.
   */
  return (
    <div className="space-y-1">
      <p className="text-[11px] tracking-wide text-muted uppercase">Values to try</p>
      <div className="flex flex-wrap gap-1">
        {factor.levels.map((level) => (
          <button
            key={String(level)}
            type="button"
            onClick={() =>
              onChange({
                ...factor,
                levels: factor.levels.filter((entry) => entry !== level),
              })
            }
            className="max-w-full truncate rounded-lg bg-accent/15 px-2 py-1 text-[11px] text-accent"
          >
            {levelLabel(level)} ×
          </button>
        ))}
      </div>
    </div>
  );
}

/** Everything not yet being varied, to add from. */
function AddFactorSheet({
  open,
  onClose,
  fields,
  taken,
  onAdd,
}: {
  open: boolean;
  onClose: () => void;
  fields: ParamField[];
  taken: Set<string>;
  onAdd: (factor: StudyFactor) => void;
}) {
  const available = fields.filter((field) => !taken.has(field.id));

  return (
    <Sheet open={open} onClose={onClose} title="Vary a parameter">
      <div className="space-y-1">
        {available.length === 0 && (
          <p className="text-sm text-muted">Everything this workflow can vary is already in.</p>
        )}
        {available.map((field) => (
          <button
            key={field.id}
            type="button"
            onClick={() => {
              onAdd(defaultFactor(field));
              onClose();
            }}
            className="flex w-full items-center gap-2 rounded-lg bg-surface-2 px-3 py-2 text-left active:bg-surface-3"
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm">{field.label}</span>
              <span className="block truncate text-[11px] text-muted">{field.nodeTitle}</span>
            </span>
            <span className="shrink-0 text-[11px] text-muted">
              {field.control === 'combo' ? `${field.options?.length ?? 0} options` : field.control}
            </span>
          </button>
        ))}
      </div>
    </Sheet>
  );
}

function SetupPhase({ study }: { study: StudyDetail }) {
  const fields = useStudyFields(study.id);
  const update = useUpdateStudy(study.id);
  const run = useStudyRun(study.id);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const factors = study.factors as StudyFactor[];
  const preview = useStudyPreview(study.id, factors.length > 0);
  const candidates = useMemo(
    () => candidateFields(fields.data?.fields ?? []),
    [fields.data],
  );

  const save = (next: StudyFactor[]) => update.mutate({ factors: next });

  return (
    <div className="space-y-4">
      <Card className="space-y-3">
        <div className="space-y-1">
          <p className="text-[11px] tracking-wide text-muted uppercase">How many pictures</p>
          <NumericInput
            value={study.shotCount}
            onChange={(shotCount) => update.mutate({ shotCount })}
            aria-label="How many pictures"
            className="w-full"
          />
        </div>

        <div className="space-y-1">
          <p className="text-[11px] tracking-wide text-muted uppercase">How they are drawn</p>
          {SAMPLINGS.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={study.sampling === option.value}
              onClick={() => update.mutate({ sampling: option.value as StudySamplingName })}
              className={cn(
                'flex w-full flex-col items-start rounded-lg px-3 py-2 text-left',
                study.sampling === option.value
                  ? 'bg-accent/15 text-accent'
                  : 'bg-surface-2 text-muted',
              )}
            >
              <span className="text-sm">{option.label}</span>
              <span className="text-[11px] opacity-70">{option.hint}</span>
            </button>
          ))}
        </div>
      </Card>

      <div className="flex items-center justify-between">
        <h2 className="text-xs font-medium tracking-wide text-muted uppercase">Varying</h2>
        <Button variant="secondary" size="sm" onClick={() => setAdding(true)}>
          Add
        </Button>
      </div>

      {factors.length === 0 && (
        <EmptyState
          title="Nothing is being varied"
          hint="Add a parameter and the study will sweep it. Everything else stays at whatever the workflow was last generated with."
        />
      )}

      {factors.map((factor, index) => (
        <FactorEditor
          key={factor.key}
          factor={factor}
          onChange={(next) => save(factors.map((entry, i) => (i === index ? next : entry)))}
          onRemove={() => save(factors.filter((_, i) => i !== index))}
        />
      ))}

      {/*
        What the plan will cost, before paying for it.

        "4 model loads" against "196 model loads" is the difference between an
        afternoon and a weekend, and nothing about the numbers above makes it
        visible.
      */}
      {preview.data && factors.length > 0 && (
        <Card className="space-y-2">
          <p className="text-sm">
            {preview.data.shots} picture{preview.data.shots === 1 ? '' : 's'}
          </p>
          <div className="space-y-0.5">
            {[...preview.data.switches]
              .sort((a, b) => a.switches - b.switches)
              .map((entry) => (
                <p key={entry.key} className="flex justify-between text-[11px] text-muted">
                  <span className="min-w-0 truncate">{entry.label}</span>
                  <span className="shrink-0 tabular-nums">changes {entry.switches}×</span>
                </p>
              ))}
          </div>
        </Card>
      )}

      <ErrorNote>{error}</ErrorNote>

      <Button
        className="w-full"
        busy={run.isPending}
        disabled={factors.length === 0}
        onClick={async () => {
          setError(null);
          try {
            await run.mutateAsync('start');
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Could not start');
          }
        }}
      >
        Start rendering
      </Button>

      <AddFactorSheet
        open={adding}
        onClose={() => setAdding(false)}
        fields={candidates}
        taken={new Set(factors.map((factor) => factor.key))}
        onAdd={(factor) => save([...factors, factor])}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

function RunPhase({ study }: { study: StudyDetail }) {
  const run = useStudyRun(study.id);
  const done = study.rendered + study.failed;
  const percent = study.shotCount === 0 ? 0 : Math.round((done / study.shotCount) * 100);

  return (
    <div className="space-y-4">
      <Card className="space-y-3">
        <div className="flex items-baseline justify-between">
          <span className="text-sm">
            {study.rendered} of {study.shotCount}
          </span>
          <span className="text-xs text-muted tabular-nums">{percent}%</span>
        </div>

        <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
          <div
            className="h-full rounded-full bg-accent transition-[width]"
            style={{ width: `${percent}%` }}
          />
        </div>

        {study.failed > 0 && (
          <p className="text-[11px] text-warn">
            {study.failed} failed. They are left out of the analysis rather than counted as bad
            pictures — a render that never happened is not a verdict.
          </p>
        )}

        <p className="text-[11px] text-muted">
          This runs on the server, so it carries on with the phone locked or the tab closed.
        </p>
      </Card>

      <div className="flex gap-2">
        {study.status === 'running' ? (
          <Button
            variant="secondary"
            className="flex-1"
            busy={run.isPending}
            onClick={() => run.mutate('pause')}
          >
            Pause
          </Button>
        ) : (
          <Button className="flex-1" busy={run.isPending} onClick={() => run.mutate('start')}>
            Resume
          </Button>
        )}
        <Button
          variant="secondary"
          className="flex-1"
          disabled={study.rendered === 0}
          onClick={() => run.mutate('finish')}
        >
          Rate what is done
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Rating                                                              */
/* ------------------------------------------------------------------ */

/**
 * One picture, rated by where on it you tap.
 *
 * Top third good, middle middling, bottom poor. Three zones because three is
 * what you can hit without looking and without deliberating — and deliberating
 * is exactly what makes a hundred ratings take an hour instead of five
 * minutes. The zones are on the picture rather than under it so that your
 * thumb never leaves the thing being judged.
 */
function RatingViewer({ study }: { study: StudyDetail }) {
  const next = useNextStudyShot(study.id);
  const rate = useRateStudyShot(study.id);
  const keep = useKeepStudyShot(study.id);
  const blurred = useBlur((state) => state.blurred);
  const [flash, setFlash] = useState<StudyRating | null>(null);
  const [kept, setKept] = useState(false);
  const timer = useRef<number | null>(null);

  const shot = next.data;

  // A new picture is a new decision; nothing carries over from the last one.
  useEffect(() => {
    setKept(false);
  }, [shot?.shot.id]);

  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    [],
  );

  const submit = (rating: StudyRating) => {
    if (!shot) return;
    /*
     * The flash is not decoration. Three zones on one picture give no feedback
     * about which one you hit, and without it a mis-tap is invisible — you
     * would find out from the statistics, which is far too late.
     */
    setFlash(rating);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setFlash(null), 220);
    rate.mutate({ shotId: shot.shot.id, rating });
  };

  if (next.isPending) {
    return (
      <div className="grid place-items-center py-16">
        <Spinner className="size-6 text-muted" />
      </div>
    );
  }

  if (!shot) {
    return (
      <EmptyState
        title="Everything is rated"
        hint="The results are below. Rate more by rendering more, or start another study."
      />
    );
  }

  const zones: { rating: StudyRating; label: string }[] = [
    { rating: 3, label: 'Good' },
    { rating: 2, label: 'Middling' },
    { rating: 1, label: 'Poor' },
  ];

  return (
    <div className="space-y-2">
      <div className="relative overflow-hidden rounded-xl bg-black">
        {/*
          A clip plays itself here, without controls.

          Rating is three tap zones laid over the picture, and a scrubber
          underneath them would be a control you cannot reach. A study shot is
          something you glance at and judge, so it loops silently and the
          judgement stays one tap wherever you touch it.
        */}
        {playsInAudioElement(shot.image.filename) ? (
          /*
            A sound is judged by listening to it, which needs a control the
            rating zones would otherwise swallow. So it gets the player, and
            the rating buttons underneath do the judging.
          */
          <div className="flex min-h-40 items-center justify-center p-6">
            <audio src={imageUrl(shot.image)} controls preload="metadata" className="w-full" />
          </div>
        ) : playsInVideoElement(shot.image.filename) ? (
          <video
            src={imageUrl(shot.image)}
            autoPlay
            loop
            muted
            playsInline
            className={cn(
              'block max-h-[62svh] w-full object-contain',
              blurred && 'blur-2xl',
            )}
          />
        ) : (
          <img
            src={imageUrl(shot.image)}
            alt=""
            className={cn(
              'block max-h-[62svh] w-full object-contain',
              blurred && 'blur-2xl',
            )}
          />
        )}

        {/* The three targets, invisible until one is hit. */}
        <div className="absolute inset-0 flex flex-col">
          {zones.map((zone) => (
            <button
              key={zone.rating}
              type="button"
              data-testid={`rate-${zone.rating}`}
              aria-label={zone.label}
              onClick={() => submit(zone.rating)}
              className={cn(
                'flex flex-1 items-center justify-center transition-colors duration-150',
                flash === zone.rating ? 'bg-white/25' : 'bg-transparent',
              )}
            >
              <span
                className={cn(
                  'rounded-full bg-black/50 px-3 py-1 text-xs font-medium text-white transition-opacity',
                  flash === zone.rating ? 'opacity-100' : 'opacity-0',
                )}
              >
                {zone.label}
              </span>
            </button>
          ))}
        </div>
      </div>

      {/*
        The settings are deliberately *not* shown while judging.
        Knowing this one is at 40 steps is exactly the knowledge that stops you
        judging the picture, and the whole method depends on not having it.
      */}
      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1 text-[11px] text-muted">
          Tap the top for good, the middle for middling, the bottom for poor. The settings are
          hidden until the analysis — knowing them is what biases the answer.
        </p>
        <Button
          variant="secondary"
          size="sm"
          busy={keep.isPending}
          disabled={kept}
          onClick={async () => {
            await keep.mutateAsync(shot.shot.id);
            setKept(true);
          }}
        >
          {kept ? 'Kept' : 'Keep'}
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Results                                                             */
/* ------------------------------------------------------------------ */

/** One factor's verdict, with the per-level means drawn as a small chart. */
function FactorResultCard({ factor }: { factor: FactorResult }) {
  const tried = factor.levels.filter((level) => level.count > 0);
  const verdict = describeSignificance(factor.p, factor.n);

  return (
    <Card className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{factor.label}</span>
        {factor.rho !== null && (
          <span
            className={cn(
              'shrink-0 text-xs tabular-nums',
              Math.abs(factor.rho) > 0.3 ? 'text-accent' : 'text-muted',
            )}
          >
            {factor.rho > 0 ? '↑' : '↓'} {Math.abs(factor.rho).toFixed(2)}
          </span>
        )}
      </div>

      <p className="text-[11px] text-muted">
        {factor.n === 0
          ? 'No rated shots varied this.'
          : factor.rho !== null
            ? `${factor.rho > 0 ? 'More' : 'Less'} rated better — ${verdict}.`
            : `${verdict}.`}
      </p>

      {/*
        The per-level means as bars.

        A correlation says "more is better"; this says *how much* better and at
        which value it stops helping, which is the thing you actually change a
        setting from.
      */}
      {tried.length > 0 && (
        <div className="space-y-1">
          {tried.map((level) => (
            <div key={String(level.level)} className="flex items-center gap-2">
              <span className="w-20 shrink-0 truncate text-[11px] text-muted">{level.label}</span>
              <div className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-2">
                <div
                  className={cn(
                    'h-full rounded-full',
                    factor.best?.level === level.level ? 'bg-accent' : 'bg-muted/50',
                  )}
                  // 1 is the floor of the scale, 3 the ceiling, so the bar
                  // shows where in that range the mean actually sits.
                  style={{ width: `${((level.mean - 1) / 2) * 100}%` }}
                />
              </div>
              <span className="w-14 shrink-0 text-right text-[11px] text-muted tabular-nums">
                {level.mean.toFixed(2)}
                <span className="opacity-60"> ×{level.count}</span>
              </span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function ResultsPhase({ study }: { study: StudyDetail }) {
  const stats = useStudyStats(study.id);

  if (stats.isPending) {
    return (
      <div className="grid place-items-center py-8">
        <Spinner className="size-5 text-muted" />
      </div>
    );
  }
  if (!stats.data) return null;

  const { rated, unrated, distribution, meanRating, factors } = stats.data;

  return (
    <div className="space-y-3">
      <Card className="space-y-2">
        <div className="flex items-baseline justify-between">
          <span className="text-sm">
            {rated} rated{unrated > 0 && `, ${unrated} to go`}
          </span>
          <span className="text-xs text-muted tabular-nums">avg {meanRating.toFixed(2)}</span>
        </div>
        <div className="flex h-2 overflow-hidden rounded-full bg-surface-2">
          {([3, 2, 1] as StudyRating[]).map((rating) => (
            <div
              key={rating}
              className={cn(
                'h-full',
                rating === 3 ? 'bg-success' : rating === 2 ? 'bg-muted/60' : 'bg-danger/70',
              )}
              style={{ width: rated === 0 ? '0%' : `${(distribution[rating] / rated) * 100}%` }}
            />
          ))}
        </div>
        {rated < 12 && (
          <p className="text-[11px] text-muted">
            Under a dozen ratings, none of this means much yet. The tests below say so themselves
            rather than pretending otherwise.
          </p>
        )}
      </Card>

      {factors.map((factor) => (
        <FactorResultCard key={factor.key} factor={factor} />
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The screen                                                          */
/* ------------------------------------------------------------------ */

function StudyList({ onOpen }: { onOpen: (id: string) => void }) {
  const studies = useStudies();
  const workflows = useWorkflows();
  const create = useCreateStudy();
  const [picking, setPicking] = useState(false);

  const visible = (workflows.data ?? []).filter((workflow) => workflow.visible);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Studies</h1>
        <Button size="sm" onClick={() => setPicking(true)} disabled={visible.length === 0}>
          New
        </Button>
      </div>

      <p className="text-xs text-muted">
        Vary a workflow’s settings across hundreds of pictures, rate them blind, and find out which
        settings actually mattered. The pictures stay here rather than filling the gallery.
      </p>

      {studies.data?.length === 0 && (
        <EmptyState
          title="No studies yet"
          hint={
            visible.length === 0
              ? 'Switch a workflow on in Settings first — a study needs one to sweep.'
              : 'Start one and pick which parameters to vary.'
          }
        />
      )}

      {studies.data?.map((study) => (
        <button
          key={study.id}
          type="button"
          data-testid="study-row"
          onClick={() => onOpen(study.id)}
          className="w-full rounded-xl border border-line bg-surface p-3 text-left active:bg-surface-2"
        >
          <div className="flex items-baseline justify-between gap-2">
            <span className="min-w-0 flex-1 truncate text-sm font-medium">{study.name}</span>
            <span className="shrink-0 text-[11px] text-muted">{describeStatus(study)}</span>
          </div>
          <p className="truncate text-[11px] text-muted">{study.workflowName}</p>
        </button>
      ))}

      <Sheet open={picking} onClose={() => setPicking(false)} title="Which workflow">
        <div className="space-y-1">
          {visible.map((workflow) => (
            <button
              key={workflow.id}
              type="button"
              onClick={async () => {
                const study = await create.mutateAsync({
                  name: `Study of ${workflow.name}`,
                  workflowId: workflow.id,
                });
                setPicking(false);
                onOpen(study.id);
              }}
              className="w-full truncate rounded-lg bg-surface-2 px-3 py-2 text-left text-sm active:bg-surface-3"
            >
              {workflow.name}
            </button>
          ))}
        </div>
      </Sheet>
    </div>
  );
}

function describeStatus(study: StudySummary): string {
  switch (study.status) {
    case 'draft':
      return 'not started';
    case 'running':
      return `${study.rendered}/${study.shotCount}`;
    case 'paused':
      return `paused at ${study.rendered}`;
    case 'rating':
      return `${study.rated}/${study.rendered} rated`;
    default:
      return `${study.rated} rated`;
  }
}

export function StudyScreen() {
  const [openId, setOpenId] = useState<string | null>(null);
  const study = useStudy(openId);
  const remove = useDeleteStudy();
  const [confirming, setConfirming] = useState(false);

  if (openId === null || !study.data) {
    return (
      <div className="safe-t px-4 pt-3 pb-6">
        <StudyList onOpen={setOpenId} />
      </div>
    );
  }

  const detail = study.data;
  const phase = detail.status;

  return (
    <div className="safe-t space-y-4 px-4 pt-3 pb-6">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setOpenId(null)}
          aria-label="Back to studies"
          className="shrink-0 rounded-lg px-2 py-1 text-sm text-muted active:bg-surface-2"
        >
          ‹
        </button>
        <h1 className="min-w-0 flex-1 truncate text-lg font-semibold">{detail.name}</h1>
        <button
          type="button"
          onClick={() => setConfirming(true)}
          aria-label="Delete this study"
          className="shrink-0 rounded-lg px-2 py-1 text-xs text-muted active:bg-surface-2"
        >
          Delete
        </button>
      </div>

      {phase === 'draft' && <SetupPhase study={detail} />}
      {(phase === 'running' || phase === 'paused') && <RunPhase study={detail} />}
      {(phase === 'rating' || phase === 'done') && (
        <>
          <RatingViewer study={detail} />
          <ResultsPhase study={detail} />
        </>
      )}

      <Sheet open={confirming} onClose={() => setConfirming(false)} title="Delete this study?">
        <div className="space-y-3">
          <p className="text-sm text-muted">
            The {detail.rendered} pictures it made go with it. Anything you kept has already moved
            to the gallery and stays there.
          </p>
          <Button
            variant="danger"
            className="w-full"
            busy={remove.isPending}
            onClick={async () => {
              await remove.mutateAsync(detail.id);
              setConfirming(false);
              setOpenId(null);
            }}
          >
            Delete
          </Button>
        </div>
      </Sheet>
    </div>
  );
}
