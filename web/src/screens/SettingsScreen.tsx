import { useRef, useState } from 'react';

import { fieldPoints, fieldPointValues, usesPointLine } from '@latent/shared';
import type {
  FieldOverride,
  FieldOverrides,
  ParamField,
  WorkflowDetail,
  WorkflowSummary,
} from '@latent/shared';

import { api } from '../api/client';
import {
  useActivateLayout,
  useArchiveStats,
  useDeleteLayout,
  useDeleteWorkflow,
  useImportFiles,
  useImportScan,
  useImportWorkflow,
  useRescanWorkflow,
  useSaveLayout,
  useSettings,
  useStatus,
  useUpdateSettings,
  useUpdateWorkflow,
  useWorkflow,
  useWorkflows,
} from '../api/queries';
import { NumericInput } from '../components/NumericInput';
import { Toggle } from '../components/ParamControl';
import { Button, Card, cn, ErrorNote, Row, Sheet, Spinner } from '../components/ui';
import { ConnectionsScreen } from './ConnectionsScreen';
import { TerminalScreen } from './TerminalScreen';

export function SettingsScreen() {
  const status = useStatus();
  const workflows = useWorkflows();
  const settings = useSettings();
  const updateSettings = useUpdateSettings();
  const importWorkflow = useImportWorkflow();
  const fileRef = useRef<HTMLInputElement>(null);

  const archive = useArchiveStats();

  const [importError, setImportError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);
  const [pruning, setPruning] = useState(false);
  const [pruneResult, setPruneResult] = useState<string | null>(null);

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
            hint={status.data?.activeConnectionName ?? status.data?.comfyUrl ?? undefined}
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

      <ConnectionsScreen />

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

      {/* Archive ---------------------------------------------------- */}
      <section className="space-y-2">
        <h2 className="text-xs font-medium tracking-wide text-muted uppercase">Saved images</h2>
        <Card className="space-y-3">
          <p className="text-xs text-muted">
            Rating an image copies it onto this device, so it stays available after the ComfyUI
            instance that produced it is gone.
          </p>
          <Row
            label={`${archive.data?.images ?? 0} images stored`}
            hint={formatBytes(archive.data?.bytes ?? 0)}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              variant="ghost"
              size="sm"
              busy={pruning}
              onClick={async () => {
                setPruning(true);
                try {
                  const { removed } = await api.pruneArchive();
                  setPruneResult(`Removed ${removed} unrated ${removed === 1 ? 'copy' : 'copies'}.`);
                  await archive.refetch();
                } finally {
                  setPruning(false);
                }
              }}
            >
              Remove unrated copies
            </Button>
          </div>
          {pruneResult && <p className="text-xs text-muted">{pruneResult}</p>}
        </Card>
      </section>

      {/* Folder import ---------------------------------------------- */}
      <InputFolderSection />

      <ImportSection />

      {/* Maintenance ------------------------------------------------ */}
      {status.data?.terminalEnabled && (
        <section className="space-y-2">
          <h2 className="text-xs font-medium tracking-wide text-muted uppercase">Maintenance</h2>
          <Card className="space-y-3">
            <p className="text-xs text-muted">
              A shell on the machine running Latent. Enabled because this server was started with
              LATENT_TERMINAL set.
            </p>
            <Button variant="secondary" onClick={() => setTerminalOpen(true)}>
              Open terminal
            </Button>
          </Card>
        </section>
      )}

      {/* Session ---------------------------------------------------- */}
      <section className="space-y-2">
        <h2 className="text-xs font-medium tracking-wide text-muted uppercase">Session</h2>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => setChangingPassword(true)}>
            Change password
          </Button>
          <Button
            variant="ghost"
            onClick={async () => {
              await api.logout();
              window.location.reload();
            }}
          >
            Sign out
          </Button>
        </div>
      </section>

      <p className="pt-2 text-center text-xs text-muted">Latent — a mobile client for ComfyUI</p>

      {editing && <FormEditorSheet workflowId={editing} onClose={() => setEditing(null)} />}
      {changingPassword && <PasswordSheet onClose={() => setChangingPassword(false)} />}
      {terminalOpen && <TerminalScreen onClose={() => setTerminalOpen(false)} />}
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

          <LayoutBar workflowId={workflowId} detail={detail} />

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
                    onPatch={(change) => patch(field.id, change)}
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
  onPatch,
}: {
  field: ParamField;
  onRename: (label: string) => void;
  onToggleHidden: () => void;
  onMove: () => void;
  onPatch: (patch: FieldOverride) => void;
}) {
  const [label, setLabel] = useState(field.label);

  const numeric = field.control === 'int' || field.control === 'float';
  const points = usesPointLine(field);
  const line = fieldPoints(field);
  const preview = fieldPointValues(field);

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

      {/*
        How this value is edited. The sheet with a slider and a keyboard is right
        for something that could be anything; for steps or CFG, where you cycle
        between the same handful of numbers, a row of points is one tap instead
        of three and a keyboard.
      */}
      {numeric && (
        <div className="mt-2 space-y-1.5 border-t border-line pt-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-muted">Editing</span>
            <div className="flex gap-1">
              {(
                [
                  ['input', 'Slider'],
                  ['points', 'Points'],
                ] as const
              ).map(([mode, text]) => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={points === (mode === 'points')}
                  onClick={() => onPatch({ inputMode: mode })}
                  className={cn(
                    'h-7 rounded-md px-2 text-[11px]',
                    points === (mode === 'points')
                      ? 'bg-accent text-white'
                      : 'bg-surface-2 text-muted',
                  )}
                >
                  {text}
                </button>
              ))}
            </div>
          </div>

          {points && (
            <>
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] text-muted">from</span>
                <PointNumber
                  label={`${field.label} points from`}
                  value={line.min}
                  onChange={(min) => onPatch({ points: { ...line, min } })}
                />
                <span className="text-[10px] text-muted">to</span>
                <PointNumber
                  label={`${field.label} points to`}
                  value={line.max}
                  onChange={(max) => onPatch({ points: { ...line, max } })}
                />
                <span className="text-[10px] text-muted">step</span>
                <PointNumber
                  label={`${field.label} points step`}
                  value={line.step}
                  onChange={(step) => onPatch({ points: { ...line, step } })}
                />
              </div>
              {/* Exactly what the line will offer — no guessing from three numbers. */}
              <p className="truncate text-[10px] tabular-nums text-muted">
                {preview.slice(0, 10).join(', ')}
                {preview.length > 10 && ` … (${preview.length})`}
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** A very small number field, sized for the one-line points row. */
function PointNumber({
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
      className="w-12 shrink-0 rounded-md border-0 bg-surface-2 px-1 py-0.5 text-center text-xs"
    />
  );
}

/**
 * The folder of pictures to feed *into* workflows.
 *
 * The mirror of the import folder: that one is finished work coming in to be
 * kept, this one is reference shots, sketches and masks going out to img2img.
 * Read-only — Latent never writes here.
 */
function InputFolderSection() {
  const settings = useSettings();
  const updateSettings = useUpdateSettings();
  const [path, setPath] = useState(settings.data?.inputRoot ?? '');
  const [saved, setSaved] = useState(false);

  return (
    <section className="space-y-2">
      <h2 className="text-xs font-medium tracking-wide text-muted uppercase">Input images</h2>
      <Card className="space-y-3">
        <p className="text-xs text-muted">
          A folder of pictures to use as workflow inputs. Anything in here shows up under “From
          folder” next to an image input, and is copied into ComfyUI without passing through your
          phone. Subfolders are included; nothing is ever written back.
        </p>

        <div className="flex gap-2">
          <input
            value={path}
            onChange={(event) => {
              setPath(event.target.value);
              setSaved(false);
            }}
            placeholder="/home/you/reference"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            className="min-w-0 flex-1 rounded-xl border border-line bg-surface px-4 py-3 text-sm focus:border-accent focus:outline-none"
          />
          <Button
            variant="secondary"
            busy={updateSettings.isPending}
            onClick={() => {
              updateSettings.mutate({ inputRoot: path.trim() || null });
              setSaved(true);
            }}
          >
            Save
          </Button>
        </div>

        {saved && <p className="text-xs text-muted">Saved.</p>}
      </Card>
    </section>
  );
}

/**
 * Bring images that already exist on disk into the library.
 *
 * A ComfyUI output folder is usually full of work that predates this app.
 * Scanning it and rating what is worth keeping runs everything through the same
 * encrypted archive as freshly generated images.
 */
function ImportSection() {
  const settings = useSettings();
  const updateSettings = useUpdateSettings();
  const [expanded, setExpanded] = useState(false);
  const scan = useImportScan(expanded);
  const importFiles = useImportFiles();

  const [path, setPath] = useState(settings.data?.importRoot ?? '');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const files = scan.data?.files ?? [];
  const pending = files.filter((file) => !file.imported);

  const toggle = (candidate: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(candidate)) next.delete(candidate);
      else next.add(candidate);
      return next;
    });

  const runImport = async (rating: number) => {
    setError(null);
    setResult(null);
    try {
      const outcome = await importFiles.mutateAsync({ paths: [...selected], rating });
      setSelected(new Set());
      setResult(
        `Imported ${outcome.imported}` +
          (outcome.skipped ? `, skipped ${outcome.skipped} already there` : '') +
          (outcome.failed.length ? `, ${outcome.failed.length} failed` : ''),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Import failed');
    }
  };

  return (
    <section className="space-y-2">
      <h2 className="text-xs font-medium tracking-wide text-muted uppercase">
        Import from a folder
      </h2>
      <Card className="space-y-3">
        <p className="text-xs text-muted">
          A path on the machine running Latent. Subfolders are included. If ComfyUI runs on a
          remote instance, its outputs are not on this filesystem — point this at a local folder,
          a network mount, or something synced.
        </p>

        <div className="flex gap-2">
          <input
            value={path}
            onChange={(event) => setPath(event.target.value)}
            placeholder="/home/you/ComfyUI/output"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            className="min-w-0 flex-1 rounded-xl border border-line bg-surface px-4 py-3 text-sm focus:border-accent focus:outline-none"
          />
          <Button
            variant="secondary"
            busy={updateSettings.isPending}
            onClick={() => {
              updateSettings.mutate({ importRoot: path.trim() || null });
              setExpanded(true);
              void scan.refetch();
            }}
          >
            Scan
          </Button>
        </div>

        {expanded && scan.data && !scan.data.ok && (
          <p className="text-xs text-warn">{scan.data.message}</p>
        )}

        {expanded && scan.isFetching && (
          <div className="grid place-items-center py-3">
            <Spinner className="size-5 text-muted" />
          </div>
        )}

        {expanded && scan.data?.ok && (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs text-muted">
              <span>
                {files.length} image{files.length === 1 ? '' : 's'} found
                {scan.data.truncated && ' (showing the first 2000)'}
              </span>
              {pending.length > 0 && (
                <button
                  type="button"
                  onClick={() =>
                    setSelected(
                      selected.size === pending.length
                        ? new Set()
                        : new Set(pending.map((file) => file.path)),
                    )
                  }
                  className="text-accent"
                >
                  {selected.size === pending.length ? 'Select none' : 'Select all new'}
                </button>
              )}
            </div>

            <ul className="max-h-72 space-y-1 overflow-y-auto">
              {files.map((file) => (
                <li key={file.path}>
                  <button
                    type="button"
                    disabled={file.imported}
                    onClick={() => toggle(file.path)}
                    className={cn(
                      'flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-sm',
                      file.imported
                        ? 'text-muted opacity-50'
                        : selected.has(file.path)
                          ? 'bg-accent/15 text-accent'
                          : 'active:bg-surface-2',
                    )}
                  >
                    <span className="min-w-0 truncate">{file.path}</span>
                    <span className="shrink-0 text-xs">
                      {file.imported
                        ? 'in library'
                        : file.width
                          ? `${file.width}×${file.height}`
                          : ''}
                    </span>
                  </button>
                </li>
              ))}
            </ul>

            {selected.size > 0 && (
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="primary"
                  size="sm"
                  busy={importFiles.isPending}
                  onClick={() => runImport(0)}
                >
                  Import {selected.size}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  busy={importFiles.isPending}
                  onClick={() => runImport(5)}
                >
                  Import as ★5
                </Button>
              </div>
            )}
          </div>
        )}

        {!expanded && settings.data?.importRoot && (
          <Button variant="ghost" size="sm" onClick={() => setExpanded(true)}>
            Show {settings.data.importRoot}
          </Button>
        )}

        <ErrorNote>{error}</ErrorNote>
        {result && <p className="text-xs text-muted">{result}</p>}
      </Card>
    </section>
  );
}

/**
 * Named layouts for one workflow's form.
 *
 * Arranging the form is real work, and there is rarely one right arrangement —
 * a stripped-down layout for quick drafts and a full one with every knob
 * exposed both make sense. Without this, setting up the second destroyed the
 * first.
 */
function LayoutBar({
  workflowId,
  detail,
}: {
  workflowId: string;
  detail: WorkflowDetail;
}) {
  const save = useSaveLayout(workflowId);
  const activate = useActivateLayout(workflowId);
  const remove = useDeleteLayout(workflowId);

  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const layouts = detail.layouts ?? [];
  const activeId = detail.activeLayoutId;

  return (
    <div className="space-y-2 rounded-xl border border-line bg-surface p-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium tracking-wide text-muted uppercase">Layouts</span>
        <Button variant="ghost" size="sm" onClick={() => setNaming((current) => !current)}>
          {naming ? 'Cancel' : 'Save current'}
        </Button>
      </div>

      {naming && (
        <div className="flex gap-2">
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. Quick draft"
            className="min-w-0 flex-1 rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm focus:border-accent focus:outline-none"
          />
          <Button
            variant="primary"
            size="sm"
            busy={save.isPending}
            disabled={name.trim() === ''}
            onClick={async () => {
              setError(null);
              try {
                // No overrides passed: the server snapshots the form as it
                // currently stands, which is what "save current" means.
                await save.mutateAsync({ name: name.trim() });
                setName('');
                setNaming(false);
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : 'Could not save that layout');
              }
            }}
          >
            Save
          </Button>
        </div>
      )}

      <ErrorNote>{error}</ErrorNote>

      {layouts.length === 0 ? (
        <p className="text-xs text-muted">
          No saved layouts. Arrange the fields below, then save the arrangement under a name.
        </p>
      ) : (
        <ul className="space-y-1">
          {layouts.map((layout) => (
            <li
              key={layout.id}
              className={cn(
                'flex items-center justify-between gap-2 rounded-lg px-2 py-1.5',
                layout.id === activeId && 'bg-accent/15',
              )}
            >
              <button
                type="button"
                onClick={() => activate.mutate(layout.id)}
                className="min-w-0 flex-1 truncate text-left text-sm"
              >
                <span className={layout.id === activeId ? 'text-accent' : undefined}>
                  {layout.name}
                </span>
                {layout.id === activeId && <span className="ml-2 text-xs text-accent">in use</span>}
              </button>
              <Button variant="ghost" size="sm" onClick={() => remove.mutate(layout.id)}>
                Delete
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PasswordSheet({ onClose }: { onClose: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.changePassword(current, next);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not change the password');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open onClose={onClose} title="Change password">
      <div className="space-y-3">
        <input
          type="password"
          value={current}
          onChange={(event) => setCurrent(event.target.value)}
          placeholder="Current password"
          autoComplete="current-password"
          className="w-full rounded-xl border border-line bg-surface px-4 py-3 focus:border-accent focus:outline-none"
        />
        <input
          type="password"
          value={next}
          onChange={(event) => setNext(event.target.value)}
          placeholder="New password"
          autoComplete="new-password"
          className="w-full rounded-xl border border-line bg-surface px-4 py-3 focus:border-accent focus:outline-none"
        />
        <ErrorNote>{error}</ErrorNote>
        <p className="text-xs text-muted">
          Every other signed-in device will be logged out.
        </p>
        <Button
          variant="primary"
          size="lg"
          busy={busy}
          disabled={current === '' || next.length < 6}
          onClick={submit}
        >
          Change it
        </Button>
      </div>
    </Sheet>
  );
}

function formatBytes(bytes: number): string {
  if (!bytes) return '—';
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}
