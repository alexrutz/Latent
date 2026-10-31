import { useMemo, useState } from 'react';

import { workflowSteps } from '@latent/shared';
import type { ApiWorkflow, ObjectInfo, StepNode } from '@latent/shared';

import { cn } from './ui';

/**
 * The workflow in the order it runs, a step per column.
 *
 * Left to right is the run: step one is what needs nothing (loaders, empty
 * latents), the last is what saves, and scrolling sideways follows the work
 * along. Top to bottom, a column is the nodes of one step. Each card says what
 * it reads from, so a chain can be followed across; a tap opens it to show
 * where every input comes from and what every value is set to. The values are
 * for reading — they are changed on the form — but Bypass is right there on
 * each card, since leaving a node out is what this view is for.
 */
export function WorkflowSteps({
  workflow,
  definitions,
  bypassed,
  onToggleBypass,
  onClearBypass,
  problem,
}: {
  workflow: ApiWorkflow;
  definitions: ObjectInfo;
  /** Node ids switched off for this run. */
  bypassed: ReadonlySet<string>;
  onToggleBypass: (nodeId: string) => void;
  onClearBypass: () => void;
  /** Why the current bypasses would be refused, if they would. */
  problem?: string;
}) {
  const { steps } = useMemo(() => workflowSteps(workflow, definitions), [workflow, definitions]);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  /** The card opened last; what it reads and feeds are marked across the steps. */
  const [focus, setFocus] = useState<string | null>(null);

  const related = useMemo(() => {
    const node = focus ? steps.flat().find((entry) => entry.id === focus) : undefined;
    if (!node) return new Set<string>();
    return new Set([
      ...node.inputs.flatMap((input) => (input.from ? [input.from.id] : [])),
      ...node.feeds.map((target) => target.id),
    ]);
  }, [focus, steps]);

  const toggleOpen = (id: string) => {
    const next = new Set(open);
    if (next.has(id)) {
      next.delete(id);
      if (focus === id) setFocus(null);
    } else {
      next.add(id);
      setFocus(id);
    }
    setOpen(next);
  };

  return (
    <div className="space-y-2">
      <div className="flex min-h-7 items-center gap-2 text-xs">
        {bypassed.size > 0 ? (
          <>
            <span className="rounded-lg bg-fuchsia-600 px-2 py-1 text-white">
              {bypassed.size} bypassed
            </span>
            <button
              type="button"
              onClick={onClearBypass}
              className="rounded-lg bg-surface-2 px-2 py-1 text-muted"
            >
              Clear
            </button>
          </>
        ) : (
          <span className="text-muted">
            {steps.length} {steps.length === 1 ? 'step' : 'steps'}, left to right. Tap a node to see
            its values.
          </span>
        )}
      </div>
      {problem && (
        <p className="rounded-lg bg-surface-2 px-3 py-2 text-xs text-warn" role="status">
          {problem}
        </p>
      )}

      {/*
        Sideways on its own. The sheet scrolls up and down and refuses to move
        sideways (see `Sheet`); this row is its own scroller, so a swipe across
        it moves along the steps without dragging the sheet.
      */}
      <div
        className="-mx-4 flex snap-x snap-mandatory scroll-px-4 items-start gap-3 overflow-x-auto overscroll-x-contain px-4 pb-3"
        style={{ touchAction: 'pan-x pan-y' }}
        data-testid="workflow-steps"
      >
        {steps.map((step, index) => (
          <section
            key={index}
            aria-label={`Step ${index + 1}`}
            className="w-[min(80vw,19rem)] shrink-0 snap-start space-y-2"
          >
            <h3 className="flex items-baseline justify-between border-b border-line pb-1 text-xs font-medium tracking-wide text-muted uppercase">
              <span>
                Step {index + 1}
                <span className="text-muted/60"> / {steps.length}</span>
              </span>
              {index < steps.length - 1 && <span aria-hidden>→</span>}
            </h3>
            {step.map((node) => (
              <StepCard
                key={node.id}
                node={node}
                first={index === 0}
                bypassed={bypassed.has(node.id)}
                expanded={open.has(node.id)}
                related={related.has(node.id)}
                onExpand={() => toggleOpen(node.id)}
                onToggleBypass={() => onToggleBypass(node.id)}
              />
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}

function StepCard({
  node,
  first,
  bypassed,
  expanded,
  related,
  onExpand,
  onToggleBypass,
}: {
  node: StepNode;
  first: boolean;
  bypassed: boolean;
  expanded: boolean;
  related: boolean;
  onExpand: () => void;
  onToggleBypass: () => void;
}) {
  const from = [...new Set(node.inputs.flatMap((input) => (input.from ? [input.from.title] : [])))];

  return (
    <article
      aria-label={node.title}
      data-node={node.id}
      className={cn(
        'rounded-xl border transition-colors',
        bypassed ? 'border-fuchsia-500/60 bg-fuchsia-500/10' : 'border-line bg-surface-2',
        related && 'ring-1 ring-accent',
      )}
    >
      <div className="flex items-start gap-2 p-2.5">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={onExpand}
          className="min-w-0 flex-1 text-left"
        >
          <span
            className={cn(
              'block truncate text-sm font-medium',
              bypassed && 'text-fuchsia-200 line-through',
            )}
          >
            {node.title}
          </span>
          <span className="block truncate text-[11px] text-muted">
            {from.length > 0 ? `from ${from.join(', ')}` : first ? 'starts here' : 'reads nothing'}
          </span>
        </button>
        <button
          type="button"
          aria-pressed={bypassed}
          onClick={onToggleBypass}
          className={cn(
            'shrink-0 rounded-lg px-2.5 py-1.5 text-xs font-medium',
            bypassed ? 'bg-fuchsia-600 text-white' : 'bg-surface-3 text-muted',
          )}
        >
          {/* One word either way: the background says which. */}
          Bypass
        </button>
      </div>

      {expanded && (
        <div className="space-y-2.5 border-t border-line px-2.5 pt-2 pb-2.5 text-xs">
          <p className="text-[11px] text-muted">
            {node.classType} · #{node.id}
            {!node.known && ' · not described by ComfyUI'}
          </p>

          {node.inputs.length > 0 && (
            <dl className="space-y-1">
              {node.inputs.map((input) => (
                <div key={input.name} className="flex gap-2">
                  <dt className="shrink-0 text-muted">{input.name}</dt>
                  <dd className="min-w-0 flex-1 truncate text-right">
                    {input.from ? (
                      <>
                        ← {input.from.title}
                        <span className="text-muted"> · {input.from.output}</span>
                      </>
                    ) : (
                      <span className="text-muted">not connected</span>
                    )}
                  </dd>
                </div>
              ))}
            </dl>
          )}

          {node.values.length > 0 && (
            <dl className="space-y-1">
              {node.values.map((entry) => (
                <div key={entry.name} className="flex gap-2">
                  <dt className="shrink-0 text-muted">{entry.name}</dt>
                  {/* Whole, wrapped, and scrolled if it is a page of prompt. */}
                  <dd className="max-h-32 min-w-0 flex-1 overflow-y-auto text-right break-words whitespace-pre-wrap">
                    {entry.value === '' ? <span className="text-muted">empty</span> : entry.value}
                  </dd>
                </div>
              ))}
            </dl>
          )}

          {node.feeds.length > 0 && (
            <p className="text-muted">→ {node.feeds.map((target) => target.title).join(', ')}</p>
          )}
        </div>
      )}
    </article>
  );
}
