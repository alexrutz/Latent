import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import {
  applyPresetChat,
  defaultValues,
  findFieldByRole,
  groupByNode,
  isLlamaServerField,
  matchSystemPrompt,
  planFormRuns,
  usesPointLine,
} from '@latent/shared';
import type {
  ConnectionSummary,
  ParamField,
  ParamValues,
  SystemPrompt,
  WidgetValue,
  WorkflowSummary,
} from '@latent/shared';

import {
  useConnections,
  useDeletePreset,
  useSystemPrompts,
  useEndless,
  useGenerate,
  usePresets,
  usePromptMode,
  useRescanWorkflow,
  useSavePreset,
  useSetEndless,
  useWorkflow,
  useVisibleWorkflows,
  useWorkflows,
} from '../api/queries';
import { AlwaysBlocks } from '../components/AlwaysBlocks';
import { GenerateWorkbench } from '../components/GenerateWorkbench';
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
import { useWide } from '../state/layout';
import { useLiveStore } from '../state/live';
import { usePendingStore } from '../state/pending';
import { savePromptDraft } from '../state/promptDraft';

const LAST_WORKFLOW_KEY = 'latent.lastWorkflowId';

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

    // The folder browser draws the same control; only the second button's
    // dialog differs, which is the field's own business rather than this one's.
    case 'image_input':
    case 'folder_image':
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
  const wide = useWide();

  const [workflowId, setWorkflowId] = useState<string | null>(() =>
    localStorage.getItem(LAST_WORKFLOW_KEY),
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

  const form = (
    <GenerateForm
      key={workflowId ?? 'none'}
      workflowQuery={workflow}
      workflows={workflows.data}
      workflowId={workflowId}
      onSelectWorkflow={setWorkflowId}
      consumePending={consumePending}
    />
  );

  if (!wide) return form;

  /*
   * Two panes: the settings, and what they made.
   *
   * The form keeps a fixed width rather than sharing the space evenly. It is a
   * column of labelled rows and chips whose ideal width is a phone's — wider
   * only spreads a label away from its own control — while the picture beside
   * it is worth every pixel that is left. So the form gets what it needs and
   * the render gets the rest, which on a nine-inch screen turned sideways is
   * roughly half each and on anything bigger is mostly picture.
   *
   * The form scrolls inside its own column, not with the page: the whole point
   * is that the render stays put while you go through the settings.
   */
  return (
    <div className="flex h-full min-h-0">
      <div className="min-h-0 w-[25rem] shrink-0 overflow-y-auto overscroll-contain">{form}</div>
      <GenerateWorkbench workflowId={workflowId} />
    </div>
  );
}

interface GenerateFormProps {
  workflowQuery: ReturnType<typeof useWorkflow>;
  workflows: WorkflowSummary[];
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
  const wide = useWide();
  const comfyOnline = useLiveStore((state) => state.live.comfyOnline);

  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  /*
   * Reset asks twice, and disarms itself.
   *
   * It throws away a prompt somebody wrote, and it sits at the top of the
   * screen beside the workflow picker where a thumb reaching for the picker
   * passes over it. One tap arms it, the next does it, and if neither happens
   * it goes back to being an icon rather than sitting armed until the next
   * accidental tap lands on it.
   */
  const [confirmReset, setConfirmReset] = useState(false);
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
  const rescan = useRescanWorkflow();

  useEffect(() => {
    if (!confirmReset) return;
    const timer = setTimeout(() => setConfirmReset(false), 4000);
    return () => clearTimeout(timer);
  }, [confirmReset]);

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
  const mainRuns = useMemo(
    () => planFormRuns(fields.filter((candidate) => candidate.group === 'main')),
    [fields],
  );

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
      {/*
        A column, capped, in the middle.

        The cap only bites where there is no pane beside the form — a tablet
        held upright, where Generate is one column across seven hundred points.
        Stretched that far a chip is a label and a value at opposite ends of a
        hand's width, and the prompt is one line of forty words. Where the pane
        *is* beside it the form is already narrower than this, so the cap costs
        nothing and there is no second layout to keep in step.
      */}
      <div className="safe-t flex min-h-full flex-col gap-3 px-4 pt-2 pb-2 tablet:mx-auto tablet:w-full tablet:max-w-[40rem]">
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

