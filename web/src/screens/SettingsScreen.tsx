import { useRef, useState } from 'react';

import type { FieldOverrides, ParamField, WorkflowSummary } from '@latent/shared';

import { api } from '../api/client';
import {
  useDeleteWorkflow,
  useImportWorkflow,
  useRescanWorkflow,
  useSettings,
  useStatus,
  useUpdateSettings,
  useUpdateWorkflow,
  useWorkflow,
  useWorkflows,
} from '../api/queries';
import { Toggle } from '../components/ParamControl';
import { Button, Card, cn, ErrorNote, Row, Sheet, Spinner } from '../components/ui';

export function SettingsScreen() {
  const status = useStatus();
  const workflows = useWorkflows();
  const settings = useSettings();
  const updateSettings = useUpdateSettings();
  const importWorkflow = useImportWorkflow();
  const fileRef = useRef<HTMLInputElement>(null);

  const [importError, setImportError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  const onFile = async (file: File) => {
    setImportError(null);
    try {
      const text = await file.text();
      const graph: unknown = JSON.parse(text);
      const name = file.name.replace(/\.json$/i, '').replace(/[_-]+/g, ' ');
      await importWorkflow.mutateAsync({ name, graph });
    } catch (cause) {
      setImportError(
        cause instanceof SyntaxError
          ? 'That file is not valid JSON.'
          : cause instanceof Error
            ? cause.message
            : 'Import failed',
      );
    }
  };

  const device = status.data?.devices[0];

  return (
    <div className="safe-t space-y-6 px-4 pt-3 pb-6">
      <h1 className="text-xl font-semibold">Settings</h1>

      {/* Connection ------------------------------------------------- */}
      <section className="space-y-2">
        <h2 className="text-xs font-medium tracking-wide text-muted uppercase">ComfyUI</h2>
        <Card className="divide-y divide-line py-0">
          <Row
            label={status.data?.comfyOnline ? 'Connected' : 'Not reachable'}
            hint={status.data?.comfyUrl || undefined}
          >
            <span
              className={cn(
                'size-2.5 rounded-full',
                status.data?.comfyOnline ? 'bg-success' : 'bg-danger',
              )}
            />
          </Row>
          {status.data?.comfyVersion && (
            <Row label="Version" hint={status.data.comfyVersion} />
          )}
          {device && (
            <Row
              label={device.name}
              hint={`${formatBytes(device.vramFree)} free of ${formatBytes(device.vramTotal)} VRAM`}
            />
          )}
        </Card>
      </section>

      {/* Workflows -------------------------------------------------- */}
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-medium tracking-wide text-muted uppercase">Workflows</h2>
          <Button
            variant="secondary"
            size="sm"
            busy={importWorkflow.isPending}
            onClick={() => fileRef.current?.click()}
          >
            Import
          </Button>
        </div>

        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void onFile(file);
            event.target.value = '';
          }}
        />

        <ErrorNote>{importError}</ErrorNote>

        {workflows.data?.length === 0 && (
          <Card>
            <p className="text-sm text-muted">
              No workflows yet. In ComfyUI, open the workflow you want and choose{' '}
              <strong className="text-body">Workflow → Export (API)</strong>, then import that file
              here.
            </p>
          </Card>
        )}

        <div className="space-y-2">
          {workflows.data?.map((workflow) => (
            <WorkflowRow key={workflow.id} workflow={workflow} onEdit={() => setEditing(workflow.id)} />
          ))}
        </div>
      </section>

      {/* Shortcut targets ------------------------------------------- */}
      {(workflows.data?.length ?? 0) > 0 && (
        <section className="space-y-2">
          <h2 className="text-xs font-medium tracking-wide text-muted uppercase">
            Gallery shortcuts
          </h2>
          <Card className="space-y-3">
            <p className="text-xs text-muted">
              Which workflow the gallery’s buttons should open. Only workflows with an image input
              can receive a picture.
            </p>
            <WorkflowPicker
              label="img2img"
              workflows={workflows.data ?? []}
              value={settings.data?.img2imgWorkflowId ?? null}
              onChange={(id) => updateSettings.mutate({ img2imgWorkflowId: id })}
            />
            <WorkflowPicker
              label="Upscale"
              workflows={workflows.data ?? []}
              value={settings.data?.upscaleWorkflowId ?? null}
              onChange={(id) => updateSettings.mutate({ upscaleWorkflowId: id })}
            />
          </Card>
        </section>
      )}

      {/* Session ---------------------------------------------------- */}
      {status.data?.authRequired && (
        <section className="space-y-2">
          <h2 className="text-xs font-medium tracking-wide text-muted uppercase">Session</h2>
          <Button
            variant="secondary"
            onClick={async () => {
              await api.logout();
              window.location.reload();
            }}
          >
            Sign out
          </Button>
        </section>
      )}

      <p className="pt-2 text-center text-xs text-muted">Latent — a mobile client for ComfyUI</p>

      {editing && <FormEditorSheet workflowId={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function WorkflowRow({
  workflow,
  onEdit,
}: {
  workflow: WorkflowSummary;
  onEdit: () => void;
}) {
  const remove = useDeleteWorkflow();
  const rescan = useRescanWorkflow();
  const [confirming, setConfirming] = useState(false);

  return (
    <Card className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-medium">{workflow.name}</p>
          <p className="text-xs text-muted">
            {workflow.capabilities.img2img ? 'Accepts an image' : 'Text to image'}
            {workflow.capabilities.seeded ? ' · seeded' : ''}
          </p>
          {workflow.missingNodeTypes.length > 0 && (
            <p className="mt-1 text-xs text-warn">
              Missing nodes: {workflow.missingNodeTypes.join(', ')}
            </p>
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" size="sm" onClick={onEdit}>
          Edit form
        </Button>
        <Button
          variant="secondary"
          size="sm"
          busy={rescan.isPending}
          onClick={() => rescan.mutate(workflow.id)}
          title="Re-read node definitions from ComfyUI, picking up newly installed models"
        >
          Refresh models
        </Button>
        {confirming ? (
          <>
            <Button
              variant="danger"
              size="sm"
              busy={remove.isPending}
              onClick={() => remove.mutate(workflow.id)}
            >
              Really delete
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <Button variant="ghost" size="sm" onClick={() => setConfirming(true)}>
            Delete
          </Button>
        )}
      </div>
    </Card>
  );
}

function WorkflowPicker({
  label,
  workflows,
  value,
  onChange,
}: {
  label: string;
  workflows: WorkflowSummary[];
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-3">
      <span className="text-sm">{label}</span>
      <select
        value={value ?? ''}
        onChange={(event) => onChange(event.target.value || null)}
        className="min-w-0 max-w-[60%] truncate rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm"
      >
        <option value="">Not set</option>
        {workflows.map((workflow) => (
          <option key={workflow.id} value={workflow.id}>
            {workflow.name}
          </option>
        ))}
      </select>
    </label>
  );
}

/* ------------------------------------------------------------------ */
/* Form editor                                                         */
/* ------------------------------------------------------------------ */

/**
 * Lets the user correct the automatic form layout.
 *
 * The role heuristics get the common workflows right, but no heuristic will
 * ever handle every custom node. Rather than hiding that, this exposes every
 * field and lets the user promote, hide or rename any of them — overrides are
 * stored apart from the derived schema, so "Refresh models" never wipes them.
 */
function FormEditorSheet({ workflowId, onClose }: { workflowId: string; onClose: () => void }) {
  const workflow = useWorkflow(workflowId);
  const update = useUpdateWorkflow();
  const [draft, setDraft] = useState<FieldOverrides | null>(null);

  const detail = workflow.data;
  const overrides = draft ?? detail?.overrides ?? {};

  const patch = (fieldId: string, change: Partial<FieldOverrides[string]>) => {
    const next: FieldOverrides = {
      ...overrides,
      [fieldId]: { ...overrides[fieldId], ...change },
    };
    setDraft(next);
    update.mutate({ id: workflowId, patch: { overrides: next } });
  };

  return (
    <Sheet open onClose={onClose} title={detail?.name ?? 'Form'} full>
      {!detail ? (
        <div className="grid place-items-center py-12">
          <Spinner className="size-6 text-muted" />
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-xs text-muted">
            Choose what appears on the Generate screen. Hidden fields still use the value the
            workflow was exported with.
          </p>

          {(['main', 'advanced'] as const).map((group) => {
            const fields = detail.schema.fields.filter((field) => field.group === group);
            if (fields.length === 0) return null;
            return (
              <div key={group} className="space-y-2">
                <h3 className="text-xs font-medium tracking-wide text-muted uppercase">
                  {group === 'main' ? 'On the main screen' : 'Under Advanced'}
                </h3>
                {fields.map((field) => (
                  <FieldEditorRow
                    key={field.id}
                    field={field}
                    onRename={(label) => patch(field.id, { label })}
                    onToggleHidden={() => patch(field.id, { hidden: !field.hidden })}
                    onMove={() =>
                      patch(field.id, { group: field.group === 'main' ? 'advanced' : 'main' })
                    }
                  />
                ))}
              </div>
            );
          })}
        </div>
      )}
    </Sheet>
  );
}

function FieldEditorRow({
  field,
  onRename,
  onToggleHidden,
  onMove,
}: {
  field: ParamField;
  onRename: (label: string) => void;
  onToggleHidden: () => void;
  onMove: () => void;
}) {
  const [label, setLabel] = useState(field.label);

  return (
    <div className={cn('rounded-xl border border-line p-3', field.hidden && 'opacity-50')}>
      <div className="flex items-center gap-3">
        <input
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          onBlur={() => label !== field.label && onRename(label)}
          className="min-w-0 flex-1 rounded-lg bg-surface-2 px-3 py-2 text-sm focus:outline-none"
        />
        <Toggle checked={!field.hidden} onChange={onToggleHidden} />
      </div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <p className="min-w-0 truncate text-[11px] text-muted">
          {field.nodeTitle} · {field.inputName} · {field.control}
        </p>
        <Button variant="ghost" size="sm" onClick={onMove}>
          {field.group === 'main' ? 'To Advanced' : 'To main'}
        </Button>
      </div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (!bytes) return '—';
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}
