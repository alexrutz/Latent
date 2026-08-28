import { useEffect, useMemo, useRef, useState } from 'react';

import {
  CHAT_IMAGE_SIZES,
  DEFAULT_WANDER_DRAW,
  defaultSampling,
  fieldPoints,
  fieldPointValues,
  SAMPLING_GROUPS,
  SAMPLING_PARAMS,
  usesPointLine,
} from '@latent/shared';
import type {
  ChatSampling,
  ChatSettings,
  SamplingKey,
  SamplingSetting,
  FieldOverride,
  FieldOverrides,
  ParamField,
  QueuePolicy,
  SystemPrompt,
  PromptDetail,
  ReviewAsk,
  ReviewThreshold,
  TasteInfluence,
  ToolEagerness,
  WanderDraw,
  WidgetValue,
  WorkflowDetail,
  WorkflowSummary,
} from '@latent/shared';

import { api } from '../api/client';
import {
  useActivateLayout,
  useArchiveStats,
  useChatStatus,
  useDeleteLayout,
  useDeleteWorkflow,
  useImportBrowse,
  useImportFiles,
  useImportWorkflow,
  useRescanWorkflow,
  useCreateSystemPrompt,
  useDeleteSystemPrompt,
  useSaveLayout,
  useScanWorkflows,
  useSettings,
  useSystemPrompts,
  useUpdateSystemPrompt,
  useStatus,
  useUpdateSettings,
  useUpdateWorkflow,
  useVisibleWorkflows,
  useWorkflow,
  useWorkflows,
} from '../api/queries';
import { NumericInput } from '../components/NumericInput';
import { SortableList, type DragHandleProps } from '../components/SortableList';
import { FieldChip, Toggle, WorkflowScope } from '../components/ParamControl';
import { UnlockArchiveDialog } from '../components/UnlockArchive';
import { WanderSetup } from '../components/WanderSetup';
import { Button, Card, cn, ErrorNote, Row, Sheet, Spinner } from '../components/ui';
import { useBlur } from '../state/blur';
import { ConnectionsScreen } from './ConnectionsScreen';
import { TerminalScreen } from './TerminalScreen';

/**
 * The pace scale, most reluctant first.
 *
 * Six steps rather than four because the useful distinctions are at the quiet
 * end: "only if I say so" and "if I say go on" are different instructions, and
 * so are "once we have decided" and "when it looks like the next step". Shown
 * as a line of points rather than six buttons in a row, which at this width
 * would be six illegible ones.
 */
const EAGERNESS_OPTIONS: { value: ToolEagerness; label: string; hint: string }[] = [
  { value: 'off', label: 'Off', hint: 'not offered to the model at all' },
  { value: 'on-request', label: 'Only when asked', hint: 'the words have to be said' },
  { value: 'invited', label: 'When invited', hint: '“go on then” counts' },
  { value: 'settled', label: 'Once decided', hint: 'when nothing is still in flux' },
  { value: 'ready', label: 'When it fits', hint: 'proposes the next step itself' },
  { value: 'eager', label: 'Freely', hint: 'whenever it might help' },
  {
    value: 'always',
    label: 'Always, enforced',
    hint: 'a question asked in prose is re-asked as a dialog',
  },
];

/** Only asking has the enforced top step; the other tools stop at "freely". */
const ASK_ONLY: ToolEagerness[] = ['always'];

/**
 * How perfectionist it is about a finished picture, on the same kind of line.
 *
 * The same shape as the pace scale above because it is the same kind of
 * setting: one ordered judgement made on your behalf, where the interesting
 * distinctions are between neighbours rather than at the ends. Each step is
 * both a sentence and a score the model has to beat, so moving it one point
 * visibly changes what comes back.
 */
/** The scale reads as pictures, because that is what the number is. */
const KEEP_IN_VIEW_LABELS = ['None', 'The last one', 'The last two', 'The last three', 'The last four'];

/** When it stops and asks instead of rewriting the prompt for you. */
const ASK_OPTIONS: { value: ReviewAsk; label: string; hint: string }[] = [
  { value: 'never', label: 'Never', hint: 'always decides for itself' },
  { value: 'unclear', label: 'When it cannot tell', hint: 'only if the miss is a mystery' },
  { value: 'unsure', label: 'When unsure', hint: 'several fixes, no obvious one' },
  { value: 'often', label: 'More than one way', hint: 'offers the choice rather than picking' },
  { value: 'always', label: 'Always first', hint: 'nothing is rewritten unasked' },
];

/** How much of the picture a prompt settles, rather than how long it is. */
const DETAIL_OPTIONS: { value: PromptDetail; label: string; hint: string }[] = [
  { value: 'sparse', label: 'Sparse', hint: 'a sentence; the model fills in the rest' },
  { value: 'plain', label: 'Plain', hint: 'subject, light, framing, medium' },
  { value: 'balanced', label: 'Balanced', hint: 'settled, but not exhausted' },
  { value: 'detailed', label: 'Detailed', hint: 'the whole scene, clause by clause' },
  { value: 'elaborate', label: 'Elaborate', hint: 'nothing important left to chance' },
];

/**
 * How far the notes about what you like are allowed to reach.
 *
 * Every step is about empty space rather than authority: what changes is how
 * much of what you *did not* say gets filled in from them. Nothing on this
 * scale overrides something you asked for — see `tastePolicy` on the server.
 */
const TASTE_OPTIONS: { value: TasteInfluence; label: string; hint: string }[] = [
  { value: 'off', label: 'Off', hint: 'nothing is sent, pinned notes too' },
  { value: 'sparingly', label: 'Sparingly', hint: 'only when you say nothing at all' },
  { value: 'hints', label: 'Hints', hint: 'colours a vague idea, leaves a clear one' },
  { value: 'guiding', label: 'Guiding', hint: 'shapes what it offers first' },
  { value: 'strong', label: 'House style', hint: 'everything starts from it' },
];

const REVIEW_OPTIONS: { value: ReviewThreshold; label: string; hint: string }[] = [
  { value: 'never', label: 'Never', hint: 'says how it went and stops there' },
  { value: 'wrong', label: 'Plainly wrong', hint: 'wrong subject, wrong medium' },
  { value: 'loose', label: 'Something missing', hint: 'a thing the prompt asked for' },
  { value: 'balanced', label: 'Noticeably off', hint: 'a part of it did not come through' },
  { value: 'strict', label: 'Any part off', hint: 'down to light and framing' },
  { value: 'exacting', label: 'Not exact', hint: 'unless it matches in every detail' },
];

const TOOL_ROWS: { key: keyof ChatSettings['tools']; label: string; hint: string }[] = [
  { key: 'build_prompt', label: 'Build a prompt', hint: 'stops the conversation' },
  { key: 'prompt_blocks', label: 'Edit prompt blocks', hint: 'writes to your library' },
  { key: 'ask_user', label: 'Ask a question', hint: 'one tap to answer' },
];

/** Names for the shared size scale, so the setting reads as sizes not numbers. */
const IMAGE_SIZE_LABELS = ['Small', 'Modest', 'Medium', 'Large', 'Full width'];

const QUEUE_POLICIES: { value: QueuePolicy; label: string; hint: string }[] = [
  {
    value: 'append',
    label: 'Add to the queue',
    hint: 'Everything already waiting runs first.',
  },
  {
    value: 'clear-pending',
    label: 'Clear what is waiting',
    hint: 'The picture being rendered finishes; the rest is dropped.',
  },
  {
    value: 'replace',
    label: 'Start over',
    hint: 'Stops the render in progress too.',
  },
];

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

/**
 * One ordered choice, as a line of points.
 *
 * The control the tool settings use, because these are all the same kind of
 * decision — how much the model does on its own, on a scale where the useful
 * distinctions are between neighbours. Six labelled buttons in a phone's width
 * are six unreadable ones.
 */
