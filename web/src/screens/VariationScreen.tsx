import { useMemo, useState } from 'react';

import {
  candidateValues,
  defaultRuleFor,
  groupLimitFor,
  normaliseGroupKey,
  randomPromptPool,
  UNGROUPED_KEY,
  variableFields,
} from '@latent/shared';
import type {
  PromptBlock,
  RandomParamRule,
  RandomPromptConfig,
  RandomPromptRoll,
} from '@latent/shared';

import { api } from '../api/client';
import {
  usePromptBlocks,
  usePromptMode,
  useUpdatePromptMode,
  useVariationPresetMutations,
  useVariationPresets,
  useWorkflow,
  useWorkflows,
} from '../api/queries';
import { NumericInput } from '../components/NumericInput';
import { Toggle } from '../components/ParamControl';
import { Button, cn, ErrorNote, Spinner } from '../components/ui';
import { readPromptDraft } from '../state/promptDraft';

/**
 * Everything about varying a run: the prompt draw and the parameter sweeps.
 *
 * A tab of its own rather than a sheet buried under the prompt field. It grew
 * into a screenful — pool, per-group limits, parameter ranges, saved setups —
 * and something you arrange once and then leave alone deserves a place you can
 * find, not a button you have to remember is there.
 *
 * The draws themselves happen on the server, once per queued item, so a batch of
 * eight is eight different pictures rather than the same prompt eight times.
 * This screen only configures them, and previews by asking the server for
 * example draws through the same code path a real submit uses.
 */