          {/*
            The connection light, and under it the way out of a form that has
            got itself into a state.

            Two things in one gesture, because they are one thought: put this
            workflow back the way it comes. The values go to the graph's own
            defaults — not the last run's, which is history rather than the
            workflow — and the schema is re-read from ComfyUI, so a model
            installed since, or a custom node that was missing, turns up in the
            dropdowns without a trip to Settings.

            Under the light rather than beside the picker: it is about the
            workflow's connection to the machine, which is what the light is
            about, and putting it in the row proper would have it competing with
            the one control up here anybody uses often.
          */}
          <div className="flex shrink-0 flex-col items-center gap-1.5">
            <span
              title={comfyOnline ? 'ComfyUI connected' : 'ComfyUI unreachable'}
              className={cn('size-2.5 rounded-full', comfyOnline ? 'bg-success' : 'bg-danger')}
            />
            <button
              type="button"
              aria-label={confirmReset ? 'Reset this workflow — sure?' : 'Reset this workflow'}
              title={
                confirmReset
                  ? 'Tap again to throw away what is set up here'
                  : 'Put the form back to the workflow’s own values and re-read it from ComfyUI'
              }
              onClick={() => {
                if (!confirmReset) return setConfirmReset(true);
                setConfirmReset(false);
                setError(null);

                /*
                 * The values first, because that half cannot fail: it is a
                 * local store, and a ComfyUI that has gone away must not be
                 * the reason the form stays stuck.
                 */
                setDraft(detail.id, {
                  values: { ...defaultValues(detail.schema) },
                  lockedSeeds: [],
                  batchCount: 1,
                });

                rescan.mutate(detail.id, {
                  // Seeded again from the schema that just came back: a rescan
                  // can add a field, and one left at `undefined` submits
                  // nothing rather than its default.
                  onSuccess: (fresh) =>
                    setDraft(fresh.id, {
                      values: { ...defaultValues(fresh.schema) },
                      lockedSeeds: [],
                      batchCount: 1,
                    }),
                  onError: (cause) =>
                    setError(
                      cause instanceof Error
                        ? `The form was reset, but ComfyUI could not be re-read: ${cause.message}`
                        : 'The form was reset, but ComfyUI could not be re-read.',
                    ),
                });
              }}
              className={cn(
                'rounded-md px-1.5 py-0.5 text-[11px] leading-none',
                confirmReset ? 'bg-danger/20 text-danger' : 'bg-surface-2 text-muted',
              )}
            >
              {rescan.isPending ? <Spinner className="size-3" /> : confirmReset ? 'Sure?' : '⟳'}
            </button>
          </div>
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
            <div
              key={`chips-${runIndex}`}
              className={cn(
                'grid gap-1.5',
                // Three across where the form has the whole screen to itself, two
                // where it is sharing it with the render — the column is four
                // hundred points there, and a third of that is not a chip.
                wide ? 'grid-cols-2' : 'grid-cols-2 tablet:grid-cols-3',
              )}
            >
              {/* `col-span-full` rather than `col-span-2`: "full" means the whole
                row, and the row is not always two columns wide. */}
              {run.fields.map((field) => (
                <div
                  key={field.id}
                  className={cn('min-w-0', field.width === 'full' && 'col-span-full')}
                >
                  {/*
                    A point line that was explicitly set to half width sits in
                    this grid, and has to stay a point line: swapping it for a
                    chip here would answer "make it narrower" by silently
                    replacing the control.
                  */}
                  {usesPointLine(field) ? (
                    <PointLine
                      field={field}
                      value={values[field.id] ?? field.defaultValue}
                      onChange={(value) => setValue(field.id, value)}
                    />
                  ) : (
                    <FieldChip
                      field={field}
                      value={values[field.id] ?? field.defaultValue}
                      onChange={(value) => setValue(field.id, value)}
                      block
                    />
                  )}
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
              Chips, under the node each one came off.

              Two things were wrong with one flat run of them. A chip carries
              its own label and value, which is why there is no heading per
              field — but a label alone is only half the name: `denoise`,
              `strength`, `end_at_step` mean nothing until you know which node
              they belong to, and a graph with two samplers has the same word
              twice with nothing to tell them apart. And thirty of them in a
              heap is a list you scan rather than a list you navigate.

              The wide controls (text, image) still take a full row inside
              their group, because they cannot be read in half of one.
            */}
              <div className="space-y-4">
                {groupByNode(advancedFields).map((group) => (
                  <section key={group.nodeId} className="space-y-1.5">
                    <h3 className="flex items-baseline gap-2 border-b border-line pb-1">
                      <span className="min-w-0 truncate text-xs font-medium tracking-wide text-muted uppercase">
                        {group.title}
                      </span>
                      <span className="shrink-0 text-[11px] text-muted/70">
                        {group.fields.length}
                      </span>
                    </h3>
                    <div className="flex flex-wrap gap-1.5">
                      {group.fields.map((field) => (
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
                  </section>
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
              ⁂ Prompt drawn from blocks: {randomMode.data.minBlocks}–{randomMode.data.maxBlocks}{' '}
              per run
            </p>
          )}

          {/*
          Progress and Generate share one row.
          Stacked, they cost two rows of a phone screen for two things you look
          at together — and the form is what the space is for. The bar only
          appears while something is running or has just finished, so an idle
          screen still gives the button the full width.

          Not where the pane is beside the form, which is showing the same run
          at ten times the size with the same progress underneath it. A
          thumbnail of the picture you are already looking at is not a summary
          of anything, and dropping it gives Generate the whole width back.
        */}
          <div className="flex items-stretch gap-2">
            {!wide && <LiveBar inline />}
            <Button
              variant="primary"
              size="lg"
              fullWidth={!barInRow || wide}
              className={barInRow && !wide ? 'shrink-0' : undefined}
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
              Generating until stopped · {endless.data.queued} so far · Update applies to the next
              run
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
                  <span className="flex shrink-0 items-center gap-2">
                    {/* Which of these makes a clip rather than a picture is the
                      first thing you want to know about a list of workflows,
                      and the name does not reliably say. */}
                    {item.producesVideo && (
                      <span className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[10px] text-muted">
                        video
                      </span>
                    )}
                    {item.producesAudio && (
                      <span className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[10px] text-muted">
                        sound
                      </span>
                    )}
                    {item.id === workflowId && <span aria-hidden>✓</span>}
                  </span>
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
            <p className="text-xs text-muted">Saving under an existing name replaces it.</p>
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
    return <FilledFromServer field={field} server={server} showLabel={!isWideControl(field)} />;
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
          The prompt is copied across and that workflow is opened. Its own settings are left exactly
          as you had them.
        </p>
      </Sheet>
    </>
  );
}