function PointsLine<T extends string>({
  label,
  aside,
  options,
  value,
  onChange,
}: {
  label: string;
  aside: string;
  options: { value: T; label: string; hint: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  const at = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  const current = options[at]!;

  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm">{label}</span>
        <span className="min-w-0 truncate text-[11px] text-muted">{aside}</span>
      </div>

      <div className="flex items-center gap-1">
        {options.map((option, index) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={index === at}
            aria-label={`${label}: ${option.label}`}
            onClick={() => onChange(option.value)}
            className="min-w-0 flex-1 py-2"
          >
            <span
              className={cn(
                'block h-2 rounded-[3px]',
                index === at ? 'bg-accent' : index < at ? 'bg-accent/30' : 'bg-surface-3',
              )}
            />
          </button>
        ))}
      </div>

      <p className="text-[11px]">
        <span className="text-body">{current.label}</span>
        <span className="text-muted"> — {current.hint}</span>
      </p>
    </div>
  );
}

/**
 * How many recent renders the model still has in front of it.
 *
 * Not a detail: a model that saw a picture once, two turns ago, is working from
 * its own description of it by the time anybody asks for a change — and every
 * change after that compounds the description rather than the picture. The
 * ceiling is low because each one is prefill on every turn from then on.
 */
/**
 * How many renders one autonomous run may make.
 *
 * The same line of points as everything else here, because it is the same kind
 * of choice: one ordered number where the interesting distinctions are between
 * neighbours. Starts at two — a run that may make one picture is not a run, it
 * is the ✦ button.
 */
function RoundsLine({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  const at = Math.max(0, Math.min(ROUND_LIMITS.length - 1, ROUND_LIMITS.indexOf(value)));

  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm">Renders before it stops</span>
        <span className="min-w-0 truncate text-[11px] text-muted">
          {ROUND_LIMITS[at]} in one run
        </span>
      </div>

      <div className="flex items-center gap-1">
        {ROUND_LIMITS.map((limit, index) => (
          <button
            key={limit}
            type="button"
            aria-pressed={index === at}
            aria-label={`Renders before it stops: ${limit}`}
            onClick={() => onChange(limit)}
            className="min-w-0 flex-1 py-2"
          >
            <span
              className={cn(
                'block h-2 rounded-[3px]',
                index === at ? 'bg-accent' : index < at ? 'bg-accent/30' : 'bg-surface-3',
              )}
            />
          </button>
        ))}
      </div>
    </div>
  );
}

/** The steps the round limit offers. Doubling, because 5 and 6 are not a choice. */
const ROUND_LIMITS = [2, 3, 4, 6, 8, 12];

/**
 * The draw rules as one sentence, for the row that opens the sheet.
 *
 * By exception rather than by inventory: the row is a summary of what a round
 * may do, and listing four unchanged defaults back at you says nothing. Only
 * the headings you have actually singled out are counted, because those are the
 * settings you would want reminding of.
 */
function describeDraw(draw: WanderDraw): string {
  const rules = Object.values(draw.categories ?? {});
  const insisting = rules.filter((rule) => rule.role === 'always').length;
  const excluded = rules.filter((rule) => rule.role === 'off').length;

  const parts: string[] = [];
  if (insisting > 0) parts.push(`${insisting} heading${insisting === 1 ? '' : 's'} always in`);
  if (excluded > 0) parts.push(`${excluded} left out`);
  if (draw.perCategory > 0) parts.push(`at most ${draw.perCategory} from any one`);
  if (draw.loose === 'off') parts.push('nothing unfiled');
  if (draw.pinned === 'always') parts.push('pins always in');
  if (draw.pinned === 'off') parts.push('pins left out');

  if (parts.length === 0) {
    return 'Everything switched on, drawn flat. Set which headings it must use, which it may not, and how much one of them may contribute.';
  }
  // Sentence case, and full stops rather than a heap of commas at the end.
  return `${parts[0]!.charAt(0).toUpperCase()}${parts[0]!.slice(1)}${
    parts.length > 1 ? `, ${parts.slice(1).join(', ')}` : ''
  }.`;
}

/**
 * How many notes go into each wandering picture.
 *
 * The whole dial of that mode, so it gets a line of points like the rest: one
 * note is a variation on a theme, three is where it is interesting, and six is
 * a collage in which every picture contains everything and they all start to
 * look alike.
 */
function AttributesLine({
  value,
  onChange,
}: {
  value: number;
  onChange: (value: number) => void;
}) {
  const at = Math.max(0, Math.min(ATTRIBUTE_COUNTS.length - 1, ATTRIBUTE_COUNTS.indexOf(value)));

  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm">Notes in each picture</span>
        <span className="min-w-0 truncate text-[11px] text-muted">
          {ATTRIBUTE_HINTS[at] ?? ''}
        </span>
      </div>

      <div className="flex items-center gap-1">
        {ATTRIBUTE_COUNTS.map((count, index) => (
          <button
            key={count}
            type="button"
            aria-pressed={index === at}
            aria-label={`Notes in each picture: ${attributeLabel(count)}`}
            onClick={() => onChange(count)}
            className="min-w-0 flex-1 py-2"
          >
            <span
              className={cn(
                'block h-2 rounded-[3px]',
                index === at ? 'bg-accent' : index < at ? 'bg-accent/30' : 'bg-surface-3',
              )}
            />
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * `0` first, and it is not "none".
 *
 * It is "no ceiling": take as many as the rules allow, which under the default
 * cap of one per heading is one note from each — a picture made of your list
 * rather than of whichever corner of it won the shuffle. Every other step is a
 * fixed number that the caps can still cut short. See `wanderCount`.
 */
const ATTRIBUTE_COUNTS = [0, 1, 2, 3, 4, 5, 6];
const ATTRIBUTE_HINTS = [
  'one from each heading',
  'one thing at a time',
  'two, held together',
  'three — a fixed handful',
  'four, and busier',
  'five, a collage',
  'six; they start to rhyme',
];
const attributeLabel = (count: number) =>
  count === 0 ? 'one from each heading' : String(count);

function KeepInViewLine({
  value,
  onChange,
}: {
  value: number;
  onChange: (value: number) => void;
}) {
  const at = Math.max(0, Math.min(KEEP_IN_VIEW_LABELS.length - 1, value));

  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm">Pictures it keeps in view</span>
        <span className="min-w-0 truncate text-[11px] text-muted">costs a wait each</span>
      </div>

      <div className="flex items-center gap-1">
        {KEEP_IN_VIEW_LABELS.map((label, index) => (
          <button
            key={label}
            type="button"
            aria-pressed={index === at}
            aria-label={`Pictures it keeps in view: ${label}`}
            onClick={() => onChange(index)}
            className="min-w-0 flex-1 py-2"
          >
            <span
              className={cn(
                'block h-2 rounded-[3px]',
                index === at ? 'bg-accent' : index < at ? 'bg-accent/30' : 'bg-surface-3',
              )}
            />
          </button>
        ))}
      </div>

      <p className="text-[11px]">
        <span className="text-body">{KEEP_IN_VIEW_LABELS[at]}</span>
        <span className="text-muted">
          {at === 0
            ? ' — shown while it is judged, then gone'
            : ' — sent again with every turn, so a change can be asked for'}
        </span>
      </p>
    </div>
  );
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
  const [unlocking, setUnlocking] = useState(false);
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

  /*
   * Grouped into folders, shown ones first.
   *
   * After reading a whole installation this list is long, and a flat forty
   * rows is a list nobody scrolls twice. Workflows arrive named after the file
   * they came from, so the leading segment is already the grouping their
   * author intended — `portraits/closeup` and `portraits/wide` belong
   * together, and so do `SDXL_fast` and `SDXL_detail`.
   *
   * Shown workflows stay first *within* their folder, and a folder holding one
   * gets pulled to the top, so the handful you actually use is never buried.
   */
  const workflowFolders = useMemo(
    () => groupWorkflows(workflows.data ?? []),
    [workflows.data],
  );

  return (
    <div className="readable safe-t space-y-6 px-4 pt-3 pb-6">
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

      <ComfyFolderSection />

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
              No workflows yet. Set the ComfyUI folder above and tap{' '}
              <strong className="text-body">Read workflows</strong> to pull in everything already
              saved there — or import a single file with the button above.
            </p>
          </Card>
        )}

        {(workflows.data?.length ?? 0) > 0 && (
          <p className="text-xs text-muted">
            The switch decides whether a workflow appears in the generate picker.{' '}
            {workflows.data?.filter((workflow) => workflow.visible).length} of{' '}
            {workflows.data?.length} shown.
          </p>
        )}

        <div className="space-y-2" data-testid="workflow-list">
          {workflowFolders.map((folder) =>
            folder.name === '' ? (
              folder.workflows.map((workflow) => (
                <WorkflowRow
                  key={workflow.id}
                  workflow={workflow}
                  onEdit={() => setEditing(workflow.id)}
                />
              ))
            ) : (
              <WorkflowFolder
                key={folder.name}
                folder={folder}
                onEdit={(id) => setEditing(id)}
              />
            ),
          )}
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

      <SystemPromptsSection />

      <ChatSection />

      {/* Generating -------------------------------------------------- */}
      <section className="space-y-2">
        <h2 className="text-xs font-medium tracking-wide text-muted uppercase">Generating</h2>
        <Card className="space-y-3">
          <p className="text-xs text-muted">
            What <strong className="text-body">Generate</strong> does about work already queued.
            Building a batch up to compare later wants the first; iterating on a prompt wants one
            of the others, because eight renders of wording you have just changed your mind about
            are eight renders of nothing.
          </p>
          <div className="space-y-1">
            {QUEUE_POLICIES.map((option) => {
              const active = (settings.data?.queuePolicy ?? 'append') === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={active}
                  onClick={() => updateSettings.mutate({ queuePolicy: option.value })}
                  className={cn(
                    'flex w-full flex-col items-start gap-0.5 rounded-lg px-3 py-2 text-left',
                    active ? 'bg-accent/15 text-accent' : 'bg-surface-2 active:bg-surface-3',
                  )}
                >
                  <span className="text-sm">{option.label}</span>
                  <span className="text-[11px] text-muted">{option.hint}</span>
                </button>
              );
            })}
          </div>
          <p className="text-[11px] text-muted">
            Endless generation ignores this: there, Generate queues nothing at all — it hands over
            the settings for the next run.
          </p>
        </Card>
      </section>

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
        {/*
          The archive key is derived from the password and held only in memory,
          so a restarted server leaves you signed in with the archive shut. This
          is the way back that does not involve signing out to fix something
          that is not a sign-in problem.
        */}
        {status.data?.archiveLocked && (
          <Card className="space-y-3">
            <p className="text-xs text-warn">
              The image archive is locked, so importing and keeping images are unavailable. It
              needs the same password you signed in with.
            </p>
            <Button variant="primary" onClick={() => setUnlocking(true)}>
              Unlock the archive
            </Button>
          </Card>
        )}

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
      <UnlockArchiveDialog open={unlocking} onClose={() => setUnlocking(false)} />
      {terminalOpen && <TerminalScreen onClose={() => setTerminalOpen(false)} />}
    </div>
  );
}

