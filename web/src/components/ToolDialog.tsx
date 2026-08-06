import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { findFieldByRole } from '@latent/shared';
import type { AppSettings, ChatToolCall, ProposedBlock } from '@latent/shared';

import { api } from '../api/client';
import { useVisibleWorkflows, useWorkflow } from '../api/queries';
import { PromptDiff, promptChanged } from './PromptDiff';
import { useFormDrafts } from '../state/formDraft';
import { Button, cn, ErrorNote, Spinner } from './ui';

/**
 * What a tool call looks like before it is allowed to happen.
 *
 * Every tool the model can reach changes something the user owns — their block
 * library, their GPU's next twenty minutes — so none of them run on the model's
 * say-so. The call arrives as a proposal: readable, editable where editing makes
 * sense, and refused with one tap.
 *
 * It floats over the transcript rather than replacing it, and the transcript
 * behind it is blurred. The decision is *about* what was just said, so hiding
 * that would be losing the context the decision needs; leaving it sharp would
 * make two things look equally interactive when only one is.
 */

export interface ToolDecision {
  decision: 'accepted' | 'rejected';
  blocks?: ProposedBlock[];
  note?: string;
  /** The run an accepted prompt started, so the transcript can show it. */
  generationId?: string;
  /** The prompt as it was queued, so the next one can be marked against it. */
  prompt?: string;
}

/**
 * Reopening a prompt from further up the conversation.
 *
 * The decision was made long ago, so there is nothing left to accept or refuse:
 * what is on offer is generating it again — usually with something changed —
 * and winding the conversation back to it.
 */
export interface RevisitActions {
  /** Queued again; the run's id, so the transcript can show what it made. */
  onRerun: (generationId: string | null, prompt: string) => void | Promise<void>;
  /** Drop everything said after this prompt and carry on from here. */
  onRewind: () => void | Promise<void>;
  onClose: () => void;
}

export function ToolDialog({
  call,
  settings,
  onResolve,
  revisit,
  previousPrompt = '',
  autoAccept = false,
}: {
  call: ChatToolCall;
  settings: AppSettings | null;
  onResolve: (decision: ToolDecision) => void | Promise<void>;
  /** Set when this is an old call being looked at again rather than decided. */
  revisit?: RevisitActions;
  /** The last prompt this conversation generated, for marking what changed. */
  previousPrompt?: string;
  /**
   * Queue it the moment it is ready, without waiting to be read.
   *
   * What the prompt button does by default. It runs through this dialog rather
   * than through a copy of its logic, so "generate straight away" and "show me
   * first" cannot drift apart in which workflow or which values they use.
   */
  autoAccept?: boolean;
}) {
  return createPortal(
    <div className="fixed inset-0 z-70 flex items-center justify-center p-4" role="dialog" aria-modal="true">
      {/*
        The blur is on the layer behind, not on this one. `backdrop-blur` here
        would blur everything under the dialog including its own background,
        which reads as a smear rather than as depth.
      */}
      <div className="absolute inset-0 bg-ink/50 backdrop-blur-sm" role="presentation" />

      <div className="animate-rise relative flex max-h-[85svh] w-full max-w-md flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl">
        {call.tool === 'build_prompt' ? (
          <BuildPromptBody
            call={call}
            settings={settings}
            onResolve={onResolve}
            revisit={revisit}
            previousPrompt={previousPrompt}
            autoAccept={autoAccept}
          />
        ) : call.tool === 'ask_user' ? (
          <AskUserBody call={call} onResolve={onResolve} />
        ) : (
          <PromptBlocksBody call={call} onResolve={onResolve} />
        )}
      </div>
    </div>,
    document.body,
  );
}

/**
 * A question, with the answers already written out.
 *
 * The cheapest thing in the module and one of the most useful: a model that
 * guesses at "portrait or landscape" produces something plausible and wrong,
 * and a model that stops to ask costs one tap. The ready answers are what keep
 * that tap from becoming a typing exercise on a phone — and the box underneath
 * is there because the answer it did not think of is often the real one.
 */
