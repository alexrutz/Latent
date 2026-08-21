import { useState } from 'react';
import { createPortal } from 'react-dom';

import { findFieldByRole } from '@latent/shared';
import type { AppSettings, ChatToolCall, ProposedBlock } from '@latent/shared';

import { useVisibleWorkflows, useWorkflow } from '../api/queries';
import { PromptDiff, promptChanged } from './PromptDiff';
import { useFormDrafts } from '../state/formDraft';
import { queuePrompt } from '../lib/queuePrompt';
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
  onMinimize,
  previousPrompt = '',
  workflowId,
}: {
  call: ChatToolCall;
  settings: AppSettings | null;
  onResolve: (decision: ToolDecision) => void | Promise<void>;
  /** Set when this is an old call being looked at again rather than decided. */
  revisit?: RevisitActions;
  /**
   * Fold the dialog away without deciding it.
   *
   * Given only where there is something to come back to. Deciding is often not
   * the next thing you want to do — the answer is in the gallery, or in what
   * was said further up, and both are behind this. Omitted for a call being
   * revisited, which closes without consequence.
   */
  onMinimize?: () => void;
  /** The last prompt this conversation generated, for marking what changed. */
  previousPrompt?: string;
  /**
   * Queue it the moment it is ready, without waiting to be read.
   *
   * What the prompt button does by default. It runs through this dialog rather
   * than through a copy of its logic, so "generate straight away" and "show me
   * first" cannot drift apart in which workflow or which values they use.
   */
  /** Forces which workflow an accepted prompt is queued with. */
  workflowId?: string;
}) {
  return createPortal(
    <div className="fixed inset-0 z-70 flex items-center justify-center p-4" role="dialog" aria-modal="true">
      {/*
        The blur is on the layer behind, not on this one. `backdrop-blur` here
        would blur everything under the dialog including its own background,
        which reads as a smear rather than as depth.
      */}
      <div className="absolute inset-0 bg-ink/50 backdrop-blur-sm" role="presentation" />

      {/*
        Wider on a tablet, because what is in it is a paragraph.

        A prompt is a long sentence and a set of questions is several; at a
        phone's width both are a narrow ribbon of text scrolling past a fixed
        pair of buttons. The cap is still a cap — a dialog as wide as a
        nine-inch screen would put Reject and Generate a hand's width apart —
        but it is the width of a page rather than of a phone.
      */}
      <div className="animate-rise relative flex max-h-[85svh] w-full max-w-md flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl tablet:max-h-[80svh] tablet:max-w-xl">
        {/*
          A strip of its own, above everything the dialog decides.

          It used to float in the top-right corner, which put it over the row
          holding Reject and Generate — not flush with either, and close enough
          to Generate that putting the dialog aside and queueing a render were
          one slip apart. Two actions that different should not share an edge.
          Here it is a row nothing else lives in, aligned to the left because
          the buttons that commit to something are on the right.
        */}
        {onMinimize && (
          <div className="flex shrink-0 items-center border-b border-line/60 px-2 py-1">
            <button
              type="button"
              onClick={onMinimize}
              aria-label="Put this aside"
              title="Put this aside and come back to it"
              className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-[11px] text-muted active:bg-surface-2"
            >
              <span aria-hidden className="text-sm leading-none">
                −
              </span>
              Put aside
            </button>
          </div>
        )}

        {/* A revision is a prompt like any other, and the dialog it opens is
            the same one: the same editing, the same workflow picker, the same
            Generate. What differs is what it says about itself. */}
        {call.tool === 'build_prompt' || call.tool === 'revise_prompt' ? (
          <BuildPromptBody
            call={call}
            settings={settings}
            onResolve={onResolve}
            revisit={revisit}
            previousPrompt={previousPrompt}
            workflowId={workflowId}
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

      {/*
       * Several at once, because that is how the decisions arrive: two related
       * choices are one moment's thinking and two taps, and asking them a turn
       * apart is two waits for a local model to reply.
       *
       * Which only works if they are on screen together. Divided by hairlines
       * rather than by whitespace, so the rows can sit close without running
       * into each other — four questions used to be a scroll on a phone.
       */}
      <div className="min-h-0 flex-1 divide-y divide-line overflow-y-auto px-3">
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

/**
 * One question: its ready answers, and a box for the one it did not think of.
 *
 * The answers wrap rather than being cut off. They used to be one line each
 * with an ellipsis, which is fine for "Portrait" and useless for the answers
 * worth reading — a model that has thought about the question writes "warm,
 * low sun through haze" and the button showed "warm, low sun…". A tall button
 * is a readable one, and there are rarely more than four.
 *
 * The typed answer is folded behind the last chip. It is the least-used part of
 * the row by a distance, and left open it cost every question a field's worth
 * of height — which is the difference between four questions on a phone screen
 * and seven.
 */
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
  const chosen = entry.options.includes(answer);
  const [typing, setTyping] = useState(false);
  const own = chosen ? '' : answer;

  return (
    <div className="space-y-1.5 py-2.5">
      <p className="text-sm leading-snug">{entry.question}</p>

      <div className="flex flex-wrap items-stretch gap-1.5">
        {entry.options.map((option) => (
          <button
            key={option}
            type="button"
            disabled={disabled}
            aria-pressed={answer === option}
            onClick={() => {
              setTyping(false);
              onAnswer(answer === option ? '' : option);
            }}
            className={cn(
              'max-w-full whitespace-normal break-words rounded-xl px-2.5 py-1.5 text-left text-[0.8125rem] leading-snug disabled:opacity-50',
              answer === option ? 'bg-accent text-white' : 'bg-surface-2 active:bg-surface-3',
            )}
          >
            {option}
          </button>
        ))}

        {/* One more chip, in the same row: the answer it did not think of is
            often the real one, but it is not worth a field of its own until
            somebody reaches for it. Once opened it stays — closing a field
            because you looked away from it is how a half-typed answer is
            lost — and tapping a ready answer instead is what folds it back. */}
        {!typing && own === '' && (
          <button
            type="button"
            disabled={disabled}
            onClick={() => setTyping(true)}
            aria-label={`Say it yourself: ${entry.question}`}
            className="rounded-xl border border-dashed border-line px-2.5 py-1.5 text-[0.8125rem] leading-snug text-muted active:bg-surface-2 disabled:opacity-50"
          >
            Say it yourself…
          </button>
        )}
      </div>

      {(typing || own !== '') && (
        <input
          value={own}
          autoFocus={typing}
          onChange={(event) => onAnswer(event.target.value)}
          disabled={disabled}
          aria-label={`Your own answer to: ${entry.question}`}
          placeholder="Or say it yourself…"
          className="w-full rounded-lg border border-line bg-surface-2 px-2.5 py-1.5 text-xs focus:border-accent focus:outline-none"
        />
      )}
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
  workflowId: forced,
}: {
  call: Extract<ChatToolCall, { tool: 'build_prompt' | 'revise_prompt' }>;
  settings: AppSettings | null;
  onResolve: (decision: ToolDecision) => void | Promise<void>;
  revisit?: RevisitActions;
  previousPrompt: string;
  /**
   * The workflow this one must use, whatever the settings say.
   *
   * Set by a wandering run, which has a workflow of its own: the graph you are
   * iterating with is often the slow one, and an endless run wants the fast one.
   */
  workflowId?: string;
}) {
  /** A second attempt at a prompt whose picture missed, rather than a first. */
  const revised = call.tool === 'revise_prompt';
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

  const preferred = forced || (settings?.chat.generation.workflowId ?? '');
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
  // Not for a forced workflow: the chat's stored values describe the graph it
  // was set up for, and this is a different one.
  const ownSettings = !forced && preferred !== '' && workflowId === preferred;

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
      // The same function the app uses when it accepts a prompt itself, so the
      // two cannot drift into queueing the same prompt differently.
      const generationId = await queuePrompt(
        { detail, draft, ownSettings },
        // As edited, not as proposed.
        prompt,
        call.negativePrompt,
      );

      if (revisit) {
        // Decided long ago; there is no decision left to record, only a run.
        await revisit.onRerun(generationId, prompt);
        return;
      }

      await onResolve({
        decision: 'accepted',
        note: `The user accepted the ${revised ? 'revised ' : ''}prompt and queued it: ` +
          `"${prompt.slice(0, 200)}"`,
        ...(generationId ? { generationId } : {}),
        // As edited, not as proposed: the transcript shows what actually ran.
        prompt,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not queue that');
      setBusy(false);
    }
  };

  const imageField = detail ? findFieldByRole(detail.schema, 'image_input') : undefined;

  /*
   * The notes this round drew, when it was a wandering one.
   *
   * Only on a `build_prompt` — a rewrite is a second look at a picture that
   * already exists, and what it was originally drawn from is on the proposal
   * further up rather than on this one.
   */
  const drawnFrom = call.tool === 'build_prompt' ? (call.wanderNotes ?? []) : [];

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
        {/*
          What this is, when it is not the usual thing.

          A rewrite arrives looking exactly like a first prompt, and the
          difference matters: it exists because the last picture missed, and the
          mark it was given is the reason there is a dialog here at all.
        */}
        {revised && (
          <div className="flex items-baseline justify-between gap-2">
            <p className="text-xs font-medium">After looking at the picture</p>
            {typeof call.score === 'number' && (
              <span className="shrink-0 rounded-md bg-surface-2 px-1.5 py-0.5 text-[11px] text-muted tabular-nums">
                matched {call.score}/10
              </span>
            )}
          </div>
        )}

        {call.reason !== '' && <p className="text-xs text-muted">{call.reason}</p>}

        {/*
          What this one was made of.

          The mode used to say nothing about this, on the argument that being
          surprised by your own taste is the point and reading a list of it is
          not. Half right: that holds *while you are being shown things*, and
          the moment one comes out well the only question is why. So it is here,
          in the dialog you have to go and open, rather than written above every
          picture as it arrives.

          Only what this round drew — never the whole profile, which stays
          behind the password where it belongs.
        */}
        {drawnFrom.length > 0 && (
          <div className="rounded-lg border border-accent/25 bg-accent/5 px-2.5 py-2">
            <p className="mb-1 text-[10px] tracking-wide text-accent/80 uppercase">
              Drawn from what you like
            </p>
            <ul className="space-y-0.5">
              {drawnFrom.map((drawn, index) => (
                <li key={`${drawn}-${index}`} className="text-xs leading-snug">
                  <span aria-hidden className="mr-1.5 text-muted">
                    ❋
                  </span>
                  {drawn}
                </li>
              ))}
            </ul>
          </div>
        )}

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
