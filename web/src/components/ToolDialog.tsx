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
}

export function ToolDialog({
  call,
  settings,
  onResolve,
  onGenerated,
}: {
  call: ChatToolCall;
  settings: AppSettings | null;
  onResolve: (decision: ToolDecision) => void | Promise<void>;
  /** The prompt was accepted and queued; the caller usually navigates away. */
  onGenerated: () => void;
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
            onGenerated={onGenerated}
          />
        ) : (
          <PromptBlocksBody call={call} onResolve={onResolve} />
        )}
      </div>
    </div>,
    document.body,
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
  onGenerated,
}: {
  call: Extract<ChatToolCall, { tool: 'build_prompt' }>;
  settings: AppSettings | null;
  onResolve: (decision: ToolDecision) => void | Promise<void>;
  onGenerated: () => void;
}) {
  const workflows = useVisibleWorkflows();
  const workflowId =
    localStorage.getItem('latent.lastWorkflowId') ?? workflows.data?.[0]?.id ?? null;
  const workflow = useWorkflow(
    workflowId && workflows.data?.some((entry) => entry.id === workflowId)
      ? workflowId
      : (workflows.data?.[0]?.id ?? null),
  );

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState(call.prompt);

  const detail = workflow.data;
  const draft = useFormDrafts((state) => (detail ? state.drafts[detail.id] : undefined));

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
      await api.generate({
        workflowId: detail.id,
        values,
        randomizeSeeds: detail.schema.fields.some(
          (field) => field.role === 'seed' && !lockedSeeds.includes(field.id),
        ),
        lockedSeedFields: lockedSeeds,
        batchCount: draft?.batchCount ?? 1,
      });

      // The form keeps the prompt too, so going to Generate shows what ran.
      useFormDrafts.getState().patch(detail.id, { values });

      await onResolve({
        decision: 'accepted',
        note: `The user accepted the prompt and queued it: "${prompt.slice(0, 200)}"`,
      });
      onGenerated();
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

        {/* What "Generate" would actually do, so accepting is not a leap. */}
        <div className="rounded-lg border border-line bg-surface-2/60 px-2.5 py-2">
          <p className="mb-1 text-[10px] tracking-wide text-muted uppercase">
            Generating with
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
