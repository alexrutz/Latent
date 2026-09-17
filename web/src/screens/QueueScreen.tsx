import { useState } from 'react';

import { primaryParams } from '@latent/shared';
import type { QueueEntry } from '@latent/shared';

import { api } from '../api/client';
import { Toggle } from '../components/ParamControl';
import { Button, Card, cn, EmptyState, ErrorNote, Spinner } from '../components/ui';
import { formatSeconds, formatStepRate } from '../lib/format';
import { useLiveStore } from '../state/live';

export function QueueScreen() {
  const queue = useLiveStore((state) => state.queue);
  const job = useLiveStore((state) => state.live.job);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * One switch for the whole list, not a chevron per card.
   *
   * You open this screen to answer "which of these do I not want?", and that is
   * a comparison — flipping every entry open at once is what makes the
   * differences line up, and eight separate taps is what makes it not work.
   */
  const [detailed, setDetailed] = useState(false);

  const run = async (label: string, action: () => Promise<unknown>) => {
    setBusy(label);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That did not work');
    } finally {
      setBusy(null);
    }
  };

  const total = queue.running.length + queue.pending.length;
  const anyParams = [...queue.running, ...queue.pending].some((entry) => entry.params.length > 0);

  return (
    <div className="readable safe-t space-y-3 px-4 pt-3 pb-6">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Queue</h1>
        {queue.pending.length > 0 && (
          <Button
            variant="danger"
            size="sm"
            busy={busy === 'clear'}
            onClick={() => void run('clear', api.clearQueue)}
          >
            Clear {queue.pending.length}
          </Button>
        )}
      </div>

      {anyParams && (
        <div className="flex items-center justify-between rounded-xl border border-line bg-surface px-3 py-2">
          <span className="text-sm">All settings</span>
          <Toggle
            checked={detailed}
            onChange={() => setDetailed((current) => !current)}
            label="All settings"
          />
        </div>
      )}

      <ErrorNote>{error}</ErrorNote>

      {total === 0 && (
        <EmptyState icon="≡" title="Nothing queued" hint="Jobs you start will appear here." />
      )}

      {queue.running.map((entry) => (
        <QueueCard
          key={entry.promptId}
          entry={entry}
          detailed={detailed}
          status={
            <span className="flex items-center gap-2 text-xs text-accent">
              <Spinner className="size-3" />
              Running
              {job?.stats.msPerStep != null && (
                <span className="tabular-nums text-muted">
                  {formatStepRate(job.stats.msPerStep)}
                </span>
              )}
              {job?.stats.etaMs != null && (
                <span className="tabular-nums text-muted">{formatSeconds(job.stats.etaMs)} left</span>
              )}
            </span>
          }
          action={
            <Button
              variant="danger"
              size="sm"
              busy={busy === entry.promptId}
              onClick={() => void run(entry.promptId, api.interrupt)}
            >
              Stop
            </Button>
          }
        />
      ))}

      {queue.pending.map((entry, position) => (
        <QueueCard
          key={entry.promptId}
          entry={entry}
          detailed={detailed}
          status={<span className="text-xs text-muted">#{position + 1} in line</span>}
          action={
            <Button
              variant="ghost"
              size="sm"
              busy={busy === entry.promptId}
              onClick={() => void run(entry.promptId, () => api.cancel(entry.promptId))}
            >
              Remove
            </Button>
          }
        />
      ))}

      {queue.pending.length > 1 && (
        // Worth saying out loud: people look for drag handles here and there is
        // nothing we can do about it from this side.
        <p className="px-1 text-center text-xs text-muted">
          ComfyUI runs jobs in the order they were queued. Its API has no way to reorder them.
        </p>
      )}
    </div>
  );
}

/**
 * One queued job, with enough of its settings to tell it apart from the others.
 *
 * The prompt alone is not enough: queueing the same prompt at three step counts
 * is the normal way to work, and picking the wrong one to cancel is the failure
 * this exists to prevent.
 */
function QueueCard({
  entry,
  detailed,
  status,
  action,
}: {
  entry: QueueEntry;
  detailed: boolean;
  status: React.ReactNode;
  action: React.ReactNode;
}) {
  const shown = detailed ? entry.params : primaryParams(entry.params);

  return (
    <Card
      data-testid="queue-card"
      data-prompt-id={entry.promptId}
      className={cn('space-y-2 p-3', entry.running && 'border-accent/40')}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          {status}
          {/* Two lines of prompt, not one: the tail is often the only difference. */}
          <p className="mt-0.5 line-clamp-2 text-sm font-medium">{entry.title}</p>
          <p className="truncate text-[11px] text-muted">{entry.workflowName}</p>
        </div>
        {action}
      </div>

      {shown.length > 0 && (
        <ul className="flex flex-wrap gap-1">
          {shown.map((item) => (
            <li
              key={item.key}
              className="flex max-w-full items-baseline gap-1 rounded-md bg-surface-2 px-1.5 py-0.5 text-[11px]"
            >
              <span className="shrink-0 text-muted">{item.label}</span>
              <span className="min-w-0 truncate tabular-nums">{item.value}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
