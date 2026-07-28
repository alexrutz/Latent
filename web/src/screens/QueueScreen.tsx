import { useState } from 'react';

import { api } from '../api/client';
import { Button, Card, EmptyState, ErrorNote, Spinner } from '../components/ui';
import { useLiveStore } from '../state/live';

export function QueueScreen() {
  const queue = useLiveStore((state) => state.queue);
  const job = useLiveStore((state) => state.live.job);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <div className="safe-t space-y-4 px-4 pt-3 pb-6">
      <div className="flex items-center justify-between">
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

      <ErrorNote>{error}</ErrorNote>

      {total === 0 && (
        <EmptyState icon="≡" title="Nothing queued" hint="Jobs you start will appear here." />
      )}

      {queue.running.map((entry) => (
        <Card key={entry.promptId} className="border-accent/40">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="flex items-center gap-2 text-xs text-accent">
                <Spinner className="size-3" />
                Running
              </p>
              <p className="mt-1 truncate font-medium">{entry.title}</p>
              <p className="truncate text-xs text-muted">{entry.workflowName}</p>
              {job?.nodeTitle && <p className="mt-1 truncate text-xs text-muted">{job.nodeTitle}</p>}
            </div>
            <Button
              variant="danger"
              size="sm"
              busy={busy === entry.promptId}
              onClick={() => void run(entry.promptId, api.interrupt)}
            >
              Stop
            </Button>
          </div>
        </Card>
      ))}

      {queue.pending.map((entry, position) => (
        <Card key={entry.promptId}>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs text-muted">#{position + 1} in line</p>
              <p className="mt-1 truncate font-medium">{entry.title}</p>
              <p className="truncate text-xs text-muted">{entry.workflowName}</p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              busy={busy === entry.promptId}
              onClick={() => void run(entry.promptId, () => api.cancel(entry.promptId))}
            >
              Remove
            </Button>
          </div>
        </Card>
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
