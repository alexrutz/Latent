import { useEffect, useRef, useState } from 'react';

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
  useImportBrowse,
  useImportFiles,
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
import { SortableList, type DragHandleProps } from '../components/SortableList';
import { Toggle } from '../components/ParamControl';
import { Button, Card, cn, ErrorNote, Row, Sheet, Spinner } from '../components/ui';
import { useBlur } from '../state/blur';
import { ConnectionsScreen } from './ConnectionsScreen';
import { TerminalScreen } from './TerminalScreen';

/** Sensible periods rather than a free number: this is a decision, not a dial. */
const AUTO_DELETE_OPTIONS: { label: string; hours: number | null }[] = [
  { label: 'Never', hours: null },
  { label: '6 hours', hours: 6 },
  { label: '1 day', hours: 24 },
  { label: '3 days', hours: 72 },
  { label: '1 week', hours: 168 },
  { label: '1 month', hours: 720 },
];

function describeHours(hours: number): string {
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? '' : 's'}`;
  const weeks = Math.round(days / 7);
  return weeks < 5 ? `${weeks} week${weeks === 1 ? '' : 's'}` : `${Math.round(days / 30)} months`;
}

export function SettingsScreen() {
  const status = useStatus();
  const workflows = useWorkflows();
  const settings = useSettings();
  const updateSettings = useUpdateSettings();
  const importWorkflow = useImportWorkflow();
  const fileRef = useRef<HTMLInputElement>(null);

  const archive = useArchiveStats();
  const blurred = useBlur((state) => state.blurred);
  const setBlurred = useBlur((state) => state.set);

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

      {/* Display ---------------------------------------------------- */}
      <section className="space-y-2">
        <h2 className="text-xs font-medium tracking-wide text-muted uppercase">Display</h2>
        <Card>
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm">Blur every image</p>
              <p className="text-xs text-muted">
                Thumbnails, previews and the viewer, everywhere in the app. Kept on this device.
              </p>
            </div>
            <Toggle checked={blurred} onChange={setBlurred} label="Blur every image" />
          </div>
        </Card>
      </section>

      {/* Archive ---------------------------------------------------- */}
      <section className="space-y-2">
        <h2 className="text-xs font-medium tracking-wide text-muted uppercase">Saved images</h2>
        <Card className="space-y-3">
          <p className="text-xs text-muted">
            Rating an image copies it onto this device, so it stays available after the ComfyUI
            instance that produced it is gone. Keeping one does the same without the stars.
          </p>

          {/*
            The counterweight to how cheap generating is: without a cleanup the
            gallery becomes thousands of near-misses you scrolled past once,
            which makes the good ones harder to find rather than easier.
          */}
          <div className="space-y-1.5">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-sm">Delete unkept runs after</span>
              <span className="text-xs text-muted">
                {settings.data?.autoDeleteHours
                  ? describeHours(settings.data.autoDeleteHours)
                  : 'never'}
              </span>
            </div>
            <div className="flex flex-wrap gap-1">
              {AUTO_DELETE_OPTIONS.map((option) => {
                const active = (settings.data?.autoDeleteHours ?? null) === option.hours;
                return (
                  <button
                    key={option.label}
                    type="button"
                    aria-pressed={active}
                    onClick={() => updateSettings.mutate({ autoDeleteHours: option.hours })}
                    className={cn(
                      'rounded-lg px-2.5 py-1.5 text-xs',
                      active ? 'bg-accent text-white' : 'bg-surface-2 text-muted',
                    )}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
            <p className="text-[11px] text-muted">
              Anything rated, kept or favourited stays — and one of those anywhere in a run keeps
              the whole run, so a batch is never half-deleted. Imported folders are never touched.
            </p>
          </div>
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

  const write = (next: FieldOverrides) => {
    setDraft(next);
    update.mutate({ id: workflowId, patch: { overrides: next } });
  };

  const patch = (fieldId: string, change: Partial<FieldOverrides[string]>) =>
    write({ ...overrides, [fieldId]: { ...overrides[fieldId], ...change } });

  /**
   * Commit a whole group's order in one write.
   *
   * Positions have to be stored for every field in the group, not just the one
   * that moved: the numbers the schema was built with are not contiguous, so
   * "this one is now third" is only meaningful alongside the rest.
   */
  const reorder = (ids: string[]) => {
    const next = { ...overrides };
    ids.forEach((id, index) => {
      next[id] = { ...next[id], order: index };
    });
    write(next);
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
            Build the form: drag the handles to reorder, choose whether a field takes half a row or
            all of it, and hide what you never touch. Hidden fields still use the value the workflow
            was exported with.
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
                <SortableList
                  items={fields}
                  idOf={(field) => field.id}
                  onReorder={reorder}
                  className="space-y-2"
                >
                  {(field, handle, dragging) => (
                    <FieldEditorRow
                      field={field}
                      handle={handle}
                      dragging={dragging}
                      onRename={(label) => patch(field.id, { label })}
                      onToggleHidden={() => patch(field.id, { hidden: !field.hidden })}
                      onMove={() =>
                        patch(field.id, { group: field.group === 'main' ? 'advanced' : 'main' })
                      }
                      onPatch={(change) => patch(field.id, change)}
                    />
                  )}
                </SortableList>
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
  handle,
  dragging,
  onRename,
  onToggleHidden,
  onMove,
  onPatch,
}: {
  field: ParamField;
  handle: DragHandleProps;
  dragging: boolean;
  onRename: (label: string) => void;
  onToggleHidden: () => void;
  onMove: () => void;
  onPatch: (patch: FieldOverride) => void;
}) {
  const [label, setLabel] = useState(field.label);

  const numeric = field.control === 'int' || field.control === 'float';
  // Fields that get their own dedicated control on the form are always a full
  // row; offering them a width would be a switch that does nothing.
  const sizeable =
    !['textarea', 'text', 'image'].includes(field.control) &&
    !['prompt', 'negative_prompt', 'image_input', 'seed', 'lora_text'].includes(field.role);
  const points = usesPointLine(field);
  const line = fieldPoints(field);
  const preview = fieldPointValues(field);

  /*
   * A rename is saved as it is typed, not on blur.
   *
   * On a phone you edit the name and then close the sheet, and closing it
   * unmounts this input without ever firing `blur` — so the change was
   * silently thrown away, which read as "the editor does nothing".
   */
  useEffect(() => {
    if (label === field.label) return;
    const timer = window.setTimeout(() => onRename(label), 400);
    return () => window.clearTimeout(timer);
  }, [label, field.label, onRename]);

  return (
    <div
      data-field={field.id}
      className={cn(
        'rounded-xl border p-3',
        dragging ? 'border-accent bg-surface shadow-lg' : 'border-line',
        field.hidden && 'opacity-50',
      )}
    >
      <div className="flex items-center gap-2">
        <span
          {...handle}
          role="button"
          aria-label={`Reorder ${field.label}`}
          className="grid size-9 shrink-0 cursor-grab place-items-center rounded-lg bg-surface-2 text-muted"
        >
          ⠿
        </span>
        <input
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          aria-label={`${field.inputName} label`}
          className="min-w-0 flex-1 rounded-lg bg-surface-2 px-3 py-2 text-sm focus:outline-none"
        />
        <Toggle checked={!field.hidden} onChange={onToggleHidden} label={`Show ${field.label}`} />
      </div>
      <div className="mt-1.5 flex items-center justify-between gap-2">
        <p className="min-w-0 flex-1 truncate text-[11px] text-muted">
          {field.nodeTitle} · {field.inputName} · {field.control}
        </p>
        <button
          type="button"
          onClick={onMove}
          className="shrink-0 rounded-md bg-surface-2 px-2 py-1 text-[11px] whitespace-nowrap text-muted"
        >
          {field.group === 'main' ? '→ Advanced' : '→ Main'}
        </button>
      </div>

      {/*
        Width, because a two-column grid is only tidy if the things in it fit.
        A sampler name needs the room its longest option does; four short numbers
        read better side by side. Offered only where it means something: a prompt
        box or an image picker has never been anything but a full row.
      */}
      {sizeable && (
        <div className="mt-1.5 flex items-center justify-between gap-2">
          <span className="text-[11px] text-muted">Width</span>
          <div className="flex gap-1">
            {(
              [
                ['half', 'Half'],
                ['full', 'Full'],
              ] as const
            ).map(([value, text]) => {
              const active = (field.width ?? 'half') === value;
              return (
                <button
                  key={value}
                  type="button"
                  aria-pressed={active}
                  aria-label={`${field.label} ${text} row`}
                  onClick={() => onPatch({ width: value })}
                  className={cn(
                    'h-7 rounded-md px-2.5 text-[11px]',
                    active ? 'bg-accent text-white' : 'bg-surface-2 text-muted',
                  )}
                >
                  {text}
                </button>
              );
            })}
          </div>
        </div>
      )}

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
  const importFiles = useImportFiles();

  const [open, setOpen] = useState(false);
  const [path, setPath] = useState('');
  const [root, setRoot] = useState(settings.data?.importRoot ?? '');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [recursive, setRecursive] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const browse = useImportBrowse(path, open);
  const folders = browse.data?.folders ?? [];
  const files = browse.data?.files ?? [];
  const pending = files.filter((file) => !file.imported);

  const go = (next: string) => {
    setPath(next);
    setSelected(new Set());
    setResult(null);
  };

  const toggle = (candidate: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(candidate)) next.delete(candidate);
      else next.add(candidate);
      return next;
    });

  const run = async (body: Parameters<typeof importFiles.mutateAsync>[0], label: string) => {
    setError(null);
    setResult(null);
    try {
      const outcome = await importFiles.mutateAsync(body);
      setSelected(new Set());
      setResult(
        `${label}: imported ${outcome.imported}` +
          (outcome.skipped ? `, skipped ${outcome.skipped} already there` : '') +
          (outcome.failed.length ? `, ${outcome.failed.length} failed` : ''),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Import failed');
    }
  };

  /** Where we are, as something tappable. */
  const crumbs = path ? path.split('/') : [];

  return (
    <section className="space-y-2">
      <h2 className="text-xs font-medium tracking-wide text-muted uppercase">
        Import from a folder
      </h2>
      <Card className="space-y-3">
        <p className="text-xs text-muted">
          A path on the machine running Latent — usually ComfyUI’s <code>output</code> directory.
          If ComfyUI runs on a remote instance its outputs are not on this filesystem; point this
          at a local folder, a network mount, or something synced.
        </p>

        <div className="flex gap-2">
          <input
            value={root}
            onChange={(event) => setRoot(event.target.value)}
            placeholder="/home/you/ComfyUI/output"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            aria-label="Import folder"
            className="min-w-0 flex-1 rounded-xl border border-line bg-surface px-4 py-3 text-sm focus:border-accent focus:outline-none"
          />
          <Button
            variant="secondary"
            busy={updateSettings.isPending}
            onClick={() => {
              updateSettings.mutate({ importRoot: root.trim() || null });
              setOpen(true);
              go('');
            }}
          >
            Open
          </Button>
        </div>

        {open && browse.data && !browse.data.ok && (
          <p className="text-xs text-warn">{browse.data.message}</p>
        )}

        {open && browse.data?.ok && (
          <div className="space-y-2">
            {/*
              A breadcrumb, because an output directory is a tree of days and
              projects and the folder *is* the unit you think in — not the
              individual file.
            */}
            <div className="flex flex-wrap items-center gap-1 text-xs">
              <button type="button" onClick={() => go('')} className="text-accent">
                root
              </button>
              {crumbs.map((crumb, index) => (
                <span key={index} className="flex items-center gap-1">
                  <span className="text-muted">/</span>
                  <button
                    type="button"
                    onClick={() => go(crumbs.slice(0, index + 1).join('/'))}
                    className={index === crumbs.length - 1 ? 'text-body' : 'text-accent'}
                  >
                    {crumb}
                  </button>
                </span>
              ))}
            </div>

            {browse.isFetching && (
              <div className="grid place-items-center py-3">
                <Spinner className="size-5 text-muted" />
              </div>
            )}

            <label className="flex items-center justify-between gap-2 rounded-lg bg-surface-2 px-3 py-2 text-xs">
              <span className="text-muted">Include subfolders when importing a folder</span>
              <Toggle checked={recursive} onChange={setRecursive} label="Include subfolders" />
            </label>

            {folders.length > 0 && (
              <ul className="space-y-1">
                {folders.map((folder) => (
                  <li key={folder.path} className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => go(folder.path)}
                      className="min-w-0 flex-1 rounded-lg px-2 py-2 text-left active:bg-surface-2"
                    >
                      <span className="block truncate text-sm">▸ {folder.name}</span>
                      <span className="block text-[11px] text-muted">
                        {folder.images} image{folder.images === 1 ? '' : 's'}
                        {folder.imported > 0 && `, ${folder.imported} in library`}
                        {folder.folders > 0 && ` · ${folder.folders} folder${folder.folders === 1 ? '' : 's'}`}
                      </span>
                    </button>
                    <Button
                      variant="ghost"
                      size="sm"
                      busy={importFiles.isPending}
                      onClick={() =>
                        void run({ folder: folder.path, recursive }, folder.name)
                      }
                    >
                      Import
                    </Button>
                  </li>
                ))}
              </ul>
            )}

            {files.length > 0 && (
              <>
                <div className="flex items-center justify-between text-xs text-muted">
                  <span>
                    {files.length} image{files.length === 1 ? '' : 's'} here
                    {browse.data.truncated && ' (first 300)'}
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

                <ul className="max-h-64 space-y-1 overflow-y-auto">
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
                        <span className="min-w-0 truncate">{file.name}</span>
                        <span className="shrink-0 text-xs">
                          {file.imported ? 'in library' : formatBytes(file.bytes)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}

            {folders.length === 0 && files.length === 0 && !browse.isFetching && (
              <p className="text-xs text-muted">This folder is empty.</p>
            )}

            <div className="flex flex-wrap gap-2">
              {selected.size > 0 && (
                <>
                  <Button
                    variant="primary"
                    size="sm"
                    busy={importFiles.isPending}
                    onClick={() => void run({ paths: [...selected] }, `${selected.size} selected`)}
                  >
                    Import {selected.size}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    busy={importFiles.isPending}
                    onClick={() =>
                      void run({ paths: [...selected], rating: 5 }, `${selected.size} selected`)
                    }
                  >
                    Import as ★5
                  </Button>
                </>
              )}
              {pending.length > 0 && selected.size === 0 && (
                <Button
                  variant="secondary"
                  size="sm"
                  busy={importFiles.isPending}
                  onClick={() => void run({ folder: path, recursive }, 'This folder')}
                >
                  Import this folder{recursive ? ' and below' : ''}
                </Button>
              )}
            </div>
          </div>
        )}

        <ErrorNote>{error}</ErrorNote>
        {result && <p className="text-xs text-success">{result}</p>}
        <p className="text-[11px] text-muted">
          Imported pictures keep the settings ComfyUI wrote into them, so “Reuse settings” works on
          anything made with a workflow you have here.
        </p>
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
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / 1024 ** 2;
  // A single PNG is often well under a megabyte, and "0 MB" is not a size.
  return mb >= 1 ? `${Math.round(mb)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
