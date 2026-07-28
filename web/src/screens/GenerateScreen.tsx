import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { defaultValues, findFieldByRole } from '@latent/shared';
import type { ParamField, ParamValues, WidgetValue } from '@latent/shared';

import { useGenerate, useWorkflow, useWorkflows } from '../api/queries';
import { FieldChip, ImageField, PromptField, SeedField } from '../components/ParamControl';
import { Button, cn, EmptyState, ErrorNote, Sheet, Spinner } from '../components/ui';
import { useLiveStore } from '../state/live';
import { usePendingStore } from '../state/pending';

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
  const job = useLiveStore((state) => state.live.job);
  const comfyOnline = useLiveStore((state) => state.live.comfyOnline);

  const [values, setValues] = useState<ParamValues>({});
  const [lockedSeeds, setLockedSeeds] = useState<string[]>([]);
  const [batchCount, setBatchCount] = useState(1);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justQueued, setJustQueued] = useState(0);
  const initialisedFor = useRef<string | null>(null);

  /**
   * Seed the form from the workflow's last-used values, then apply any pending
   * handoff on top. Runs once per workflow so typing is never clobbered by a
   * background refetch.
   */
  useEffect(() => {
    if (!detail || initialisedFor.current === detail.id) return;
    initialisedFor.current = detail.id;

    const base = { ...defaultValues(detail.schema), ...detail.lastValues };
    const handoff = consumePending();

    if (handoff?.workflowId === detail.id) {
      Object.assign(base, handoff.values ?? {});

      if (handoff.imageFilename) {
        const imageField = findFieldByRole(detail.schema, 'image_input');
        if (imageField) base[imageField.id] = handoff.imageFilename;
      }
      if (handoff.freshSeed) {
        for (const field of detail.schema.fields) {
          if (field.role === 'seed') {
            base[field.id] = Math.floor(Math.random() * 2 ** 32);
          }
        }
      }
    }

    setValues(base);
  }, [detail, consumePending]);

  const fields = useMemo(
    () => (detail ? detail.schema.fields.filter((field) => !field.hidden) : []),
    [detail],
  );

  const byRole = (role: ParamField['role']) => fields.filter((field) => field.role === role);
  const promptFields = byRole('prompt');
  const negativeFields = byRole('negative_prompt');
  const imageFields = byRole('image_input');
  const seedFields = byRole('seed');

  /** Everything on the main screen that isn't given its own dedicated control. */
  const chipFields = fields.filter(
    (field) =>
      field.group === 'main' &&
      !['prompt', 'negative_prompt', 'image_input', 'seed'].includes(field.role),
  );
  const advancedFields = fields.filter((field) => field.group === 'advanced');

  const setValue = (id: string, value: WidgetValue) =>
    setValues((current) => ({ ...current, [id]: value }));

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
    <div className="safe-t flex flex-col gap-4 px-4 pt-3 pb-6">
      {/* Workflow selector + connection state */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setShowPicker(true)}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2.5 text-left active:bg-surface-2"
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

      {promptFields.map((field) => (
        <PromptField
          key={field.id}
          field={field}
          value={values[field.id] ?? ''}
          onChange={(value) => setValue(field.id, value)}
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

      {/* Horizontally scrollable so a workflow with many knobs never wraps into
          a wall of controls. */}
      {chipFields.length > 0 && (
        <div className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4">
          {chipFields.map((field) => (
            <FieldChip
              key={field.id}
              field={field}
              value={values[field.id] ?? field.defaultValue}
              onChange={(value) => setValue(field.id, value)}
            />
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
            setLockedSeeds((current) =>
              current.includes(field.id)
                ? current.filter((id) => id !== field.id)
                : [...current, field.id],
            )
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
      <div className="flex items-center justify-between rounded-xl border border-line bg-surface px-3 py-2.5">
        <span className="text-sm">Queue this many</span>
        <div className="flex items-center gap-1">
          {[1, 2, 4, 8].map((count) => (
            <button
              key={count}
              type="button"
              onClick={() => setBatchCount(count)}
              className={cn(
                'size-9 rounded-lg text-sm tabular-nums',
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
            className="flex items-center justify-between rounded-xl border border-line bg-surface px-3 py-2.5 text-left active:bg-surface-2"
          >
            <span className="text-sm">Advanced</span>
            <span className="text-xs text-muted">{advancedFields.length} settings ›</span>
          </button>

          <Sheet open={showAdvanced} onClose={() => setShowAdvanced(false)} title="Advanced" full>
            <div className="space-y-4">
              {advancedFields.map((field) => (
                <div key={field.id} className="space-y-1.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-sm">{field.label}</span>
                    <span className="truncate text-xs text-muted">{field.nodeTitle}</span>
                  </div>
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

      <Button
        variant="primary"
        size="lg"
        onClick={submit}
        busy={generate.isPending}
        disabled={!comfyOnline}
      >
        {justQueued
          ? 'Queued ✓'
          : job
            ? `Queue ${batchCount > 1 ? `${batchCount} more` : 'another'}`
            : `Generate${batchCount > 1 ? ` ×${batchCount}` : ''}`}
      </Button>

      {!comfyOnline && (
        <p className="text-center text-xs text-danger">
          ComfyUI is unreachable — check that it is running.
        </p>
      )}

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
  if (field.control === 'textarea' || field.control === 'text' || field.control === 'image') {
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
