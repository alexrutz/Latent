import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import {
  applyPresetChat,
  defaultValues,
  findFieldByRole,
  isLlamaServerField,
  matchSystemPrompt,
  usesPointLine,
} from '@latent/shared';
import type {
  ConnectionSummary,
  ParamField,
  ParamValues,
  SystemPrompt,
  WidgetValue,
} from '@latent/shared';

import {
  useConnections,
  useDeletePreset,
  useSystemPrompts,
  useEndless,
  useGenerate,
  usePresets,
  usePromptMode,
  useSavePreset,
  useSetEndless,
  useWorkflow,
  useVisibleWorkflows,
  useWorkflows,
} from '../api/queries';
import { AlwaysBlocks } from '../components/AlwaysBlocks';
import { LiveBar } from '../components/LiveBar';
import { LoraEditor } from '../components/LoraEditor';
import { PointLine } from '../components/PointLine';
import { PromptBuilder } from '../components/PromptBuilder';
import {
  FieldChip,
  ImageField,
  PromptField,
  SeedField,
  WorkflowScope,
} from '../components/ParamControl';
import { Button, cn, EmptyState, ErrorNote, Sheet, Spinner } from '../components/ui';
import { pruneDrafts, useFormDrafts } from '../state/formDraft';
import { useLiveStore } from '../state/live';
import { usePendingStore } from '../state/pending';
import { savePromptDraft } from '../state/promptDraft';

const LAST_WORKFLOW_KEY = 'latent.lastWorkflowId';

/** Roles that get a control of their own rather than a chip in the grid. */
const DEDICATED_ROLES = new Set<ParamField['role']>([
  'prompt',
  'negative_prompt',
  'image_input',
  'seed',
  'lora_text',
]);

/**
 * One field on the main screen, rendered as whatever it is.
 *
 * Split out so the ordered walk above stays a walk: which control a field gets
 * is a property of the field, and where it sits is a property of the list.
 */
function MainField({
  field,
  values,
  setValue,
  lockedSeeds,
  onToggleSeedLock,
  workflows,
  workflowId,
  onSendToWorkflow,
}: {
  field: ParamField;
  values: ParamValues;
  setValue: (id: string, value: WidgetValue) => void;
  lockedSeeds: string[];
  onToggleSeedLock: (id: string) => void;
  workflows: { id: string; name: string }[];
  workflowId: string | null;
  onSendToWorkflow: (id: string, text: string) => void;
}) {
  const value = values[field.id] ?? field.defaultValue;
  const filled = useFilledFrom(field);
  const server = useModelServer();

  // A field the prompt library owns is shown, not offered: whatever were typed
  // here would be replaced on the way to ComfyUI, which is a worse lie than
  // saying where the text comes from.
  if (filled) return <FilledFromPrompt field={field} prompt={filled} />;
  if (server && isLlamaServerField(field)) {
    return <FilledFromServer field={field} server={server} />;
  }

  switch (field.role) {
    case 'prompt':
      return (
        <div className="space-y-2">
          <PromptField
            field={field}
            value={values[field.id] ?? ''}
            onChange={(next) => setValue(field.id, next)}
          />
          <div className="flex flex-wrap items-center gap-4">
            {/* Assemble the prompt from saved fragments rather than typing. */}
            <PromptBuilder
              value={String(values[field.id] ?? '')}
              onChange={(next) => setValue(field.id, next)}
            />
            {/* The phrases that go on everything, chosen once. */}
            <AlwaysBlocks />
            {/* The same words through a different graph, without the round trip
                through the clipboard. */}
            <SendToWorkflow
              workflows={workflows}
              workflowId={workflowId}
              onSend={(id) => onSendToWorkflow(id, String(values[field.id] ?? ''))}
            />
            {/*
              No LoRA editor here any more. LoRA tags belong in the field that
              exists to hold them — offering to write them into the description
              of the picture put them somewhere the workflow may well not read,
              and made two places responsible for one thing.
            */}
          </div>
        </div>
      );

    case 'negative_prompt':
      return (
        <PromptField
          field={field}
          value={values[field.id] ?? ''}
          onChange={(next) => setValue(field.id, next)}
          compact
        />
      );

    case 'lora_text':
      return (
        <LoraEditor
          label={field.label}
          alwaysShow
          value={String(values[field.id] ?? '')}
          onChange={(next) => setValue(field.id, next)}
        />
      );

    case 'image_input':
      return (
        <ImageField
          field={field}
          value={values[field.id] ?? ''}
          onChange={(next) => setValue(field.id, next)}
        />
      );

    case 'seed':
      return (
        <SeedField
          field={field}
          value={value}
          onChange={(next) => setValue(field.id, next)}
          locked={lockedSeeds.includes(field.id)}
          onToggleLock={() => onToggleSeedLock(field.id)}
        />
      );

    default:
      /*
       * Fields set to a point line get a row of their own — the whole point is
       * that the values are on screen, which needs the width.
       */
      return (
        <PointLine field={field} value={value} onChange={(next) => setValue(field.id, next)} />
      );
  }
}