/** A run of workflows sharing a leading name segment. */
interface WorkflowFolderGroup {
  /** Empty for the ones that belong to no folder — they are listed flat. */
  name: string;
  workflows: WorkflowSummary[];
  shown: number;
}

/**
 * Split a workflow's name into its folder and the rest.
 *
 * Two conventions, because both are in use and neither is worth forcing: a
 * real subfolder shows up as `portraits/closeup`, and a naming scheme inside
 * one folder shows up as `SDXL_fast`. The slash wins when both are present,
 * since it is the one the filesystem actually made.
 *
 * An underscore only counts when there is something on either side of it, so
 * `_scratch` stays whole rather than becoming a folder with no name.
 */
export function splitWorkflowName(name: string): { folder: string; leaf: string } {
  const slash = name.indexOf('/');
  if (slash > 0) return { folder: name.slice(0, slash), leaf: name.slice(slash + 1) };

  const underscore = name.indexOf('_');
  if (underscore > 0 && underscore < name.length - 1) {
    return { folder: name.slice(0, underscore), leaf: name.slice(underscore + 1) };
  }
  return { folder: '', leaf: name };
}

/**
 * Group workflows by that folder, dropping groups of one.
 *
 * A "folder" holding a single workflow is not a folder, it is an extra tap and
 * a line of chrome around one row — so those go back to the flat list.
 */
export function groupWorkflows(workflows: WorkflowSummary[]): WorkflowFolderGroup[] {
  const byFolder = new Map<string, WorkflowSummary[]>();
  for (const workflow of workflows) {
    const { folder } = splitWorkflowName(workflow.name);
    const bucket = byFolder.get(folder);
    if (bucket) bucket.push(workflow);
    else byFolder.set(folder, [workflow]);
  }

  const loose: WorkflowSummary[] = [...(byFolder.get('') ?? [])];
  const folders: WorkflowFolderGroup[] = [];

  for (const [name, group] of byFolder) {
    if (name === '') continue;
    if (group.length < 2) {
      loose.push(...group);
      continue;
    }
    folders.push({
      name,
      workflows: [...group].sort(byVisibleThenName),
      shown: group.filter((workflow) => workflow.visible).length,
    });
  }

  folders.sort((a, b) => Number(b.shown > 0) - Number(a.shown > 0) || a.name.localeCompare(b.name));

  const flat: WorkflowFolderGroup[] = [
    { name: '', workflows: loose.sort(byVisibleThenName), shown: 0 },
  ];
  // Folders holding something you use go above the loose ones; the rest below.
  const used = folders.filter((folder) => folder.shown > 0);
  const unused = folders.filter((folder) => folder.shown === 0);
  return [...used, ...flat, ...unused].filter((group) => group.workflows.length > 0);
}

function byVisibleThenName(a: WorkflowSummary, b: WorkflowSummary): number {
  return Number(b.visible) - Number(a.visible) || a.name.localeCompare(b.name);
}

