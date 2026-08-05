import { useState } from 'react';
import { createPortal } from 'react-dom';

import { findFieldByRole } from '@latent/shared';
import type { AppSettings, ChatToolCall, ProposedBlock } from '@latent/shared';

import { api } from '../api/client';
import { useVisibleWorkflows, useWorkflow } from '../api/queries';
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
}

export function ToolDialog({
  call,
  settings,
  onResolve,
}: {
  call: ChatToolCall;
  settings: AppSettings | null;
  onResolve: (decision: ToolDecision) => void | Promise<void>;
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
          <BuildPromptBody call={call} settings={settings} onResolve={onResolve} />
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
  const [own, setOwn] = useState('');
  const [busy, setBusy] = useState(false);

  const answer = (text: string) => {
    setBusy(true);
    void onResolve({ decision: 'accepted', note: text });
  };

  return (
    <>
      <div className="shrink-0 border-b border-line px-4 py-3">
        <p className="text-sm leading-relaxed font-medium">{call.question}</p>
        {call.reason !== '' && <p className="mt-1 text-xs text-muted">{call.reason}</p>}
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-3">
        {call.options.map((option) => (
          <button
            key={option}
            type="button"
            disabled={busy}
            onClick={() => answer(option)}
            className="w-full rounded-xl bg-surface-2 px-3 py-2.5 text-left text-sm active:bg-surface-3 disabled:opacity-50"
          >
            {option}
          </button>
        ))}

        <div className="flex items-end gap-2 pt-1">
          <textarea
            value={own}
            onChange={(event) => setOwn(event.target.value)}
            rows={1}
            aria-label="Your own answer"
            placeholder="Or say it yourself…"
            className="max-h-24 min-h-10 flex-1 resize-none rounded-xl border border-line bg-surface-2 px-3 py-2 text-sm focus:border-accent focus:outline-none"
          />
          <Button
            variant="primary"
            size="sm"
            className="h-10 shrink-0"
            disabled={busy || own.trim() === ''}
            onClick={() => answer(own.trim())}
          >
            Send
          </Button>
        </div>

        {/* Not answering is an answer: it tells the model to decide for itself
            rather than asking again. */}
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void onResolve({
              decision: 'rejected',
              note: 'The user would rather not answer. Choose sensibly and carry on.',
            })
          }
          className="w-full py-2 text-center text-xs text-muted"
        >
          Skip
        </button>
      </div>
    </>
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
}: {
  call: Extract<ChatToolCall, { tool: 'build_prompt' }>;
  settings: AppSettings | null;
  onResolve: (decision: ToolDecision) => void | Promise<void>;
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

      await onResolve({
        decision: 'accepted',
        note: `The user accepted the prompt and queued it: "${prompt.slice(0, 200)}"`,
        // The first of the batch. The transcript shows the whole run from it.
        ...(queued.generationIds[0] ? { generationId: queued.generationIds[0] } : {}),
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not queue that');
      setBusy(false);
    }
  };

  const imageField = detail ? findFieldByRole(detail.schema, 'image_input') : undefined;

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
          Reject
        </Button>
        <Button
          variant="primary"
          size="sm"
          className="flex-1"
          busy={busy}
          disabled={!detail}
          onClick={() => void generate()}
        >
          Generate
        </Button>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {call.reason !== '' && <p className="text-xs text-muted">{call.reason}</p>}

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