function AskUserBody({
  call,
  onResolve,
}: {
  call: Extract<ChatToolCall, { tool: 'ask_user' }>;
  onResolve: (decision: ToolDecision) => void | Promise<void>;
}) {
  /** One answer per question, by index. A tap or a typed one, the same thing. */
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);

  const answered = call.questions.filter((_, index) => (answers[index] ?? '') !== '').length;
  const all = answered === call.questions.length;

  const send = () => {
    setBusy(true);
    void onResolve({
      decision: 'accepted',
      // Written back as question-and-answer pairs rather than bare answers:
      // "Landscape" on its own tells the model nothing about which of three
      // questions it belongs to.
      note: call.questions
        .map((entry, index) => `${entry.question} — ${answers[index] ?? 'no preference'}`)
        .join('\n'),
    });
  };

  return (
    <>
      <div className="shrink-0 border-b border-line px-4 py-3">
        <p className="text-sm font-medium">
          {call.questions.length === 1 ? 'One question' : `${call.questions.length} questions`}
        </p>
        {call.reason !== '' && <p className="mt-0.5 text-xs text-muted">{call.reason}</p>}
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-3 py-3">
        {/* Several at once, because that is how the decisions arrive: two
            related choices are one moment's thinking and two taps, and asking
            them a turn apart is two waits for a local model to reply. */}
        {call.questions.map((entry, index) => (
          <QuestionRow
            key={`${entry.question}-${index}`}
            entry={entry}
            answer={answers[index] ?? ''}
            disabled={busy}
            onAnswer={(text) => setAnswers((current) => ({ ...current, [index]: text }))}
          />
        ))}
      </div>

      <div className="flex shrink-0 items-center gap-2 border-t border-line px-3 py-2">
        {/* Not answering is an answer: it tells the model to decide for itself
            rather than asking again. */}
        <Button
          variant="ghost"
          size="sm"
          className="flex-1"
          disabled={busy}
          onClick={() =>
            void onResolve({
              decision: 'rejected',
              note: 'The user would rather not answer. Choose sensibly and carry on.',
            })
          }
        >
          Skip
        </Button>
        <Button
          variant="primary"
          size="sm"
          className="flex-1"
          busy={busy}
          disabled={answered === 0}
          onClick={send}
        >
          {all ? 'Send' : `Send ${answered} of ${call.questions.length}`}
        </Button>
      </div>
    </>
  );
}

/** One question: its ready answers, and a box for the one it did not think of. */
function QuestionRow({
  entry,
  answer,
  disabled,
  onAnswer,
}: {
  entry: { question: string; options: string[] };
  answer: string;
  disabled: boolean;
  onAnswer: (text: string) => void;
}) {
  const [own, setOwn] = useState('');
  const chosen = entry.options.includes(answer);

  return (
    <div className="space-y-1.5">
      <p className="text-sm leading-relaxed">{entry.question}</p>

      <div className="flex flex-wrap gap-1.5">
        {entry.options.map((option) => (
          <button
            key={option}
            type="button"
            disabled={disabled}
            aria-pressed={answer === option}
            onClick={() => {
              setOwn('');
              onAnswer(answer === option ? '' : option);
            }}
            className={cn(
              'max-w-full truncate rounded-xl px-3 py-2 text-left text-sm disabled:opacity-50',
              answer === option ? 'bg-accent text-white' : 'bg-surface-2 active:bg-surface-3',
            )}
          >
            {option}
          </button>
        ))}
      </div>

      <input
        value={chosen ? '' : (own || answer)}
        onChange={(event) => {
          setOwn(event.target.value);
          onAnswer(event.target.value);
        }}
        disabled={disabled}
        aria-label={`Your own answer to: ${entry.question}`}
        placeholder="Or say it yourself…"
        className="w-full rounded-lg border border-line bg-surface-2 px-2.5 py-1.5 text-xs focus:border-accent focus:outline-none"
      />
    </div>
  );
}

/**
 * A finished prompt, with the two buttons that matter at the top.
 *
 * Reject and Generate sit above the prompt rather than below it because the
 * prompt can be long, and having to scroll a paragraph to reach the decision is
 * exactly the friction this tool exists to remove. The settings underneath say
 * what "generate" would actually do — the workflow, the size, the steps — so
 * accepting is not a leap.
 */