/** One folder, shut until tapped. */
function WorkflowFolder({
  folder,
  onEdit,
}: {
  folder: WorkflowFolderGroup;
  onEdit: (id: string) => void;
}) {
  // Open when something inside is in use, since that is the one you came for.
  const [open, setOpen] = useState(folder.shown > 0);

  return (
    <div className="overflow-hidden rounded-xl border border-line">
      <button
        type="button"
        data-testid="workflow-folder"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 bg-surface-2 px-3 py-2 text-left active:bg-surface-3"
      >
        <span aria-hidden className="text-[10px] text-muted">
          {open ? '▾' : '▸'}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{folder.name}</span>
        <span className="shrink-0 text-[11px] text-muted tabular-nums">
          {folder.shown > 0 ? `${folder.shown}/${folder.workflows.length}` : folder.workflows.length}
        </span>
      </button>

      {open && (
        <div className="space-y-2 p-2">
          {folder.workflows.map((workflow) => (
            <WorkflowRow key={workflow.id} workflow={workflow} onEdit={() => onEdit(workflow.id)} />
          ))}
        </div>
      )}
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
  const update = useUpdateWorkflow();
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
        {/*
          Reading a whole installation finds every workflow anybody ever saved.
          This is the switch that decides which of them are worth scrolling past
          on the generate screen.
        */}
        <Toggle
          checked={workflow.visible}
          onChange={(visible) => update.mutate({ id: workflow.id, patch: { visible } })}
          label={`Show ${workflow.name} in the generate picker`}
        />
      </div>

      {/* A workflow nobody generates with needs no buttons taking up room. */}
      {workflow.visible && (
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
      )}
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
/**
 * The instructions, collected and named.
 *
 * Workflows grow instructions — a paragraph telling a captioner how to describe
 * a picture, the rules an Ollama node rewrites a prompt by — and inside the
 * graph they are invisible from here and can only be changed by opening
 * ComfyUI, editing the node and exporting the workflow again. Named and
 * collected, one wording reaches every workflow with a field of that name, and
 * editing it is three taps. The chat's own instructions are simply one of them.
 */
function SystemPromptsSection() {
  const prompts = useSystemPrompts();
  const create = useCreateSystemPrompt();
  const settings = useSettings();
  const [editing, setEditing] = useState<SystemPrompt | 'new' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const chosen = settings.data?.chat.systemPromptId ?? null;

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-medium tracking-wide text-muted uppercase">System prompts</h2>
        <Button variant="secondary" size="sm" onClick={() => setEditing('new')}>
          Add
        </Button>
      </div>

      <Card className="space-y-2">
        <p className="text-xs text-muted">
          Named blocks of instructions, kept out of the workflows that use them. A text field in a
          workflow is filled from the prompt of the same name — matched against the field’s label,
          its node’s title, or its raw input name — so the wording lives here rather than buried in
          a graph. The chat picks one of these too.
        </p>

        <ErrorNote>{error}</ErrorNote>

        {(prompts.data?.length ?? 0) === 0 ? (
          <p className="text-xs text-muted">
            None yet. Name one after the field it belongs in — “Caption”, “Style guide” — and it is
            put there every time that workflow runs.
          </p>
        ) : (
          <ul className="space-y-1">
            {prompts.data?.map((prompt) => (
              <li key={prompt.id}>
                <button
                  type="button"
                  onClick={() => setEditing(prompt)}
                  className="w-full rounded-lg px-2 py-2 text-left active:bg-surface-2"
                >
                  <span className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm">{prompt.name}</span>
                    {prompt.id === chosen && (
                      <span className="shrink-0 rounded-full bg-accent/20 px-2 py-0.5 text-[10px] text-accent">
                        chat
                      </span>
                    )}
                  </span>
                  <span className="mt-0.5 block truncate text-[11px] text-muted">
                    {prompt.text.trim() === ''
                      ? 'Empty — the workflow keeps its own text'
                      : prompt.text.replace(/\s+/g, ' ')}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {editing && (
        <SystemPromptSheet
          prompt={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onCreate={async (input) => {
            setError(null);
            try {
              await create.mutateAsync(input);
              setEditing(null);
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : 'Could not save that prompt');
            }
          }}
        />
      )}
    </section>
  );
}

/**
 * Writing one, with Latent's own chat instructions available as a starting
 * point — they are the longest worked example of what one of these looks like.
 */
function SystemPromptSheet({
  prompt,
  onClose,
  onCreate,
}: {
  prompt: SystemPrompt | null;
  onClose: () => void;
  onCreate: (input: { name: string; text: string }) => Promise<void>;
}) {
  const update = useUpdateSystemPrompt();
  const remove = useDeleteSystemPrompt();

  const [name, setName] = useState(prompt?.name ?? '');
  const [text, setText] = useState(prompt?.text ?? '');
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const [saving, setSaving] = useState(false);

  const save = async () => {
    setError(null);
    setSaving(true);
    try {
      if (prompt) {
        await update.mutateAsync({ id: prompt.id, input: { name: name.trim(), text } });
        onClose();
      } else {
        await onCreate({ name: name.trim(), text });
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save that prompt');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet open onClose={onClose} title={prompt ? prompt.name : 'New system prompt'} full>
      <div className="space-y-4">
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium tracking-wide text-muted uppercase">
            Name
          </span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Caption"
            aria-label="Prompt name"
            className="w-full rounded-xl border border-line bg-surface px-4 py-3 focus:border-accent focus:outline-none"
          />
          <p className="mt-1.5 text-xs text-muted">
            This is what matches it to a workflow: any text input called the same thing is filled
            from here when the job is submitted.
          </p>
        </label>

        <label className="block">
          <span className="mb-1.5 flex items-baseline justify-between gap-2">
            <span className="text-xs font-medium tracking-wide text-muted uppercase">Text</span>
            <button
              type="button"
              onClick={async () => {
                const { prompt: own } = await api.chatDefaultPrompt();
                setText(own);
              }}
              className="text-[11px] text-accent"
            >
              Start from Latent’s own
            </button>
          </span>
          <textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            rows={14}
            aria-label="Prompt text"
            className="w-full resize-none rounded-xl border border-line bg-surface px-3 py-2 font-mono text-xs leading-relaxed focus:border-accent focus:outline-none"
          />
        </label>

        <ErrorNote>{error}</ErrorNote>

        <div className="flex gap-2">
          <Button
            variant="primary"
            className="flex-1"
            busy={saving}
            disabled={name.trim() === ''}
            onClick={save}
          >
            Save
          </Button>
          {prompt &&
            (confirming ? (
              <Button
                variant="danger"
                busy={remove.isPending}
                onClick={async () => {
                  await remove.mutateAsync(prompt.id);
                  onClose();
                }}
              >
                Really delete
              </Button>
            ) : (
              <Button variant="ghost" onClick={() => setConfirming(true)}>
                Delete
              </Button>
            ))}
        </div>
      </div>
    </Sheet>
  );
}

/**
 * What the chat says to the model, and how eagerly it reaches for a tool.
 *
 * Where to *find* the model is a connection now, set up in the same list as
 * ComfyUI: on the usual setup both are on the same rented box, and asking the
 * same five questions in two different places helped nobody.
 */
function ChatSection() {
  const settings = useSettings();
  const updateSettings = useUpdateSettings();
  const prompts = useSystemPrompts();
  const chat = settings.data?.chat;

  const [probe, setProbe] = useState<{ ok: boolean; models: string[]; message?: string } | null>(
    null,
  );
  const [checking, setChecking] = useState(false);
  const [showSampling, setShowSampling] = useState(false);
  const [showWanderSampling, setShowWanderSampling] = useState(false);
  const [showWanderDraw, setShowWanderDraw] = useState(false);
  const workflows = useVisibleWorkflows();
  const status = useChatStatus();
  /** The freshest list we have: what Check just returned, else what was fetched. */
  const models = probe?.models ?? status.data?.models ?? [];
  const reachable = probe?.ok ?? status.data?.ok ?? false;
  const message = probe?.message ?? status.data?.message;

  if (!chat) return null;

  /*
   * Written after the rest of the chat settings, so a stored block from before
   * it existed simply has no field for it. The server merges its defaults in;
   * this is the same answer on the client, for a response that predates them.
   */
  const review = chat.review ?? {
    enabled: true,
    threshold: 'balanced' as const,
    keepInView: 2,
  };
  const autonomous = chat.autonomous ?? { enabled: false, maxRounds: 4 };
  const wander = chat.wander ?? {
    workflowId: '',
    attributes: 0,
    draw: DEFAULT_WANDER_DRAW,
    sampling: 'chat' as const,
    ownSampling: defaultSampling(),
  };
  const wanderSampling = { ...defaultSampling(), ...(wander.ownSampling ?? {}) };
  /** Filled in for a rule added since these settings were written. */
  const wanderDraw = { ...DEFAULT_WANDER_DRAW, ...(wander.draw ?? {}) };
  const wanderSamplingOn = SAMPLING_PARAMS.filter((param) => wanderSampling[param.key]?.on).length;

  const patch = (change: Partial<typeof chat>) =>
    updateSettings.mutate({ chat: { ...chat, ...change } });

  /** What is stored, filled in for a parameter added since it was written. */
  const sampling = { ...defaultSampling(), ...(chat.sampling ?? {}) };
  const samplingOn = SAMPLING_PARAMS.filter((param) => sampling[param.key]?.on).length;

  return (
    <section className="space-y-2">
      <h2 className="text-xs font-medium tracking-wide text-muted uppercase">Chat</h2>
      <Card className="space-y-3">
        {/*
          No address here any more: the model server is a connection like
          ComfyUI's, set up in one list above. What is left is what to say to
          it, which is what this section was always actually about.
        */}
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm">{reachable ? 'Model server reachable' : 'Not reachable'}</p>
            <p className="truncate text-[11px] text-muted">
              {status.data?.baseUrl || 'No model server chosen — add one under Connections.'}
            </p>
          </div>
          <Button
            variant="secondary"
            size="sm"
            busy={checking}
            onClick={async () => {
              setChecking(true);
              try {
                setProbe(await api.chatStatus());
              } finally {
                setChecking(false);
              }
            }}
          >
            Check
          </Button>
        </div>

        {!reachable && message && <p className="text-xs text-warn">{message}</p>}

        {/*
          Which model, when the server has more than one.

          A plain `llama-server` has exactly one loaded and the name is
          decoration; in router mode it fronts several and picking one is the
          whole point. So the list is only a choice when there is a choice, and
          "whatever is loaded" stays available — it is right for the single-model
          case and survives the model being swapped out from under it.
        */}
        {models.length > 0 && (
          <div className="space-y-1">
            <p className="text-[11px] text-muted">
              {models.length === 1 ? 'Loaded' : `${models.length} models available`}
            </p>
            <div className="flex flex-wrap gap-1">
              <button
                type="button"
                aria-pressed={chat.model === ''}
                onClick={() => patch({ model: '' })}
                className={cn(
                  'rounded-lg px-2.5 py-1.5 text-xs',
                  chat.model === '' ? 'bg-accent text-white' : 'bg-surface-2 text-muted',
                )}
              >
                Whatever is loaded
              </button>
              {models.map((name) => (
                <button
                  key={name}
                  type="button"
                  aria-pressed={chat.model === name}
                  onClick={() => patch({ model: name })}
                  className={cn(
                    'max-w-full truncate rounded-lg px-2.5 py-1.5 text-xs',
                    chat.model === name ? 'bg-accent text-white' : 'bg-surface-2 text-muted',
                  )}
                >
                  {name}
                </button>
              ))}
            </div>
          </div>
        )}

        {chat.model !== '' && !models.includes(chat.model) && (
          <p className="text-xs text-warn">
            {chat.model} is not in the list the server just gave. Check the address, or pick
            another.
          </p>
        )}

        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-sm">Show its thinking</p>
            <p className="text-[11px] text-muted">
              On by default: the tools ask it to make judgements, and one that has reasoned first
              is better at them.
            </p>
          </div>
          <Toggle
            checked={chat.thinking}
            onChange={(thinking) => patch({ thinking })}
            label="Show its thinking"
          />
        </div>

        <label className="space-y-1">
          <span className="block text-[11px] text-muted">Reply limit (0 = server’s)</span>
          <NumericInput
            value={chat.maxTokens}
            onChange={(maxTokens) => patch({ maxTokens })}
            integer
            min={0}
            max={32768}
            aria-label="Reply limit"
            className="w-full rounded-lg border border-line bg-surface px-2 py-1.5 text-sm"
          />
        </label>
        {/*
          Sampling behind a dialog, and every parameter off until asked for.

          The default is still the server's own, which is what its launch flags
          chose for the model behind it — nineteen boxes pre-filled with numbers
          would override all of that with whatever was last left in them, which
          is the failure this used to have. Opting in one at a time keeps the
          untouched case byte-for-byte what it was.
        */}
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-sm">Sampling</p>
            <p className="text-[11px] text-muted">
              {samplingOn === 0
                ? 'The model server’s own, from the flags it was started with.'
                : `${samplingOn} ${samplingOn === 1 ? 'parameter' : 'parameters'} overriding the server’s own.`}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setShowSampling(true)}
            className="shrink-0 rounded-lg bg-surface-2 px-3 py-1.5 text-xs text-body"
          >
            Adjust…
          </button>
        </div>

        {/*
          Which of the saved prompts the chat is given, rather than a box of its
          own. The instructions are a system prompt like any other, and having a
          second copy here meant the one place you edited them was not the place
          they were listed.
        */}
        <div className="space-y-1.5 border-t border-line pt-3">
          <p className="text-sm">Instructions</p>
          <div className="flex flex-wrap gap-1">
            <button
              type="button"
              aria-pressed={chat.systemPromptId === null}
              onClick={() => patch({ systemPromptId: null })}
              className={cn(
                'rounded-lg px-2.5 py-1.5 text-xs',
                chat.systemPromptId === null ? 'bg-accent text-white' : 'bg-surface-2 text-muted',
              )}
            >
              Latent’s own
            </button>
            {(prompts.data ?? []).map((prompt) => (
              <button
                key={prompt.id}
                type="button"
                aria-pressed={chat.systemPromptId === prompt.id}
                onClick={() => patch({ systemPromptId: prompt.id })}
                className={cn(
                  'max-w-full truncate rounded-lg px-2.5 py-1.5 text-xs',
                  chat.systemPromptId === prompt.id
                    ? 'bg-accent text-white'
                    : 'bg-surface-2 text-muted',
                )}
              >
                {prompt.name}
              </button>
            ))}
          </div>
          <p className="text-[11px] text-muted">
            Latent’s own describes the tools and how modern image models read a prompt — plain
            prose rather than a pile of tags. Replacing it replaces all of that. Write your own
            under <strong className="text-body">System prompts</strong> above. When each tool is
            reached for is set below and applies either way.
          </p>
        </div>

        {/*
          How far a prompt goes, separately from what the instructions say.

          Not a length limit — "two sentences" is a rule a model follows by
          truncating the wrong half. What is being chosen is how much of the
          scene the prompt settles and how much is left to the sampler, which is
          a different picture at each end rather than a longer one. It applies
          to a system prompt you wrote yourself as well.
        */}
        <PointsLine
          label="How much a prompt spells out"
          aside="the picture, not its length"
          options={DETAIL_OPTIONS}
          value={chat.promptDetail ?? 'balanced'}
          onChange={(promptDetail) => patch({ promptDetail })}
        />
      </Card>

      {/* What you like ----------------------------------------------- */}
      <Card className="space-y-3">
        <div>
          <p className="text-sm">What you like</p>
          <p className="text-[11px] text-muted">
            Notes about concepts, aesthetics and things you keep coming back to, so “give me an
            idea” has somewhere to start. They are encrypted with your password and read only by
            the model — write them under the{' '}
            <strong className="text-body">♥</strong> in the chat header. A note pinned there
            ignores this scale and applies wherever it is relevant, even to a picture you have
            already described; <strong className="text-body">Off</strong> silences everything,
            pinned notes included.
          </p>
        </div>

        {/*
          A scale, like the pace settings, and read the same way: each step says
          how much of what you left unsaid comes from the notes. None of them
          touches what you did say.
        */}
        <PointsLine
          label="How much it draws on them"
          aside="fills what you leave open"
          options={TASTE_OPTIONS}
          value={chat.taste ?? 'hints'}
          onChange={(taste) => patch({ taste })}
        />
      </Card>

      {/* Wandering ---------------------------------------------------- */}
      <Card className="space-y-3">
        <div>
          <p className="text-sm">Wandering</p>
          <p className="text-[11px] text-muted">
            The <strong className="text-body">❋</strong> in the chat header starts it: picture
            after picture, each one made from a few of your notes drawn at random, until you stop
            it. Nothing is asked and nothing is judged — it is for the evening when you would
            rather be shown things than decide any.
          </p>
        </div>

        <AttributesLine
          value={wander.attributes}
          onChange={(attributes) => patch({ wander: { ...wander, attributes } })}
        />

        {/*
          Which notes, from where — the part that decides whether this mode is
          any use at all.

          Its own sheet rather than six more rows here, because it is the only
          thing in Settings that has to list the headings you wrote, and because
          half of it is behind the password those headings live behind. The
          summary is the line above the button: what it says is what a round is
          currently allowed to do.
        */}
        <div className="space-y-1.5 border-t border-line pt-3">
          <div className="flex items-center justify-between gap-3">
            <p className="min-w-0 flex-1 text-sm">What it draws from</p>
            <button
              type="button"
              onClick={() => setShowWanderDraw(true)}
              className="shrink-0 rounded-lg bg-surface-2 px-3 py-1.5 text-xs text-body"
            >
              Set up…
            </button>
          </div>
          <p className="text-[11px] leading-relaxed text-muted">{describeDraw(wanderDraw)}</p>
        </div>

        <div className="space-y-1.5 border-t border-line pt-3">
          <p className="text-sm">Rendered with</p>
          <div className="flex flex-wrap gap-1">
            <button
              type="button"
              aria-pressed={wander.workflowId === ''}
              onClick={() => patch({ wander: { ...wander, workflowId: '' } })}
              className={cn(
                'rounded-lg px-2.5 py-1.5 text-xs',
                wander.workflowId === '' ? 'bg-accent text-white' : 'bg-surface-2 text-muted',
              )}
            >
              Whatever the chat uses
            </button>
            {(workflows.data ?? []).map((workflow) => (
              <button
                key={workflow.id}
                type="button"
                aria-pressed={wander.workflowId === workflow.id}
                onClick={() => patch({ wander: { ...wander, workflowId: workflow.id } })}
                className={cn(
                  'max-w-full truncate rounded-lg px-2.5 py-1.5 text-xs',
                  wander.workflowId === workflow.id
                    ? 'bg-accent text-white'
                    : 'bg-surface-2 text-muted',
                )}
              >
                {workflow.name}
              </button>
            ))}
          </div>
          <p className="text-[11px] text-muted">
            Worth setting: the workflow you iterate with is often the slow one, and a run that
            goes all evening wants the fast one.
          </p>
        </div>

        {/*
          Sampling of its own, because this is not a conversation.

          Nobody is reading the words, the same few notes come round again, and
          a model at its careful settings writes the same prompt from them every
          time. Variety is the entire product here, which is a different job
          from answering well.
        */}
        <div className="space-y-1.5 border-t border-line pt-3">
          <p className="text-sm">Sampling for these</p>
          <div className="flex gap-1">
            {(
              [
                { value: 'chat' as const, label: 'Same as the chat' },
                { value: 'own', label: 'Its own' },
              ] as { value: 'chat' | 'own'; label: string }[]
            ).map((option) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={wander.sampling === option.value}
                onClick={() => patch({ wander: { ...wander, sampling: option.value } })}
                className={cn(
                  'flex-1 rounded-lg px-2.5 py-1.5 text-xs',
                  wander.sampling === option.value
                    ? 'bg-accent text-white'
                    : 'bg-surface-2 text-muted',
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
          {wander.sampling === 'own' && (
            <div className="flex items-center justify-between gap-3">
              <p className="min-w-0 flex-1 text-[11px] text-muted">
                {wanderSamplingOn === 0
                  ? 'Nothing set, so this is the chat’s after all — turn something on.'
                  : `${wanderSamplingOn} ${wanderSamplingOn === 1 ? 'parameter' : 'parameters'} of its own.`}
              </p>
              <button
                type="button"
                onClick={() => setShowWanderSampling(true)}
                className="shrink-0 rounded-lg bg-surface-2 px-3 py-1.5 text-xs text-body"
              >
                Adjust…
              </button>
            </div>
          )}
        </div>
      </Card>

      {/* When it reaches for a tool ---------------------------------- */}
      <Card className="space-y-3">
        <div>
          <p className="text-sm">When it reaches for a tool</p>
          <p className="text-[11px] text-muted">
            Separately per tool, because they are not the same interruption. A question mid-
            conversation is cheap; a finished prompt while you are still deciding what you want
            ends the conversation this module is for. <strong className="text-body">Off</strong> is
            the only one that is a guarantee — the tool is not offered at all.
          </p>
        </div>

        {TOOL_ROWS.map((row) => {
          /*
           * Asking gets one more step than the others: an enforced one.
           *
           * Every level below it is a sentence in the system prompt, which a
           * small model can talk itself out of — and the failure people hit is
           * exactly that, options listed in prose that then have to be typed
           * back in. `always` catches those and re-asks with the tool forced.
           */
          const levels = EAGERNESS_OPTIONS.filter(
            (option) => row.key === 'ask_user' || !ASK_ONLY.includes(option.value),
          );
          const at = Math.max(
            0,
            levels.findIndex((option) => option.value === chat.tools[row.key]),
          );
          const current = levels[at]!;

          return (
            <div key={row.key} className="space-y-1">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-sm">{row.label}</span>
                <span className="min-w-0 truncate text-[11px] text-muted">{row.hint}</span>
              </div>

              {/* A line of points, the same control a numeric parameter gets:
                  six labelled buttons in a phone's width are six unreadable
                  ones, and this is an ordered scale rather than a set of
                  alternatives. */}
              <div className="flex items-center gap-1">
                {levels.map((option, index) => (
                  <button
                    key={option.value}
                    type="button"
                    aria-pressed={index === at}
                    aria-label={`${row.label}: ${option.label}`}
                    onClick={() => patch({ tools: { ...chat.tools, [row.key]: option.value } })}
                    className="min-w-0 flex-1 py-2"
                  >
                    <span
                      className={cn(
                        'block h-2 rounded-[3px]',
                        index === at
                          ? 'bg-accent'
                          : index < at
                            ? 'bg-accent/30'
                            : 'bg-surface-3',
                      )}
                    />
                  </button>
                ))}
              </div>

              <p className="text-[11px]">
                <span className="text-body">{current.label}</span>
                <span className="text-muted"> — {current.hint}</span>
              </p>
            </div>
          );
        })}

        {/* Checking the picture -------------------------------------- */}
        <div className="space-y-3 border-t border-line pt-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm">Let it see the pictures</p>
              <p className="text-[11px] text-muted">
                On by default. What a prompt produced goes back to the model — most worth
                running are multimodal — so it can say how much of the prompt came through and
                knows what you mean by “make the sky darker”. Off for a text-only server.
              </p>
            </div>
            <Toggle
              checked={review.enabled}
              onChange={(enabled) => patch({ review: { ...review, enabled } })}
              label="Let it see the pictures"
            />
          </div>

          {review.enabled && (
            <>
              <KeepInViewLine
                value={review.keepInView}
                onChange={(keepInView) => patch({ review: { ...review, keepInView } })}
              />
              <PointsLine
                label="Propose a rewrite when"
                aside="how picky it is"
                options={REVIEW_OPTIONS}
                value={review.threshold}
                onChange={(threshold) => patch({ review: { ...review, threshold } })}
              />
              {/*
                A picture can miss for several reasons at once, and which to
                chase is a matter of taste. Guessing produces a confident
                rewrite of the wrong thing; asking costs one tap.
              */}
              {!autonomous.enabled && (
                <PointsLine
                  label="Ask rather than guess"
                  aside="when the fix is a choice"
                  options={ASK_OPTIONS}
                  value={review.askWhen}
                  onChange={(askWhen) => patch({ review: { ...review, askWhen } })}
                />
              )}

              {/* Carrying on by itself ------------------------------- */}
              <div className="space-y-2 border-t border-line pt-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm">Carry on by itself</p>
                    <p className="text-[11px] text-muted">
                      Off by default. With it on, the model’s own prompts and rewrites are accepted
                      for you and the next render starts — until one clears the mark you set above.
                      That threshold is the whole of the stopping rule: raise it and it tries
                      harder, lower it and it settles sooner. It asks you nothing while it runs,
                      because there is nobody to answer.
                    </p>
                  </div>
                  <Toggle
                    checked={autonomous.enabled}
                    onChange={(enabled) => patch({ autonomous: { ...autonomous, enabled } })}
                    label="Carry on by itself"
                  />
                </div>

                {autonomous.enabled && (
                  <>
                    {/*
                      The brake, and the reason there is one.

                      A model convinced its prompt is nearly right will rewrite
                      it indefinitely, and by definition nobody is watching. The
                      limit is renders, not rewrites, because renders are what
                      cost the GPU an hour.
                    */}
                    <RoundsLine
                      value={autonomous.maxRounds}
                      onChange={(maxRounds) => patch({ autonomous: { ...autonomous, maxRounds } })}
                    />
                    <p className="text-[11px] text-muted">
                      It stops at the limit with the last proposal waiting rather than throwing it
                      away, and the <strong className="text-body">∞</strong> strip above the
                      composer stops it sooner. Anything you decide yourself hands the run back to
                      you.
                    </p>
                  </>
                )}
              </div>
            </>
          )}
        </div>
      </Card>

      {/* Pictures, and what they are made with ----------------------- */}
      <Card className="space-y-3">
        <div className="space-y-1.5">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-sm">Picture size in the chat</span>
            <span className="text-[11px] text-muted">
              {IMAGE_SIZE_LABELS[(chat.imageSize ?? 3) - 1] ?? 'Medium'}
            </span>
          </div>
          {/* Steps rather than a fraction of the window: the chat window's
              height changes when the keyboard opens, so a fraction of it meant
              two different sizes depending on whether you were typing. */}
          <div className="flex items-end gap-1">
            {CHAT_IMAGE_SIZES.map((fraction, index) => {
              const step = index + 1;
              const active = (chat.imageSize ?? 3) === step;
              return (
                <button
                  key={step}
                  type="button"
                  aria-pressed={active}
                  aria-label={IMAGE_SIZE_LABELS[index]}
                  onClick={() => patch({ imageSize: step })}
                  className="flex flex-1 items-end justify-center py-1"
                >
                  <span
                    style={{ height: `${12 + index * 6}px` }}
                    className={cn(
                      'block w-full rounded-[3px]',
                      active ? 'bg-accent' : 'bg-surface-2',
                    )}
                  />
                  <span className="sr-only">{Math.round(fraction * 100)}%</span>
                </button>
              );
            })}
          </div>
          <p className="text-[11px] text-muted">
            A share of the width, centred in the conversation. Tapping one opens it full-screen,
            where it zooms and pans; tapping again closes it.
          </p>
        </div>

        {/* What the ✦ button next to Send does with the prompt it asks for. */}
        <div className="space-y-1.5 border-t border-line pt-3">
          <span className="text-sm">The prompt button</span>
          <div className="flex gap-1">
            {(
              [
                { value: 'generate', label: 'Generates it', hint: 'no dialog' },
                { value: 'dialog', label: 'Shows it first', hint: 'read, then decide' },
              ] as const
            ).map((option) => {
              const active = (chat.promptButton ?? 'generate') === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={active}
                  onClick={() => patch({ promptButton: option.value })}
                  className={cn(
                    'flex flex-1 flex-col items-start gap-0.5 rounded-lg px-2.5 py-1.5 text-left',
                    active ? 'bg-accent text-white' : 'bg-surface-2 text-muted',
                  )}
                >
                  <span className="text-xs">{option.label}</span>
                  <span className={cn('text-[10px]', active ? 'text-white/70' : 'text-muted')}>
                    {option.hint}
                  </span>
                </button>
              );
            })}
          </div>
          <p className="text-[11px] text-muted">
            Only the button. A prompt the model offers on its own is always shown first.
          </p>
        </div>

        {/* Marking what changed, in the two places a prompt is read. */}
        <div className="space-y-2 border-t border-line pt-3">
          <div>
            <p className="text-sm">Mark what changed</p>
            <p className="text-[11px] text-muted">
              Against the conversation’s previous prompt. Two paragraphs of near-identical prose
              are hard to compare by eye, which is how you regenerate something you meant to
              change and do not notice.
            </p>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="min-w-0 flex-1 text-sm">In the prompt dialog</span>
            <Toggle
              checked={chat.showDiff?.inDialog ?? true}
              onChange={(inDialog) =>
                patch({ showDiff: { ...chat.showDiff, inDialog } })
              }
              label="Mark changes in the prompt dialog"
            />
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="min-w-0 flex-1 text-sm">Under the picture</span>
            <Toggle
              checked={chat.showDiff?.underPicture ?? true}
              onChange={(underPicture) =>
                patch({ showDiff: { ...chat.showDiff, underPicture } })
              }
              label="Mark changes under the picture"
            />
          </div>
        </div>

        <ChatGenerationSettingsEditor chat={chat} onPatch={patch} />
      </Card>

      <SamplingSheet
        open={showSampling}
        sampling={sampling}
        onClose={() => setShowSampling(false)}
        onChange={(next) => patch({ sampling: next })}
      />

      <WanderSetup
        open={showWanderDraw}
        onClose={() => setShowWanderDraw(false)}
        draw={wanderDraw}
        attributes={wander.attributes}
        onChange={(draw) => patch({ wander: { ...wander, draw } })}
      />

      {/* The same dialog, pointed at the wandering run's own copy. */}
      <SamplingSheet
        open={showWanderSampling}
        sampling={wanderSampling}
        onClose={() => setShowWanderSampling(false)}
        onChange={(next) => patch({ wander: { ...wander, ownSampling: next } })}
      />
    </section>
  );
}

/**
 * Sampling, one parameter at a time.
 *
 * Every one is off until switched on, and off means *the server's own* — the
 * flags llama.cpp was launched with, chosen for the model behind it. That is
 * why this is a dialog of switches rather than a page of boxes: a box has to
 * hold some number, and whatever number that is would be overriding a better
 * one silently. A switch can say "not mine to decide", which for most of these,
 * most of the time, is the right answer.
 *
 * Grouped, because the groups are alternatives rather than a list: turning
 * Mirostat on makes the shortlist parameters above it irrelevant, and DRY and
 * the repeat penalty are two answers to the same complaint.
 */
function SamplingSheet({
  open,
  sampling,
  onClose,
  onChange,
}: {
  open: boolean;
  sampling: ChatSampling;
  onClose: () => void;
  onChange: (next: ChatSampling) => void;
}) {
  const set = (key: SamplingKey, change: Partial<SamplingSetting>) =>
    onChange({ ...sampling, [key]: { ...sampling[key], ...change } });

  const anyOn = SAMPLING_PARAMS.some((param) => sampling[param.key]?.on);

  return (
    <Sheet open={open} onClose={onClose} title="Sampling" full>
      <div className="space-y-4">
        <p className="text-xs text-muted">
          Each of these is off until you turn it on, and off means the model server’s own — the
          flags it was started with, chosen for the model behind it. An untouched setting here
          sends nothing at all, which is almost always the better answer. Turn one on when you
          have a specific complaint about the replies.
        </p>

        {anyOn && (
          <button
            type="button"
            onClick={() => onChange(defaultSampling())}
            className="w-full rounded-xl bg-surface-2 py-2 text-xs text-body"
          >
            Hand all of it back to the server
          </button>
        )}

        {SAMPLING_GROUPS.map((group) => (
          <div key={group.key} className="space-y-2 border-t border-line pt-3">
            <div>
              <p className="text-sm">{group.label}</p>
              <p className="mt-0.5 text-[11px] text-muted">{group.hint}</p>
            </div>

            {SAMPLING_PARAMS.filter((param) => param.group === group.key).map((param) => {
              const setting = sampling[param.key];
              return (
                <div key={param.key} className="space-y-1.5 rounded-xl bg-surface-2 p-2.5">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm">{param.label}</p>
                      <p className="truncate font-mono text-[10px] text-muted">{param.key}</p>
                    </div>
                    <Toggle
                      checked={setting.on}
                      onChange={(on) => set(param.key, { on })}
                      label={param.label}
                    />
                  </div>

                  {/*
                    The number and its hint only once it is being overridden.
                    Nineteen sliders on screen at once is a wall; nineteen
                    switches is a list you can read.
                  */}
                  {setting.on && (
                    <>
                      <div className="flex items-center gap-2">
                        <input
                          type="range"
                          min={param.min}
                          max={param.max}
                          step={param.step}
                          value={setting.value}
                          aria-label={`${param.label} slider`}
                          onChange={(event) =>
                            set(param.key, { value: Number(event.target.value) })
                          }
                          className="h-1 min-w-0 flex-1 accent-accent"
                        />
                        <NumericInput
                          value={setting.value}
                          onChange={(value) => set(param.key, { value })}
                          integer={param.step >= 1}
                          min={param.min}
                          max={param.max}
                          aria-label={param.label}
                          className="w-20 shrink-0 rounded-lg border border-line bg-surface px-2 py-1 text-right text-sm tabular-nums"
                        />
                      </div>
                      <p className="text-[11px] text-muted">{param.hint}</p>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </Sheet>
  );
}

/**
 * What a picture started from the chat is generated with.
 *
 * Two modes, and the default is the boring one on purpose: while you are
 * iterating on a workflow, the chat should use exactly what the Generate screen
 * is holding, or the two drift and the prompt you accepted was rendered with
 * settings you never saw. The second mode is for when the chat is where you
 * start — then Generate is just wherever you last left something, and
 * inheriting that is worse than useless.
 */
function ChatGenerationSettingsEditor({
  chat,
  onPatch,
}: {
  chat: ChatSettings;
  onPatch: (change: Partial<ChatSettings>) => void;
}) {
  const workflows = useVisibleWorkflows();
  const chosen = chat.generation.workflowId;
  const detail = useWorkflow(chosen === '' ? null : chosen);

  const setValue = (fieldId: string, value: WidgetValue) =>
    onPatch({
      generation: {
        ...chat.generation,
        values: { ...chat.generation.values, [fieldId]: value },
      },
    });

  // Prompts are excluded: the whole point is that the model writes those.
  const fields = (detail.data?.schema.fields ?? []).filter(
    (field) =>
      !field.hidden && field.role !== 'prompt' && field.role !== 'negative_prompt',
  );

  return (
    <div className="space-y-2 border-t border-line pt-3">
      <p className="text-sm">Generating from the chat uses</p>

      <div className="flex flex-wrap gap-1">
        <button
          type="button"
          aria-pressed={chosen === ''}
          onClick={() => onPatch({ generation: { workflowId: '', values: {} } })}
          className={cn(
            'rounded-lg px-2.5 py-1.5 text-xs',
            chosen === '' ? 'bg-accent text-white' : 'bg-surface-2 text-muted',
          )}
        >
          Whatever Generate is on
        </button>
        {(workflows.data ?? []).map((workflow) => (
          <button
            key={workflow.id}
            type="button"
            aria-pressed={chosen === workflow.id}
            onClick={() => onPatch({ generation: { workflowId: workflow.id, values: {} } })}
            className={cn(
              'max-w-full truncate rounded-lg px-2.5 py-1.5 text-xs',
              chosen === workflow.id ? 'bg-accent text-white' : 'bg-surface-2 text-muted',
            )}
          >
            {workflow.name}
          </button>
        ))}
      </div>

      {chosen !== '' && (
        <>
          {detail.isLoading ? (
            <Spinner className="size-4 text-muted" />
          ) : fields.length === 0 ? (
            <p className="text-[11px] text-muted">That workflow has nothing to set.</p>
          ) : (
            <WorkflowScope workflowId={chosen}>
              <div className="grid grid-cols-2 gap-1.5">
                {fields.map((field) => (
                  <FieldChip
                    key={field.id}
                    field={field}
                    value={
                      chat.generation.values[field.id] ??
                      detail.data?.lastValues?.[field.id] ??
                      field.defaultValue
                    }
                    onChange={(next) => setValue(field.id, next)}
                  />
                ))}
              </div>
            </WorkflowScope>
          )}
          <p className="text-[11px] text-muted">
            Anything left alone uses that workflow’s own last values. Seeds are always redrawn.
          </p>
        </>
      )}
    </div>
  );
}

/**
 * The one path Latent asks for.
 *
 * A stock ComfyUI keeps its outputs, its inputs and its saved workflows in
 * fixed places under its installation directory, so asking for each of them
 * separately was asking the same question three times over. Enter the root and
 * the rest follows.
 */
function ComfyFolderSection() {
  const settings = useSettings();
  const updateSettings = useUpdateSettings();
  const scan = useScanWorkflows();
  const [path, setPath] = useState(settings.data?.comfyRoot ?? '');
  const [prefix, setPrefix] = useState(settings.data?.workflowPrefix ?? '');
  const [saved, setSaved] = useState(false);
  const [scanned, setScanned] = useState<string | null>(null);

  const root = settings.data?.comfyRoot ?? null;

  /*
   * Adopt the stored prefix once it arrives, without stamping on typing in
   * progress — the settings query refetches, and a field that resets itself
   * mid-word is the bug this shape avoids.
   */
  const storedPrefix = settings.data?.workflowPrefix;
  useEffect(() => {
    if (storedPrefix !== undefined) setPrefix((current) => (current === '' ? storedPrefix : current));
  }, [storedPrefix]);

  return (
    <section className="space-y-2">
      <h2 className="text-xs font-medium tracking-wide text-muted uppercase">ComfyUI folder</h2>
      <Card className="space-y-3">
        <p className="text-xs text-muted">
          Where ComfyUI is installed, on the machine running Latent. Everything else is found from
          there: <code>output</code> to import from, <code>input</code> to feed pictures in, and{' '}
          <code>user/default/workflows</code> to read workflows out of.
        </p>

        <div className="flex gap-2">
          <input
            value={path}
            onChange={(event) => {
              setPath(event.target.value);
              setSaved(false);
            }}
            placeholder="/home/you/ComfyUI"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            aria-label="ComfyUI folder"
            className="min-w-0 flex-1 rounded-xl border border-line bg-surface px-4 py-3 text-sm focus:border-accent focus:outline-none"
          />
          <Button
            variant="secondary"
            busy={updateSettings.isPending}
            onClick={() => {
              updateSettings.mutate({ comfyRoot: path.trim() || null });
              setSaved(true);
            }}
          >
            Save
          </Button>
        </div>

        {saved && <p className="text-xs text-muted">Saved.</p>}

        {/*
          Which files the scan is allowed to take.

          An install that has been used holds dozens of experiments, and
          reading all of them makes a list nobody can find anything in. A
          prefix on the file name is a mark you make once in the editor, and it
          turns the scan into exactly the handful you meant. It is dropped from
          the name afterwards, so it costs no width in the app.
        */}
        <div className="space-y-1.5 border-t border-line pt-3">
          <p className="text-xs text-muted">
            Only workflows whose file name starts with this are read, and the prefix is hidden from
            the name. Leave it empty to read everything.
          </p>
          <div className="flex gap-2">
            <input
              value={prefix}
              onChange={(event) => setPrefix(event.target.value)}
              onBlur={() => updateSettings.mutate({ workflowPrefix: prefix.trim() })}
              placeholder="API_"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              aria-label="Workflow name prefix"
              className="min-w-0 flex-1 rounded-xl border border-line bg-surface px-4 py-3 text-sm focus:border-accent focus:outline-none"
            />
          </div>
        </div>

        <div className="space-y-1.5 border-t border-line pt-3">
          <p className="text-xs text-muted">
            Reads every matching workflow saved in that installation. They arrive switched off —
            turn on the ones you use below, so the generate picker stays short.
          </p>
          <Button
            variant="secondary"
            size="sm"
            busy={scan.isPending}
            onClick={async () => {
              const result = await scan.mutateAsync();
              setScanned(
                result.ok
                  ? (result.message ??
                      `Read ${result.imported} new` +
                        (result.skipped ? `, ${result.skipped} already here` : '') +
                        (result.failed.length ? `, ${result.failed.length} could not be read` : ''))
                  : (result.message ?? 'Could not read that folder.'),
              );
            }}
          >
            Read workflows
          </Button>
          {scanned && <p className="text-xs text-muted">{scanned}</p>}
          {(scan.data?.failed.length ?? 0) > 0 && (
            <ul className="space-y-0.5 text-[11px] text-warn">
              {scan.data?.failed.slice(0, 8).map((failure) => (
                <li key={failure.path}>
                  {failure.path} — {failure.reason}
                </li>
              ))}
            </ul>
          )}
        </div>

        {!root && (
          <p className="text-[11px] text-muted">
            Nothing is configured yet, so importing and the input picker have nowhere to look.
          </p>
        )}
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
  const importFiles = useImportFiles();

  /*
   * Display only — the server does the real resolution, including the explicit
   * override an unusual install may still have set.
   */
  const root =
    settings.data?.importRoot ??
    (settings.data?.comfyRoot ? `${settings.data.comfyRoot.replace(/[/\\]$/, '')}/output` : null);

  const [open, setOpen] = useState(false);
  const [path, setPath] = useState('');
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
          ComfyUI’s <code>output</code> directory, found from the folder above. If ComfyUI runs on
          a remote instance its outputs are not on this filesystem, so point the folder above at a
          local copy, a network mount, or something synced.
        </p>

        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded-xl border border-line bg-surface px-4 py-3 text-xs text-muted">
            {root ?? 'No ComfyUI folder set'}
          </code>
          <Button
            variant="secondary"
            disabled={!root}
            onClick={() => {
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