export function GenerateScreen() {
  const navigate = useNavigate();
  const workflows = useVisibleWorkflows();
  const allWorkflows = useWorkflows();
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
    // Told apart deliberately: "none imported" and "all of them switched off"
    // are different problems with different fixes.
    const hidden = (allWorkflows.data?.length ?? 0) > 0;
    return (
      <EmptyState
        icon="✦"
        title={hidden ? 'No workflows switched on' : 'No workflows yet'}
        hint={
          hidden
            ? 'Every workflow is hidden from this picker. Choose the ones you use in Settings.'
            : 'Point Latent at your ComfyUI folder in Settings and it will read the workflows saved there.'
        }
        action={
          <Button variant="primary" onClick={() => navigate('/settings')}>
            {hidden ? 'Choose workflows' : 'Open settings'}
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
  const endless = useEndless();
  const setEndless = useSetEndless();
  const randomMode = usePromptMode();
  const setPending = usePendingStore((state) => state.setPending);
  const job = useLiveStore((state) => state.live.job);
  /*
   * A finished run sits in the same row as the button until it is dismissed,
   * so it counts for the layout exactly as a running one does. Reading only
   * `job` here left the button asking for the whole row while the result bar
   * was already in it, and flex gave the button what was left — a sliver.
   */
  const finished = useLiveStore((state) => state.finished);
  const barInRow = Boolean(job || finished);
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

    /*
     * A prompt sent over from another workflow changes the prompt and nothing
     * else. "Reuse these settings" is the opposite — it replaces the lot — so
     * the two start from different places: this one from whatever is already
     * set up here, that one from the workflow's own defaults.
     */
    const carriedPrompt = reused && handoff?.promptText && !handoff.values;
    const base =
      carriedPrompt && stored
        ? { ...stored.values }
        : { ...defaultValues(detail.schema), ...detail.lastValues };

    if (reused) {
      Object.assign(base, handoff?.values ?? {});

      for (const field of detail.schema.fields) {
        if (field.role === 'prompt' && handoff?.promptText?.positive !== undefined) {
          base[field.id] = handoff.promptText.positive;
        }
        if (field.role === 'negative_prompt' && handoff?.promptText?.negative !== undefined) {
          base[field.id] = handoff.promptText.negative;
        }
      }

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

  /*
   * The preset-chat node's slots are named in the form itself, so its picker
   * only knows what to offer once the values are in hand — and it has to be
   * re-derived as they change, because renaming a slot is what the dropdown
   * below it is supposed to reflect.
   */
  const schema = useMemo(
    () => (detail ? applyPresetChat(detail.schema, values) : null),
    [detail, values],
  );

  const fields = useMemo(
    () => (schema ? schema.fields.filter((field) => !field.hidden) : []),
    [schema],
  );

  const byRole = (role: ParamField['role']) => fields.filter((field) => field.role === role);
  const promptFields = byRole('prompt');
  const seedFields = byRole('seed');

  const advancedFields = fields.filter((field) => field.group === 'advanced');

  /**
   * The main screen, in stored order, with consecutive chips gathered up.
   *
   * A chip is half a row wide, so several in a row belong in one grid; anything
   * else — a prompt box, an image picker, a point line — takes the full width
   * and stands alone. Grouping only ever merges *adjacent* chips, so the order
   * the user dragged them into is preserved exactly.
   */
  const mainRuns = useMemo(() => {
    const runs: { kind: 'chips' | 'block'; fields: ParamField[] }[] = [];
    for (const field of fields.filter((candidate) => candidate.group === 'main')) {
      const chip = !DEDICATED_ROLES.has(field.role) && !usesPointLine(field);
      const last = runs[runs.length - 1];
      if (chip && last?.kind === 'chips') last.fields.push(field);
      else runs.push({ kind: chip ? 'chips' : 'block', fields: [field] });
    }
    return runs;
  }, [fields]);

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

  /**
   * Carry the prompt over to another workflow and switch to it.
   *
   * Through the same one-shot handoff the gallery's "reuse" uses, because the
   * target's schema is not loaded yet and its prompt field has an id this
   * screen has never seen — so the text travels by *role* and is applied once
   * the other form knows what its fields are. Everything else there stays as it
   * was left: this is "try these words in the other graph", not "replace that
   * graph's settings with this one's".
   */
  const sendToWorkflow = (id: string, text: string) => {
    const negativeField = detail
      ? detail.schema.fields.find((field) => field.role === 'negative_prompt')
      : undefined;
    setPending({
      workflowId: id,
      promptText: {
        positive: text,
        ...(negativeField ? { negative: String(values[negativeField.id] ?? '') } : {}),
      },
    });
    onSelectWorkflow(id);
  };

  const anySeedUnlocked = seedFields.some((field) => !lockedSeeds.includes(field.id));

  /** What is on screen, in the shape both the queue and the endless runner take. */
  const currentRequest = () => ({
    workflowId: detail!.id,
    values,
    // A locked seed means "give me this exact image again"; otherwise every
    // run should differ, which is what people expect from a Generate button.
    randomizeSeeds: anySeedUnlocked,
    lockedSeedFields: lockedSeeds,
    batchCount,
  });

  const submit = async () => {
    if (!detail) return;
    setError(null);
    try {
      /*
       * While endless is running, Generate queues nothing.
       *
       * It hands over the settings, and the next run — the one after whatever
       * is already in flight — uses them. Queueing here as well would put a
       * batch in front of the change, so you would watch several pictures made
       * under the old values before seeing the new ones.
       */
      if (endless.data?.enabled) {
        await setEndless.mutateAsync({ ...currentRequest(), enabled: true });
      } else {
        await generate.mutateAsync(currentRequest());
      }
      setJustQueued(Date.now());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not queue the prompt');
    }
  };

  const toggleEndless = async () => {
    if (!detail) return;
    setError(null);
    try {
      await setEndless.mutateAsync({
        ...currentRequest(),
        enabled: !endless.data?.enabled,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not change that');
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
    // The scope an empty combo needs in order to ask the server what its
    // options actually are. min-h-full so `mt-auto` on the pinned footer has
    // something to push against on a form too short to scroll.
    <WorkflowScope workflowId={detail.id}>
      <div className="safe-t flex min-h-full flex-col gap-3 px-4 pt-2 pb-2">
      {/* Workflow selector + connection state */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setShowPicker(true)}
          // Labelled rather than named by its contents: what it *says* is the
          // workflow you are on, which is not what the control is.
          aria-label="Choose workflow"
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

      {/*
        Rendered in the order the form editor was left in, not grouped by role.

        Bucketing by role — every prompt, then every LoRA field, then the chips —
        was simple and made the editor's drag-and-drop a lie: you could reorder
        the list all you liked and the Generate screen kept its own fixed
        sequence. The order stored per field is the order here. Consecutive
        chips still collapse into one two-column grid, because that is a layout
        decision about chips rather than a reordering of them.
      */}
      {mainRuns.map((run, runIndex) =>
        run.kind === 'chips' ? (
          /*
            A two-column grid, not a wrapping row.

            Wrapping put chips of every width wherever they happened to land,
            which read as a scattered heap rather than a list of settings. Equal
            columns line the labels up, so the sampler block can be scanned down
            instead of hunted through.
          */
          <div key={`chips-${runIndex}`} className="grid grid-cols-2 gap-1.5">
            {run.fields.map((field) => (
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
        ) : (
          <MainField
            key={run.fields[0]!.id}
            field={run.fields[0]!}
            values={values}
            setValue={setValue}
            workflows={workflows}
            workflowId={workflowId}
            onSendToWorkflow={sendToWorkflow}
            lockedSeeds={lockedSeeds}
            onToggleSeedLock={(id) =>
              patchDraft(detail.id, {
                lockedSeeds: lockedSeeds.includes(id)
                  ? lockedSeeds.filter((seed) => seed !== id)
                  : [...lockedSeeds, id],
              })
            }
          />
        ),
      )}

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
      {/*
        `overflow-hidden` because this is pinned: anything inside it that turns
        out to be wider than the screen — a ComfyUI error naming half a dozen
        nodes, say — would otherwise stretch the bar and let the whole page be
        dragged sideways.
      */}
      <div className="sticky bottom-0 -mx-4 mt-auto space-y-1 overflow-hidden border-t border-line bg-ink px-4 pt-2 pb-1">
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
          appears while something is running or has just finished, so an idle
          screen still gives the button the full width.
        */}
        <div className="flex items-stretch gap-2">
          <LiveBar inline />
          <Button
            variant="primary"
            size="lg"
            fullWidth={!barInRow}
            className={barInRow ? 'shrink-0' : undefined}
            onClick={submit}
            busy={generate.isPending || setEndless.isPending}
            disabled={!comfyOnline}
          >
            {justQueued
              ? endless.data?.enabled
                ? 'Updated ✓'
                : 'Queued ✓'
              : endless.data?.enabled
                ? 'Update'
                : job
                  ? `+${batchCount > 1 ? batchCount : 1}`
                  : `Generate${batchCount > 1 ? ` ×${batchCount}` : ''}`}
          </Button>
          {/*
            Endless generation. Its own switch rather than a mode buried in a
            sheet: it is the difference between the GPU working while you are
            not looking and not, and turning it off has to be as quick as
            turning it on.
          */}
          <button
            type="button"
            onClick={() => void toggleEndless()}
            aria-pressed={Boolean(endless.data?.enabled)}
            aria-label="Endless generation"
            title={
              endless.data?.enabled
                ? 'Generating until stopped — tap to stop'
                : 'Keep generating until stopped'
            }
            className={cn(
              'grid h-12 w-12 shrink-0 place-items-center rounded-xl text-xl',
              endless.data?.enabled ? 'bg-accent text-white' : 'bg-surface-2 text-muted',
            )}
          >
            ∞
          </button>
        </div>

        {endless.data?.enabled && (
          <p className="text-center text-[11px] text-accent">
            Generating until stopped · {endless.data.queued} so far · Update applies to the next run
          </p>
        )}
        {!endless.data?.enabled && endless.data?.message && (
          <p className="text-center text-[11px] text-warn">
            Endless generation stopped: {endless.data.message}
          </p>
        )}

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
    </WorkflowScope>
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

/**
 * A text input whose contents come from the collected system prompts.
 *
 * Shown rather than edited. The wording lives in one place — Settings, under
 * System prompts — precisely so that five workflows needing the same
 * instructions do not each carry their own copy of them.
 */
function FilledFromPrompt({
  field,
  prompt,
  showLabel = true,
}: {
  field: ParamField;
  prompt: SystemPrompt;
  /** Off under Advanced, where the list already prints the field's name. */
  showLabel?: boolean;
}) {
  return (
    <div className="rounded-xl border border-line bg-surface-2/40 px-3 py-2">
      <p className="text-[11px] text-muted">
        {showLabel && <span className="text-body">{field.label} — </span>}
        from the system prompt “{prompt.name}”
      </p>
      <p className="mt-1 line-clamp-2 text-[11px] text-muted">
        {prompt.text.trim() === ''
          ? 'Empty, so the workflow keeps its own text.'
          : prompt.text.replace(/\s+/g, ' ')}
      </p>
    </div>
  );
}

/**
 * A llama-server node's address, which comes from the connection in use.
 *
 * The [comfyllama](https://github.com/alexrutz/comfyllama) nodes hold the
 * address as a widget, so it is stored inside the workflow — and a rented box
 * gets a new one every time it is started. The chat already knows where the
 * model server is; putting that address in on the way out means one place to
 * change rather than one per workflow.
 */
function FilledFromServer({
  field,
  server,
  showLabel = true,
}: {
  field: ParamField;
  server: ConnectionSummary;
  /** Off under Advanced, where the list already prints the field's name. */
  showLabel?: boolean;
}) {
  return (
    <div className="rounded-xl border border-line bg-surface-2/40 px-3 py-2">
      <p className="text-[11px] text-muted">
        {showLabel && <span className="text-body">{field.label} — </span>}
        from the model server “{server.name}”
      </p>
      <p className="mt-1 truncate text-[11px] text-muted">{server.url}</p>
    </div>
  );
}

/** The model server in use, whose address those nodes are given. */
function useModelServer(): ConnectionSummary | null {
  const connections = useConnections();
  return (
    (connections.data ?? []).find(
      (connection) => connection.kind === 'llama' && connection.isActive,
    ) ?? null
  );
}

/** The saved prompt that will fill this field, if one is named after it. */
function useFilledFrom(field: ParamField): SystemPrompt | null {
  const prompts = useSystemPrompts();
  return useMemo(() => matchSystemPrompt(field, prompts.data ?? []), [field, prompts.data]);
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
  const filled = useFilledFrom(field);
  const server = useModelServer();
  if (filled) {
    return <FilledFromPrompt field={field} prompt={filled} showLabel={!isWideControl(field)} />;
  }
  if (server && isLlamaServerField(field)) {
    return (
      <FilledFromServer field={field} server={server} showLabel={!isWideControl(field)} />
    );
  }

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

/**
 * Send the prompt through a different workflow.
 *
 * The same words are worth trying through the fast draft graph and the slow
 * one, and doing that by hand meant selecting a paragraph on a phone, copying
 * it, switching workflow and pasting — four operations, one of which the
 * software should simply not require. Only the *other* workflows are listed,
 * because sending a prompt to the one it is already in does nothing.
 */
function SendToWorkflow({
  workflows,
  workflowId,
  onSend,
}: {
  workflows: { id: string; name: string }[];
  workflowId: string | null;
  onSend: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const others = workflows.filter((item) => item.id !== workflowId);

  if (others.length === 0) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-1 text-xs text-muted"
      >
        <span aria-hidden>⇢</span>
        Send to…
      </button>

      <Sheet open={open} onClose={() => setOpen(false)} title="Send the prompt to">
        <ul className="space-y-1">
          {others.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => {
                  onSend(item.id);
                  setOpen(false);
                }}
                className="w-full truncate rounded-xl px-4 py-3 text-left active:bg-surface-2"
              >
                {item.name}
              </button>
            </li>
          ))}
        </ul>
        <p className="mt-2 px-1 text-[11px] text-muted">
          The prompt is copied across and that workflow is opened. Its own settings are left
          exactly as you had them.
        </p>
      </Sheet>
    </>
  );
}
