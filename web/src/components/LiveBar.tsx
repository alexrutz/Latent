import { useState } from 'react';

import { api } from '../api/client';
import { useLiveStore } from '../state/live';
import { Button, cn, Sheet } from './ui';

/**
 * The live job indicator, pinned just above the tab bar.
 *
 * It stays mounted across tabs on purpose: a phone user will queue a render and
 * immediately go looking at the gallery, and losing sight of progress at that
 * moment is what makes a web app feel like it forgot what it was doing.
 */
export function LiveBar() {
  const job = useLiveStore((state) => state.live.job);
  const queueRemaining = useLiveStore((state) => state.live.queueRemaining);
  const previewUrl = useLiveStore((state) => state.previewUrl);
  const [expanded, setExpanded] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  if (!job) return null;

  const stepFraction = job.progressMax > 0 ? job.progress / job.progressMax : 0;
  // Before the sampler reports anything, fall back to how much of the graph is
  // done — otherwise the bar sits at zero through model loading, which reads as
  // "nothing is happening".
  const fraction = job.progressMax > 0 ? stepFraction : job.graphProgress;

  const cancel = async () => {
    setCancelling(true);
    try {
      await api.interrupt();
    } finally {
      setCancelling(false);
      setExpanded(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="block w-full border-t border-line bg-surface/95 px-4 py-2.5 text-left backdrop-blur"
      >
        <div className="flex items-center gap-3">
          <div className="size-10 shrink-0 overflow-hidden rounded-lg bg-surface-2">
            {previewUrl ? (
              <img src={previewUrl} alt="" className="size-full object-cover" />
            ) : (
              <div className="grid size-full animate-pulse place-items-center text-xs opacity-40">
                ●
              </div>
            )}
          </div>

          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{job.title}</p>
            <p className="truncate text-xs text-muted">
              {job.nodeTitle ?? 'Starting…'}
              {job.progressMax > 0 && ` · ${job.progress}/${job.progressMax}`}
              {queueRemaining > 1 && ` · ${queueRemaining - 1} queued`}
            </p>
          </div>

          <span className="shrink-0 text-xs tabular-nums text-muted">
            {Math.round(fraction * 100)}%
          </span>
        </div>

        <div className="mt-2 h-1 overflow-hidden rounded-full bg-surface-3">
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-150"
            style={{ width: `${Math.min(100, Math.max(2, fraction * 100))}%` }}
          />
        </div>
      </button>

      <Sheet open={expanded} onClose={() => setExpanded(false)} title="Generating">
        <div className="space-y-4">
          <div className="overflow-hidden rounded-2xl border border-line bg-surface-2">
            {previewUrl ? (
              <img
                src={previewUrl}
                alt="Live preview"
                className="w-full object-contain"
                style={{ imageRendering: 'auto' }}
              />
            ) : (
              <div className="grid aspect-square place-items-center text-sm text-muted">
                Waiting for the first preview…
              </div>
            )}
          </div>

          <div>
            <p className="text-sm font-medium">{job.title}</p>
            <p className="text-xs text-muted">{job.nodeTitle ?? 'Starting…'}</p>
          </div>

          <div className="space-y-1">
            <div className="h-2 overflow-hidden rounded-full bg-surface-3">
              <div
                className={cn('h-full rounded-full bg-accent transition-[width] duration-150')}
                style={{ width: `${Math.min(100, Math.max(2, fraction * 100))}%` }}
              />
            </div>
            <div className="flex justify-between text-xs text-muted">
              <span>
                {job.progressMax > 0
                  ? `Step ${job.progress} of ${job.progressMax}`
                  : `${Math.round(job.graphProgress * 100)}% of the graph`}
              </span>
              {queueRemaining > 1 && <span>{queueRemaining - 1} more queued</span>}
            </div>
          </div>

          <Button variant="danger" size="lg" busy={cancelling} onClick={cancel}>
            Cancel this run
          </Button>
        </div>
      </Sheet>
    </>
  );
}
