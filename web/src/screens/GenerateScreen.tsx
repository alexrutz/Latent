import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { defaultValues, findFieldByRole, usesPointLine } from '@latent/shared';
import type { ParamField, ParamValues, WidgetValue } from '@latent/shared';

import {
  useDeletePreset,
  useGenerate,
  usePresets,
  usePromptMode,
  useSavePreset,
  useWorkflow,
  useWorkflows,
} from '../api/queries';
import { AlwaysBlocks } from '../components/AlwaysBlocks';
import { LiveBar } from '../components/LiveBar';
import { LoraEditor } from '../components/LoraEditor';
import { PointLine } from '../components/PointLine';
import { PromptBuilder } from '../components/PromptBuilder';
import { FieldChip, ImageField, PromptField, SeedField } from '../components/ParamControl';
import { Button, cn, EmptyState, ErrorNote, Sheet, Spinner } from '../components/ui';
import { pruneDrafts, useFormDrafts } from '../state/formDraft';
import { useLiveStore } from '../state/live';
import { usePendingStore } from '../state/pending';
import { savePromptDraft } from '../state/promptDraft';

const LAST_WORKFLOW_KEY = 'latent.lastWorkflowId';

export function GenerateScreen() {
  const navigate = useNavigate();
  const workflows = useWorkflows();
  const consumePending = usePendingStore((state) => state.consume);
  const pending = usePendingStore((state) => state.pending);

  const [workflowId, setWorkflowId] = useState<string | null>(
    () => localStorage.getItem(LAST_WORKFLOW_KEY),
  );

  // Fall back to the first available workflow if the remembered one is gone.
  useEffect(() => {
    const list = workflows.data;
    if (!list || list.length === 0) return;
    // Deleting a workflow should not leave its form draft behind forever.
    pruneDrafts(list.map((item) => item.id));
    if (!workflowId || !list.some((item) => item.id === workflowId)) {
      setWorkflowId(list[0]!.id);
    }
  }, [workflows.data, workflowId]);

  // A handoff from the gallery selects its workflow before anything else.
  useEffect(() => {
    if (pending) setWorkflowId(pending.workflowId);
  }, [pending]);

  useEffect(() => {
    if (workflowId) localStorage.setItem(LAST_WORKFLOW_KEY, workflowId);
  }, [workflowId]);

  const workflow = useWorkflow(workflowId);

  if (workflows.isLoading) {
    return (
      <div className="grid h-full place-items-center">
        <Spinner className="size-6 text-muted" />
      </div>
    );
  }

  if (!workflows.data || workflows.data.length === 0) {
    return (
      <EmptyState
        icon="✦"
        title="No workflows yet"
        hint="Import a workflow exported from ComfyUI with “Export (API)” to get started."
        action={
          <Button variant="primary" onClick={() => navigate('/settings')}>
            Import a workflow
          </Button>
        }
      />
    );
  }

  return (
    <GenerateForm
      key={workflowId ?? 'none'}
      workflowQuery={workflow}
      workflows={workflows.data}
      workflowId={workflowId}
      onSelectWorkflow={setWorkflowId}
      consumePending={consumePending}
    />
  );
}

interface GenerateFormProps {
  workflowQuery: ReturnType<typeof useWorkflow>;
  workflows: { id: string; name: string }[];
  workflowId: string | null;
  onSelectWorkflow: (id: string) => void;
  consumePending: () => ReturnType<typeof usePendingStore.getState>['pending'];
}