function BuildPromptBody({
  call,
  settings,
  onResolve,
  revisit,
  previousPrompt,
  autoAccept,
}: {
  call: Extract<ChatToolCall, { tool: 'build_prompt' }>;
  settings: AppSettings | null;
  onResolve: (decision: ToolDecision) => void | Promise<void>;
  revisit?: RevisitActions;
  previousPrompt: string;
  autoAccept: boolean;
}) {
  const workflows = useVisibleWorkflows();

  /**
   * Which workflow this one gets generated with.
   *
   * `null` until you touch the picker, so the default from Settings applies —
   * and once you pick, that choice belongs to *this* dialog and nothing else.
   * A prompt is not always for the workflow you last used: the same
   * description is worth trying through the fast draft graph and the slow one,
   * and being sent to Settings between the two would be absurd.
   */
  const [override, setOverride] = useState<string | null>(null);

  const preferred = settings?.chat.generation.workflowId ?? '';
  const fallback =
    localStorage.getItem('latent.lastWorkflowId') ?? workflows.data?.[0]?.id ?? null;
  const wanted = override ?? (preferred !== '' ? preferred : fallback);
  const workflowId =
    wanted && workflows.data?.some((entry) => entry.id === wanted)
      ? wanted
      : (workflows.data?.[0]?.id ?? null);
  const workflow = useWorkflow(workflowId);

  /**
   * True when the values come from the chat's own settings rather than the form.
   *
   * Only while the chosen workflow *is* the one those settings are for.
   * Overriding to another workflow means its values are the honest starting
   * point — the chat's stored values describe a different graph's fields.
   */
  const ownSettings = preferred !== '' && workflowId === preferred;

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState(call.prompt);

  const detail = workflow.data;
  const formDraft = useFormDrafts((state) => (detail ? state.drafts[detail.id] : undefined));
  const draft = ownSettings
    ? {
        values: { ...detail?.lastValues, ...settings?.chat.generation.values },
        lockedSeeds: [] as string[],
        batchCount: 1,
      }
    : formDraft;

  /**
   * Queue it exactly as the Generate screen would.
   *
   * The same workflow, the same values, the same seed handling — the whole
   * point is that accepting here is not a different way of generating with
   * different results. Only the prompt fields are replaced.
   */
  const generate = async () => {
    if (!detail) return;
    setBusy(true);
    setError(null);

    try {
      const values = { ...draft?.values };
      for (const field of detail.schema.fields) {
        if (field.hidden) continue;
        if (field.role === 'prompt') values[field.id] = prompt;
        if (field.role === 'negative_prompt' && call.negativePrompt) {
          values[field.id] = call.negativePrompt;
        }
      }

      const lockedSeeds = draft?.lockedSeeds ?? [];
      const queued = await api.generate({
        workflowId: detail.id,
        values,
        randomizeSeeds: detail.schema.fields.some(
          (field) => field.role === 'seed' && !lockedSeeds.includes(field.id),
        ),
        lockedSeedFields: lockedSeeds,
        batchCount: draft?.batchCount ?? 1,
      });

      // Only when the form is what ran. Writing the chat's own values into the
      // form would change what Generate does next, which is not what was asked.
      if (!ownSettings) useFormDrafts.getState().patch(detail.id, { values });

      // The first of the batch. The transcript shows the whole run from it.
      const generationId = queued.generationIds[0] ?? null;

      if (revisit) {
        // Decided long ago; there is no decision left to record, only a run.
        await revisit.onRerun(generationId, prompt);
        return;
      }

      await onResolve({
        decision: 'accepted',
        note: `The user accepted the prompt and queued it: "${prompt.slice(0, 200)}"`,
        ...(generationId ? { generationId } : {}),
        // As edited, not as proposed: the transcript shows what actually ran.
        prompt,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not queue that');
      setBusy(false);
    }
  };

  /*
   * Queue it as soon as there is something to queue with.
   *
   * `detail` arrives a tick after the dialog mounts, so this waits for it
   * rather than firing on mount and finding no workflow. The ref is what keeps
   * a re-render from queueing the same prompt twice.
   */
  const fired = useRef(false);
  useEffect(() => {
    if (!autoAccept || fired.current || !detail || busy) return;
    fired.current = true;
    void generate();
  }, [autoAccept, detail, busy, generate]);

  const imageField = detail ? findFieldByRole(detail.schema, 'image_input') : undefined;

  /*
   * Nothing to read while it queues itself.
   *
   * Showing the whole dialog for the half-second before it closes would be a
   * flash of buttons nobody is meant to press.
   */
  if (autoAccept && error === null) {
    return (
      <div className="flex items-center gap-3 px-4 py-5">
        <Spinner className="size-4 text-muted" />
        <p className="min-w-0 flex-1 truncate text-sm text-muted">Generating that prompt…</p>
      </div>
    );
  }

  return (
    <>
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
        <Button
          variant="ghost"
          size="sm"
          className="flex-1"
          disabled={busy}
          onClick={() => (revisit ? revisit.onClose() : void onResolve({ decision: 'rejected' }))}
        >
          {revisit ? 'Close' : 'Reject'}
        </Button>
        <Button
          variant="primary"
          size="sm"
          className="flex-1"
          busy={busy}
          disabled={!detail}
          onClick={() => void generate()}
        >
          {revisit ? 'Generate again' : 'Generate'}
        </Button>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {call.reason !== '' && <p className="text-xs text-muted">{call.reason}</p>}

        {/*
          What changed, above the box rather than inside it.

          A textarea cannot carry colour, and making the prompt read-only to
          mark it up would cost the editing that matters more. So the marked
          version sits above as something to read, and the box below stays the
          thing you type in.
        */}
        {settings?.chat.showDiff.inDialog && promptChanged(previousPrompt, prompt) && (
          <div className="rounded-lg border border-line bg-surface-2/60 px-2.5 py-2">
            <p className="mb-1 text-[10px] tracking-wide text-muted uppercase">
              Changed from the last prompt
            </p>
            <PromptDiff previous={previousPrompt} next={prompt} className="text-xs" />
          </div>
        )}

        <textarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          rows={6}
          aria-label="The prompt"
          className="w-full resize-none rounded-xl border border-line bg-surface-2 px-3 py-2 text-sm leading-relaxed focus:border-accent focus:outline-none"
        />

        {call.negativePrompt && (
          <div>
            <p className="text-[11px] tracking-wide text-muted uppercase">Negative</p>
            <p className="text-xs break-words">{call.negativePrompt}</p>
          </div>
        )}

        {/*
          Which workflow, right here.

          The same description is worth trying through the fast draft graph and
          the slow one, and being sent to Settings between the two would be
          absurd. The default is what Settings says; this only overrides it for
          this one prompt.
        */}
        {(workflows.data?.length ?? 0) > 1 && (
          <div className="space-y-1">
            <p className="text-[10px] tracking-wide text-muted uppercase">Workflow</p>
            <div className="flex flex-wrap gap-1">
              {(workflows.data ?? []).map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  aria-pressed={workflowId === entry.id}
                  disabled={busy}
                  onClick={() => setOverride(entry.id)}
                  className={cn(
                    'max-w-full truncate rounded-lg px-2.5 py-1.5 text-xs',
                    workflowId === entry.id
                      ? 'bg-accent text-white'
                      : 'bg-surface-2 text-muted active:bg-surface-3',
                  )}
                >
                  {entry.name}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* What "Generate" would actually do, so accepting is not a leap. */}
        <div className="rounded-lg border border-line bg-surface-2/60 px-2.5 py-2">
          <p className="mb-1 text-[10px] tracking-wide text-muted uppercase">
            Generating with {ownSettings ? "the chat's own settings" : 'the Generate screen'}
          </p>
          {workflow.isLoading ? (
            <Spinner className="size-4 text-muted" />
          ) : detail ? (
            <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted">
              <span className="text-body">{detail.name}</span>
              {summarise(detail, draft?.values).map((line) => (
                <span key={line}>{line}</span>
              ))}
              <span>×{draft?.batchCount ?? 1}</span>
              {imageField && draft?.values?.[imageField.id] ? (
                <span>image: {String(draft.values[imageField.id])}</span>
              ) : null}
              {settings?.queuePolicy && settings.queuePolicy !== 'append' && (
                <span className="text-warn">
                  {settings.queuePolicy === 'replace'
                    ? 'replaces the queue'
                    : 'clears what is waiting'}
                </span>
              )}
            </div>
          ) : (
            <p className="text-[11px] text-warn">
              No workflow is switched on, so there is nothing to generate with.
            </p>
          )}
        </div>

        {/*
          Winding back is separate from generating, and deliberately at the
          bottom.

          Generating again is the cheap, common thing — a different sampler, one
          more step — and it leaves the conversation alone. This one throws away
          everything said after this prompt, so it belongs where you arrive
          after reading rather than under your thumb.
        */}
        {revisit && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void revisit.onRewind()}
            className="w-full border-t border-line pt-3 pb-1 text-center text-xs text-accent"
          >
            Carry on from here
            <span className="mt-0.5 block text-[11px] text-muted">
              Everything said after this is dropped.
            </span>
          </button>
        )}

        <ErrorNote>{error}</ErrorNote>
      </div>
    </>
  );
}

/** A short line per interesting parameter, from the form as it currently stands. */
function summarise(
  detail: NonNullable<ReturnType<typeof useWorkflow>['data']>,
  values: Record<string, unknown> | undefined,
): string[] {
  const wanted = ['steps', 'cfg', 'sampler', 'width', 'height'];
  return detail.schema.fields
    .filter((field) => wanted.includes(field.role) && !field.hidden)
    .map((field) => {
      const value = values?.[field.id] ?? field.defaultValue;
      return `${field.label.toLowerCase()} ${String(value)}`;
    })
    .slice(0, 5);
}

/**
 * Proposed blocks, one row at a time.
 *
 * Per-block rather than all-or-nothing because that is how the suggestions
 * actually land: three good ones and a fourth that misunderstood the point.
 * Each row can be corrected in place — the model's wording is a starting point,
 * not the thing being voted on.
 */
function PromptBlocksBody({
  call,
  onResolve,
}: {
  call: Extract<ChatToolCall, { tool: 'prompt_blocks' }>;
  onResolve: (decision: ToolDecision) => void | Promise<void>;
}) {
  const [blocks, setBlocks] = useState(call.blocks);
  const [kept, setKept] = useState<boolean[]>(() => call.blocks.map(() => true));
  const [editing, setEditing] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const keptCount = kept.filter(Boolean).length;

  const patch = (index: number, change: Partial<ProposedBlock>) =>
    setBlocks((current) =>
      current.map((block, at) => (at === index ? { ...block, ...change } : block)),
    );

  return (
    <>
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
        <Button
          variant="ghost"
          size="sm"
          className="flex-1"
          disabled={busy}
          onClick={() => void onResolve({ decision: 'rejected' })}
        >
          Reject all
        </Button>
        <Button
          variant="primary"
          size="sm"
          className="flex-1"
          busy={busy}
          disabled={keptCount === 0}
          onClick={() => {
            setBusy(true);
            void onResolve({
              decision: 'accepted',
              blocks: blocks.filter((_, index) => kept[index]),
            });
          }}
        >
          Keep {keptCount}
        </Button>
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-3">
        {call.reason !== '' && <p className="text-xs text-muted">{call.reason}</p>}

        <ul className="space-y-1.5">
          {blocks.map((block, index) => (
            <li
              key={`${block.name}-${index}`}
              className={cn(
                'rounded-lg border px-2.5 py-2',
                kept[index] ? 'border-accent/40 bg-accent/10' : 'border-line bg-surface-2 opacity-60',
              )}
            >
              <div className="flex items-start gap-2">
                <button
                  type="button"
                  aria-pressed={kept[index]}
                  aria-label={`Keep ${block.name}`}
                  onClick={() =>
                    setKept((current) => current.map((on, at) => (at === index ? !on : on)))
                  }
                  className={cn(
                    'mt-px grid size-5 shrink-0 place-items-center rounded border text-[10px]',
                    kept[index]
                      ? 'border-accent bg-accent text-white'
                      : 'border-line text-transparent',
                  )}
                >
                  ✓
                </button>

                <div className="min-w-0 flex-1">
                  {editing === index ? (
                    <div className="space-y-1.5">
                      <input
                        value={block.name}
                        onChange={(event) => patch(index, { name: event.target.value })}
                        aria-label="Block name"
                        className="w-full rounded-md border border-line bg-surface px-2 py-1 text-xs focus:border-accent focus:outline-none"
                      />
                      <input
                        value={block.category}
                        onChange={(event) => patch(index, { category: event.target.value })}
                        aria-label="Block category"
                        placeholder="Category"
                        className="w-full rounded-md border border-line bg-surface px-2 py-1 text-xs focus:border-accent focus:outline-none"
                      />
                      <textarea
                        value={block.text}
                        onChange={(event) => patch(index, { text: event.target.value })}
                        rows={2}
                        aria-label="Block text"
                        className="w-full resize-none rounded-md border border-line bg-surface px-2 py-1 text-xs focus:border-accent focus:outline-none"
                      />
                    </div>
                  ) : (
                    <>
                      <p className="truncate text-xs font-medium">
                        {block.name}
                        {block.category !== '' && (
                          <span className="ml-1.5 font-normal text-muted">{block.category}</span>
                        )}
                        {block.action !== 'add' && (
                          <span className="ml-1.5 font-normal text-warn">{block.action}</span>
                        )}
                      </p>
                      <p className="text-[11px] break-words text-muted">{block.text}</p>
                    </>
                  )}
                </div>

                <button
                  type="button"
                  onClick={() => setEditing(editing === index ? null : index)}
                  aria-label={`Edit ${block.name}`}
                  className="shrink-0 text-[11px] text-accent"
                >
                  {editing === index ? 'Done' : 'Edit'}
                </button>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