export function VariationScreen() {
  const mode = usePromptMode();
  const update = useUpdatePromptMode();
  const blocks = usePromptBlocks();

  const [rolls, setRolls] = useState<RandomPromptRoll[] | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // What is typed on the Generate screen right now: with "keep what I typed" on
  // it is part of every prompt, so a preview without it would be a fiction.
  const [typed] = useState(readPromptDraft);

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
      const result = await api.previewPromptMode(typed, config);
      setRolls(result.rolls);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not draw a preview');
    } finally {
      setPreviewing(false);
    }
  };

  if (!config) {
    return (
      <div className="grid h-full place-items-center">
        <Spinner className="size-6 text-muted" />
      </div>
    );
  }

  const pool = randomPromptPool(library, config);
  const narrowed = config.blockIds.length > 0;

  return (
    <div className="safe-t px-4 pt-3 pb-6">
      <h1 className="mb-3 text-xl font-semibold">Random</h1>
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
                hint="The starting point. Any group can be set on its own below."
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
                  {/*
                    Each group says how many of its blocks may land in one prompt.
                    One place, but as much atmosphere as you like — that
                    distinction is the whole reason this is per-group rather than
                    a single switch.
                  */}
                  <div className="flex items-center justify-between gap-2">
                    <p className="min-w-0 truncate text-[11px] tracking-wide text-muted uppercase">
                      {group}
                    </p>
                    <GroupLimitPicker
                      group={group}
                      value={groupLimitFor(config, groupKeyOf(group))}
                      max={items.length}
                      onChange={(limit) =>
                        patch({
                          groupLimits: {
                            ...config.groupLimits,
                            [groupKeyOf(group)]: limit,
                          },
                        })
                      }
                    />
                  </div>
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
          </>
        )}

        {/*
          Parameter variation, deliberately below the prompt and collapsed.
          Sweeping CFG is a real thing to want, but the prompt is what decides
          whether a picture is interesting — so this stays out of the way until
          it is asked for.
        */}
        <ParamVariation config={config} onChange={patch} />

        <VariationPresets />

        {library.length > 0 && (
          <>
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

              {config.keepTyped && typed !== '' && (
                <p className="truncate text-[11px] text-muted">
                  On top of what you typed: “{typed}”
                </p>
              )}

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
    </div>
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

/**
 * Numeric parameters drawn from a range, kept as small as it can be.
 *
 * Collapsed by default and one line per rule: the prompt is the thing that
 * decides whether a picture is interesting, and this must not push it off screen.
 */
function ParamVariation({
  config,
  onChange,
}: {
  config: RandomPromptConfig;
  onChange: (patch: Partial<RandomPromptConfig>) => void;
}) {
  const [open, setOpen] = useState(config.params.length > 0);
  const [adding, setAdding] = useState(false);
  const workflows = useWorkflows();
  const [workflowId, setWorkflowId] = useState<string | null>(null);
  const workflow = useWorkflow(workflowId ?? workflows.data?.[0]?.id ?? null);

  const available = useMemo(
    () => (workflow.data ? variableFields(workflow.data.schema) : []),
    [workflow.data],
  );
  const used = new Set(config.params.map((rule) => rule.key));

  const setRule = (key: string, patch: Partial<RandomParamRule>) =>
    onChange({
      params: config.params.map((rule) => (rule.key === key ? { ...rule, ...patch } : rule)),
    });

  return (
    <div className="space-y-2 border-t border-line pt-3">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        className="flex w-full items-center justify-between text-left"
      >
        <span className="text-xs font-medium tracking-wide text-muted uppercase">
          Parameters{config.params.length > 0 && ` (${config.params.length})`}
        </span>
        <span className="text-xs text-accent">{open ? 'Hide' : 'Show'}</span>
      </button>

      {open && (
        <div className="space-y-1.5">
          {config.params.length === 0 && (
            <p className="text-[11px] text-muted">
              Give a value a range and an interval, and each run draws one of the results.
            </p>
          )}

          {config.params.map((rule) => {
            const values = candidateValues(rule);
            return (
              <div key={rule.key} className="space-y-0.5 rounded-lg border border-line px-2 py-1.5">
                <div className="flex items-center gap-1.5">
                  <span className="min-w-0 flex-1 truncate text-xs">{rule.label}</span>
                  <RuleNumber
                    label={`${rule.label} from`}
                    value={rule.min}
                    onChange={(min) => setRule(rule.key, { min })}
                  />
                  <span className="text-[10px] text-muted">–</span>
                  <RuleNumber
                    label={`${rule.label} to`}
                    value={rule.max}
                    onChange={(max) => setRule(rule.key, { max })}
                  />
                  <span className="text-[10px] text-muted">/</span>
                  <RuleNumber
                    label={`${rule.label} step`}
                    value={rule.step}
                    onChange={(step) => setRule(rule.key, { step })}
                  />
                  <button
                    type="button"
                    aria-label={`Remove ${rule.label}`}
                    onClick={() =>
                      onChange({ params: config.params.filter((item) => item.key !== rule.key) })
                    }
                    className="shrink-0 px-1 text-xs text-muted"
                  >
                    ✕
                  </button>
                </div>
                {/* Exactly what this rule can produce — no guessing. */}
                <p className="truncate text-[10px] tabular-nums text-muted">
                  {values.slice(0, 8).join(', ')}
                  {values.length > 8 && ` … (${values.length})`}
                </p>
              </div>
            );
          })}

          {adding ? (
            <div className="space-y-1 rounded-lg border border-line p-2">
              {workflows.data && workflows.data.length > 1 && (
                <select
                  value={workflowId ?? workflows.data[0]?.id ?? ''}
                  onChange={(event) => setWorkflowId(event.target.value)}
                  aria-label="Workflow to take parameters from"
                  className="w-full rounded-md bg-surface-2 px-2 py-1 text-xs"
                >
                  {workflows.data.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              )}
              <div className="flex max-h-40 flex-wrap gap-1 overflow-y-auto">
                {available
                  .filter((field) => !used.has(field.id))
                  .map((field) => (
                    <button
                      key={field.id}
                      type="button"
                      onClick={() => {
                        onChange({ params: [...config.params, defaultRuleFor(field)] });
                        setAdding(false);
                      }}
                      className="rounded-full border border-line px-2 py-1 text-[11px] active:bg-surface-2"
                    >
                      {field.label}
                    </button>
                  ))}
              </div>
              {available.length === 0 && (
                <p className="text-[11px] text-muted">
                  That workflow has no numeric settings to vary.
                </p>
              )}
              <button
                type="button"
                onClick={() => setAdding(false)}
                className="w-full py-1 text-[11px] text-muted"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="w-full rounded-lg border border-dashed border-line py-1.5 text-[11px] text-accent"
            >
              + Vary a parameter
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** A very small number field, sized for a one-line rule row. */
function RuleNumber({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <NumericInput
      value={value}
      onChange={(next) => onChange(Number(next))}
      aria-label={label}
      // Wide enough for a four-digit value: `w-11` clipped "20" to "2(".
      className="w-14 shrink-0 rounded-md border-0 bg-surface-2 px-1 py-0.5 text-center text-xs"
    />
  );
}

/**
 * Saving and loading the whole setup — prompt draw and parameter draw together.
 *
 * One thing, because that is how it is used: "landscapes, high step count" is a
 * different way of working from "portraits, fast drafts", and switching between
 * them should be one tap rather than eight.
 */
function VariationPresets() {
  const presets = useVariationPresets();
  const { save, apply, remove } = useVariationPresetMutations();
  const [name, setName] = useState('');
  const [naming, setNaming] = useState(false);

  return (
    <div className="space-y-2 border-t border-line pt-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium tracking-wide text-muted uppercase">Saved setups</span>
        <button
          type="button"
          onClick={() => setNaming((current) => !current)}
          className="text-xs text-accent"
        >
          {naming ? 'Cancel' : 'Save current'}
        </button>
      </div>

      {naming && (
        <div className="flex gap-2">
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. Moody landscapes"
            className="min-w-0 flex-1 rounded-lg border border-line bg-surface-2 px-2 py-1 text-xs focus:border-accent focus:outline-none"
          />
          <Button
            variant="primary"
            size="sm"
            busy={save.isPending}
            disabled={name.trim() === ''}
            onClick={() =>
              save.mutate(name.trim(), {
                onSuccess: () => {
                  setName('');
                  setNaming(false);
                },
              })
            }
          >
            Save
          </Button>
        </div>
      )}

      {(presets.data ?? []).length === 0 ? (
        <p className="text-[11px] text-muted">
          Nothing saved yet. A setup keeps the blocks, the limits and the parameter ranges together.
        </p>
      ) : (
        <ul className="space-y-1">
          {(presets.data ?? []).map((preset) => (
            <li key={preset.id} className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => apply.mutate(preset.id)}
                className="min-w-0 flex-1 truncate rounded-lg px-2 py-1 text-left text-xs active:bg-surface-2"
              >
                {preset.name}
                <span className="ml-2 text-[10px] text-muted">
                  {preset.config.blockIds.length === 0 ? 'all blocks' : `${preset.config.blockIds.length} blocks`}
                  {preset.config.params.length > 0 && `, ${preset.config.params.length} params`}
                </span>
              </button>
              <button
                type="button"
                aria-label={`Delete ${preset.name}`}
                onClick={() => remove.mutate(preset.id)}
                className="shrink-0 px-1 text-xs text-muted"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The pool sheet labels ungrouped blocks; the config keys them by empty string. */
function groupKeyOf(label: string): string {
  return label === 'Ungrouped' ? UNGROUPED_KEY : normaliseGroupKey(label);
}

/**
 * How many blocks one group may contribute, including "any".
 *
 * Rendered per group rather than as a global switch because groups genuinely
 * differ: exactly one should say where the picture is, while several can say
 * what it feels like.
 */
function GroupLimitPicker({
  group,
  value,
  max,
  onChange,
}: {
  group: string;
  value: number;
  max: number;
  onChange: (limit: number) => void;
}) {
  // No point offering "at most 3" to a group with two blocks in it.
  const options = [
    ...Array.from({ length: Math.min(max, 3) }, (_unused, index) => index + 1),
    0,
  ];

  return (
    <div className="flex shrink-0 gap-0.5" role="group" aria-label={`${group} limit`}>
      {options.map((option) => (
        <button
          key={option}
          type="button"
          aria-label={`${group}: ${option === 0 ? 'any' : `at most ${option}`}`}
          aria-pressed={value === option}
          onClick={() => onChange(option)}
          className={cn(
            'h-5 min-w-5 rounded px-1 text-[10px] tabular-nums',
            value === option ? 'bg-accent text-white' : 'bg-surface-2 text-muted',
          )}
        >
          {option === 0 ? 'any' : option}
        </button>
      ))}
    </div>
  );
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