function GenerateForm({
  workflowQuery,
  workflows,
  workflowId,
  onSelectWorkflow,
  consumePending,
}: GenerateFormProps) {
  const detail = workflowQuery.data;
  const generate = useGenerate();
  const randomMode = usePromptMode();
  const job = useLiveStore((state) => state.live.job);
  const comfyOnline = useLiveStore((state) => state.live.comfyOnline);

  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justQueued, setJustQueued] = useState(0);
  const initialisedFor = useRef<string | null>(null);

  /*
   * The form lives in a store rather than in this component.
   *
   * Leaving the tab unmounts this screen, and rebuilding its state from the
   * workflow's last *submitted* values looked like the app reverting settings
   * on its own — which is exactly what it was doing.
   */
  const draft = useFormDrafts((state) => (detail ? state.drafts[detail.id] : undefined));
  const setDraft = useFormDrafts((state) => state.set);
  const patchDraft = useFormDrafts((state) => state.patch);

  const values = draft?.values ?? {};
  const lockedSeeds = draft?.lockedSeeds ?? [];
  const batchCount = draft?.batchCount ?? 1;

  /**
   * Seed the form from the workflow's last-used values, then apply any pending
   * handoff on top. Runs once per workflow, and only when there is nothing set
   * up already — a draft the user built is never overwritten by a refetch.
   */
  useEffect(() => {
    if (!detail || initialisedFor.current === detail.id) return;
    initialisedFor.current = detail.id;

    const handoff = consumePending();
    const reused = handoff?.workflowId === detail.id;
    const stored = useFormDrafts.getState().drafts[detail.id];

    // "Reuse these settings" is an explicit instruction and wins; otherwise
    // whatever was already set up stays exactly as it was left.
    if (stored && !reused) return;

    const base = { ...defaultValues(detail.schema), ...detail.lastValues };

    if (reused) {
      Object.assign(base, handoff?.values ?? {});

      if (handoff?.imageFilename) {
        const imageField = findFieldByRole(detail.schema, 'image_input');
        if (imageField) base[imageField.id] = handoff.imageFilename;
      }
      if (handoff?.freshSeed) {
        for (const field of detail.schema.fields) {
          if (field.role === 'seed') {
            base[field.id] = Math.floor(Math.random() * 2 ** 32);
          }
        }
      }
    }

    setDraft(detail.id, {
      values: base,
      lockedSeeds: stored?.lockedSeeds ?? [],
      batchCount: stored?.batchCount ?? 1,
    });
  }, [detail, consumePending, setDraft]);

  const fields = useMemo(
    () => (detail ? detail.schema.fields.filter((field) => !field.hidden) : []),
    [detail],
  );

  const byRole = (role: ParamField['role']) => fields.filter((field) => field.role === role);
  const promptFields = byRole('prompt');
  const negativeFields = byRole('negative_prompt');
  const imageFields = byRole('image_input');
  const seedFields = byRole('seed');
  const loraTextFields = byRole('lora_text');

  /** Everything on the main screen that isn't given its own dedicated control. */
  const mainOther = fields.filter(
    (field) =>
      field.group === 'main' &&
      !['prompt', 'negative_prompt', 'image_input', 'seed', 'lora_text'].includes(field.role),
  );
  // A point line needs a full row; everything else pairs up in the grid.
  const pointFields = mainOther.filter((field) => usesPointLine(field));
  const chipFields = mainOther.filter((field) => !usesPointLine(field));
  const advancedFields = fields.filter((field) => field.group === 'advanced');

  // Hand the typed prompt to the Random tab, which previews draws on top of it.
  const promptDraft = promptFields
    .map((field) => String(values[field.id] ?? ''))
    .join(' ')
    .trim();
  useEffect(() => {
    savePromptDraft(promptDraft);
  }, [promptDraft]);

  const setValue = (id: string, value: WidgetValue) => {
    if (!detail) return;
    patchDraft(detail.id, { values: { ...values, [id]: value } });
  };

  const anySeedUnlocked = seedFields.some((field) => !lockedSeeds.includes(field.id));

  const submit = async () => {
    if (!detail) return;
    setError(null);
    try {
      await generate.mutateAsync({
        workflowId: detail.id,
        values,
        // A locked seed means "give me this exact image again"; otherwise every
        // run should differ, which is what people expect from a Generate button.
        randomizeSeeds: anySeedUnlocked,
        lockedSeedFields: lockedSeeds,
        batchCount,
      });
      setJustQueued(Date.now());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not queue the prompt');
    }
  };

  // Briefly confirm the tap landed — on a slow link the queue may take a moment.
  useEffect(() => {
    if (!justQueued) return;
    const timer = window.setTimeout(() => setJustQueued(0), 1600);
    return () => window.clearTimeout(timer);
  }, [justQueued]);

  if (workflowQuery.isLoading || !detail) {
    return (
      <div className="grid h-full place-items-center">
        <Spinner className="size-6 text-muted" />
      </div>
    );
  }

  return (
    // min-h-full so `mt-auto` on the pinned footer has something to push
    // against on a form too short to scroll.
    <div className="safe-t flex min-h-full flex-col gap-3 px-4 pt-2 pb-2">
      {/* Workflow selector + connection state */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setShowPicker(true)}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2 text-left active:bg-surface-2"
        >
          <span className="min-w-0 flex-1 truncate font-medium">{detail.name}</span>
          <span className="shrink-0 text-muted" aria-hidden>
            ▾
          </span>
        </button>

        <span
          title={comfyOnline ? 'ComfyUI connected' : 'ComfyUI unreachable'}
          className={cn(
            'size-2.5 shrink-0 rounded-full',
            comfyOnline ? 'bg-success' : 'bg-danger',
          )}
        />
      </div>

      {detail.schema.missingNodeTypes.length > 0 && (
        <p className="rounded-xl border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-warn">
          Not installed on this ComfyUI: {detail.schema.missingNodeTypes.join(', ')}. Generation
          will fail until those custom nodes are added.
        </p>
      )}

      <PresetBar
        workflowId={detail.id}
        values={values}
        onApply={(preset) => patchDraft(detail.id, { values: { ...values, ...preset } })}
      />

      {promptFields.map((field) => (
        <div key={field.id} className="space-y-2">
          <PromptField
            field={field}
            value={values[field.id] ?? ''}
            onChange={(value) => setValue(field.id, value)}
          />
          <div className="flex flex-wrap items-center gap-4">
            {/* Assemble the prompt from saved fragments rather than typing. */}
            <PromptBuilder
              value={String(values[field.id] ?? '')}
              onChange={(next) => setValue(field.id, next)}
            />
            {/* The phrases that go on everything, chosen once. */}
            <AlwaysBlocks />
            {/* LoRA tags live inside the prompt text; edit them structurally. */}
            <LoraEditor
              value={String(values[field.id] ?? '')}
              onChange={(next) => setValue(field.id, next)}
            />
          </div>
        </div>
      ))}

      {loraTextFields.map((field) => (
        <LoraEditor
          key={field.id}
          label={field.label}
          alwaysShow
          value={String(values[field.id] ?? '')}
          onChange={(next) => setValue(field.id, next)}
        />
      ))}

      {negativeFields.map((field) => (
        <PromptField
          key={field.id}
          field={field}
          value={values[field.id] ?? ''}
          onChange={(value) => setValue(field.id, value)}
          compact
        />
      ))}

      {imageFields.map((field) => (
        <ImageField
          key={field.id}
          field={field}
          value={values[field.id] ?? ''}
          onChange={(value) => setValue(field.id, value)}
        />
      ))}

      {/*
        Fields set to a point line get a row of their own — the whole point is
        that the values are on screen, which needs the width.
      */}
      {pointFields.map((field) => (
        <PointLine
          key={field.id}
          field={field}
          value={values[field.id] ?? field.defaultValue}
          onChange={(value) => setValue(field.id, value)}
        />
      ))}

      {/*
        A two-column grid, not a wrapping row.

        Wrapping put chips of every width wherever they happened to land, which
        read as a scattered heap rather than a list of settings. Equal columns
        line the labels up, so the sampler block can be scanned down instead of
        hunted through — and every value is still on screen at once, which is why
        it stopped being a sideways-scrolling row in the first place.
      */}
      {chipFields.length > 0 && (
        <div className="grid grid-cols-2 gap-1.5">
          {chipFields.map((field) => (
            <div key={field.id} className={cn('min-w-0', field.width === 'full' && 'col-span-2')}>
              <FieldChip
                field={field}
                value={values[field.id] ?? field.defaultValue}
                onChange={(value) => setValue(field.id, value)}
                block
              />
            </div>
          ))}
        </div>
      )}

      {seedFields.map((field) => (
        <SeedField
          key={field.id}
          field={field}
          value={values[field.id] ?? field.defaultValue}
          onChange={(value) => setValue(field.id, value)}
          locked={lockedSeeds.includes(field.id)}
          onToggleLock={() =>
            patchDraft(detail.id, {
              lockedSeeds: lockedSeeds.includes(field.id)
                ? lockedSeeds.filter((id) => id !== field.id)
                : [...lockedSeeds, field.id],
            })
          }
        />
      ))}

      {seedFields.length > 0 && (
        <p className="-mt-2 text-xs text-muted">
          {anySeedUnlocked
            ? 'A new seed is used for every run.'
            : 'Seed is locked — each run reproduces the same image.'}
        </p>
      )}

      {/* Batch */}
      <div className="flex items-center justify-between rounded-xl border border-line bg-surface px-3 py-1.5">
        <span className="text-sm">Queue this many</span>
        <div className="flex items-center gap-1">
          {[1, 2, 4, 8].map((count) => (
            <button
              key={count}
              type="button"
              onClick={() => patchDraft(detail.id, { batchCount: count })}
              className={cn(
                'size-8 rounded-lg text-sm tabular-nums',
                batchCount === count ? 'bg-accent text-white' : 'bg-surface-2 text-muted',
              )}
            >
              {count}
            </button>
          ))}
        </div>
      </div>

      {advancedFields.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => setShowAdvanced(true)}
            className="flex items-center justify-between rounded-xl border border-line bg-surface px-3 py-2 text-left active:bg-surface-2"
          >
            <span className="text-sm">Advanced</span>
            <span className="text-xs text-muted">{advancedFields.length} settings ›</span>
          </button>

          <Sheet open={showAdvanced} onClose={() => setShowAdvanced(false)} title="Advanced" full>
            {/*
              Two columns of chips, not a stack of labelled blocks.

              Advanced is where a big workflow puts thirty inputs, and giving each
              one a heading, a caption and a full-width control turned it into
              several screens of scrolling to reach the one you came for. A chip
              already carries its own label and value, so the heading was
              redundant; the wide controls (text, image) still get a full row
              because they cannot be read in half of one.
            */}
            <div className="flex flex-wrap gap-1.5">
              {advancedFields.map((field) => (
                <div
                  key={field.id}
                  className={cn(
                    'min-w-0',
                    isWideControl(field) ? 'w-full space-y-1' : 'max-w-full',
                  )}
                >
                  {isWideControl(field) && (
                    <span className="block truncate text-[11px] tracking-wide text-muted uppercase">
                      {field.label}
                    </span>
                  )}
                  <AdvancedRow
                    field={field}
                    value={values[field.id] ?? field.defaultValue}
                    onChange={(value) => setValue(field.id, value)}
                  />
                </div>
              ))}
            </div>
          </Sheet>
        </>
      )}

      <ErrorNote>{error}</ErrorNote>

      {/*
        Pinned to the bottom of the scroll area.

        A long form put Generate below the fold, so starting a render meant
        scrolling past every setting to reach the one button you always press.
        Sticky rather than fixed: it releases into the flow once the form is
        short enough not to scroll, so a two-field workflow does not get a
        floating bar over empty space.
      */}
      {/* Fully opaque, not translucent: chips scrolling underneath showed
          through as half-visible shapes below the button. */}
      <div className="sticky bottom-0 -mx-4 mt-auto space-y-1 border-t border-line bg-ink px-4 pt-2 pb-1">
        {/*
          Said out loud, right where you tap. With random mode on, what gets
          rendered is not what the prompt field says — leaving that implicit
          would be genuinely confusing the next time you came back to the app.
        */}
        {randomMode.data?.enabled && promptFields.length > 0 && (
          <p className="text-center text-[11px] text-accent">
            ⁂ Prompt drawn from blocks: {randomMode.data.minBlocks}–{randomMode.data.maxBlocks} per
            run
          </p>
        )}

        {/*
          Progress and Generate share one row.
          Stacked, they cost two rows of a phone screen for two things you look
          at together — and the form is what the space is for. The bar only
          appears while something is running, so an idle screen still gives the
          button the full width.
        */}
        <div className="flex items-stretch gap-2">
          <LiveBar inline />
          <Button
            variant="primary"
            size="lg"
            fullWidth={!job}
            className={job ? 'shrink-0' : undefined}
            onClick={submit}
            busy={generate.isPending}
            disabled={!comfyOnline}
          >
            {justQueued
              ? 'Queued ✓'
              : job
                ? `+${batchCount > 1 ? batchCount : 1}`
                : `Generate${batchCount > 1 ? ` ×${batchCount}` : ''}`}
          </Button>
        </div>

        {!comfyOnline && (
          <p className="text-center text-xs text-danger">
            ComfyUI is unreachable — check that it is running.
          </p>
        )}
      </div>

      <Sheet open={showPicker} onClose={() => setShowPicker(false)} title="Workflow">
        <ul className="space-y-1">
          {workflows.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => {
                  onSelectWorkflow(item.id);
                  setShowPicker(false);
                }}
                className={cn(
                  'flex w-full items-center justify-between rounded-xl px-4 py-3 text-left',
                  item.id === workflowId ? 'bg-accent/15 text-accent' : 'active:bg-surface-2',
                )}
              >
                <span className="min-w-0 truncate">{item.name}</span>
                {item.id === workflowId && <span aria-hidden>✓</span>}
              </button>
            </li>
          ))}
        </ul>
      </Sheet>
    </div>
  );
}

/**
 * Saved parameter sets for this workflow.
 *
 * Bulk change is the point: without it, trying a different look means opening
 * Advanced and editing settings one sheet at a time, which nobody does twice.
 */
function PresetBar({
  workflowId,
  values,
  onApply,
}: {
  workflowId: string;
  values: ParamValues;
  onApply: (values: ParamValues) => void;
}) {
  const presets = usePresets(workflowId);
  const save = useSavePreset(workflowId);
  const remove = useDeletePreset(workflowId);

  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  const [applied, setApplied] = useState<string | null>(null);

  const list = presets.data ?? [];

  return (
    <>
      <div className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4">
        {list.map((preset) => (
          <button
            key={preset.id}
            type="button"
            onClick={() => {
              onApply(preset.values);
              setApplied(preset.id);
              window.setTimeout(() => setApplied(null), 1200);
            }}
            className={cn(
              'h-9 shrink-0 rounded-full border px-3 text-sm whitespace-nowrap',
              applied === preset.id
                ? 'border-accent bg-accent text-white'
                : 'border-line bg-surface text-body active:bg-surface-2',
            )}
          >
            {preset.name}
          </button>
        ))}

        <button
          type="button"
          onClick={() => setSaving(true)}
          className="h-9 shrink-0 rounded-full border border-dashed border-line px-3 text-sm whitespace-nowrap text-muted active:bg-surface-2"
        >
          {list.length === 0 ? 'Save these settings' : '+ Save'}
        </button>
      </div>

      <Sheet open={saving} onClose={() => setSaving(false)} title="Presets">
        <div className="space-y-4">
          <div className="space-y-2">
            <span className="text-xs tracking-wide text-muted uppercase">
              Save the current settings
            </span>
            <div className="flex gap-2">
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="e.g. Fast draft"
                className="min-w-0 flex-1 rounded-xl border border-line bg-surface px-4 py-3 focus:border-accent focus:outline-none"
              />
              <Button
                variant="primary"
                busy={save.isPending}
                disabled={name.trim() === ''}
                onClick={async () => {
                  await save.mutateAsync({ name: name.trim(), values });
                  setName('');
                  setSaving(false);
                }}
              >
                Save
              </Button>
            </div>
            <p className="text-xs text-muted">
              Saving under an existing name replaces it.
            </p>
          </div>

          {list.length > 0 && (
            <div className="space-y-2">
              <span className="text-xs tracking-wide text-muted uppercase">Saved</span>
              <ul className="space-y-1">
                {list.map((preset) => (
                  <li
                    key={preset.id}
                    className="flex items-center justify-between gap-3 rounded-xl border border-line px-3 py-2"
                  >
                    <span className="min-w-0 truncate text-sm">{preset.name}</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      busy={remove.isPending}
                      onClick={() => remove.mutate(preset.id)}
                    >
                      Delete
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </Sheet>
    </>
  );
}

/**
 * Controls that need a whole row: anything holding text, or an image.
 *
 * Everything else is a chip that states its own name and value, so it can sit
 * next to its neighbours instead of claiming a line.
 */
function isWideControl(field: ParamField): boolean {
  // An explicit width wins: the whole point of setting one is to override what
  // the control type would have chosen.
  if (field.width) return field.width === 'full';
  return field.control === 'textarea' || field.control === 'text' || field.control === 'image';
}

/** Advanced fields are rendered inline rather than behind another sheet. */
function AdvancedRow({
  field,
  value,
  onChange,
}: {
  field: ParamField;
  value: WidgetValue;
  onChange: (value: WidgetValue) => void;
}) {
  if (isWideControl(field)) {
    // The label is already printed above the row, so hide the control's own.
    return (
      <div className="[&>label>span:first-child]:hidden">
        <FieldChipFallback field={field} value={value} onChange={onChange} />
      </div>
    );
  }
  return <FieldChip field={field} value={value} onChange={onChange} />;
}

function FieldChipFallback({
  field,
  value,
  onChange,
}: {
  field: ParamField;
  value: WidgetValue;
  onChange: (value: WidgetValue) => void;
}) {
  if (field.control === 'image') {
    return <ImageField field={field} value={value} onChange={onChange} />;
  }
  if (field.control === 'textarea') {
    return <PromptField field={field} value={value} onChange={onChange} compact />;
  }
  return (
    <input
      type="text"
      value={typeof value === 'string' ? value : String(value ?? '')}
      onChange={(event) => onChange(event.target.value)}
      className="w-full rounded-xl border border-line bg-surface px-4 py-2.5 focus:border-accent focus:outline-none"
    />
  );
}
