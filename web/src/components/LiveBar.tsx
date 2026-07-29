import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import type { GenerationRecord } from '@latent/shared';

import { api, imageUrl, thumbnailUrl } from '../api/client';
import { useLiveStore } from '../state/live';
import { RatingStars } from './RatingStars';
import { Button, cn, ErrorNote, Sheet } from './ui';

/**
 * The live job indicator, pinned just above the tab bar.
 *
 * It stays mounted across tabs on purpose: a phone user will queue a render and
 * immediately go looking at the gallery, and losing sight of progress at that
 * moment is what makes a web app feel like it forgot what it was doing.
 *
 * It also survives the job *ending*. Unmounting on completion — which is what it
 * used to do — dumped the user back on the form at the exact instant the image
 * they had been waiting for became available.
 */
export function LiveBar() {
  const job = useLiveStore((state) => state.live.job);
  const finished = useLiveStore((state) => state.finished);
  const queueRemaining = useLiveStore((state) => state.live.queueRemaining);
  const previewUrl = useLiveStore((state) => state.previewUrl);
  const dismissFinished = useLiveStore((state) => state.dismissFinished);

  const [expanded, setExpanded] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  if (!job && !finished) return null;

  const cancel = async () => {
    setCancelling(true);
    try {
      await api.interrupt();
    } finally {
      setCancelling(false);
      setExpanded(false);
    }
  };

  const dismiss = () => {
    dismissFinished();
    setExpanded(false);
  };

  if (!job && finished) {
    return (
      <ResultBar
        record={finished}
        expanded={expanded}
        onExpand={() => setExpanded(true)}
        onDismiss={dismiss}
      />
    );
  }
  if (!job) return null;

  const stepFraction = job.progressMax > 0 ? job.progress / job.progressMax : 0;
  // Before the sampler reports anything, fall back to how much of the graph is
  // done — otherwise the bar sits at zero through model loading, which reads as
  // "nothing is happening".
  const fraction = job.progressMax > 0 ? stepFraction : job.graphProgress;

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
              <img src={previewUrl} alt="Live preview" className="w-full object-contain" />
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
                className="h-full rounded-full bg-accent transition-[width] duration-150"
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

/* ------------------------------------------------------------------ */
/* The finished result                                                 */
/* ------------------------------------------------------------------ */

function ResultBar({
  record,
  expanded,
  onExpand,
  onDismiss,
}: {
  record: GenerationRecord;
  expanded: boolean;
  onExpand: () => void;
  onDismiss: () => void;
}) {
  const navigate = useNavigate();
  const [rating, setRating] = useState(record.images[0]?.rating ?? 0);
  const [error, setError] = useState<string | null>(null);

  const image = record.images[0];
  const failed = record.status === 'failed';

  const rate = async (next: number) => {
    if (!image) return;
    setRating(next);
    setError(null);
    try {
      await api.rateImage(record.id, image, next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save that rating');
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={onExpand}
        className={cn(
          'block w-full border-t px-4 py-2.5 text-left backdrop-blur',
          failed ? 'border-danger/40 bg-danger/10' : 'border-line bg-surface/95',
        )}
      >
        <div className="flex items-center gap-3">
          <div className="size-10 shrink-0 overflow-hidden rounded-lg bg-surface-2">
            {image ? (
              <img src={thumbnailUrl(image)} alt="" className="size-full object-cover" />
            ) : (
              <div className="grid size-full place-items-center text-sm">{failed ? '!' : '✓'}</div>
            )}
          </div>

          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">
              {failed ? 'Generation failed' : 'Done'}
            </p>
            <p className="truncate text-xs text-muted">{record.title}</p>
          </div>

          <span className="shrink-0 text-xs text-accent">View</span>
        </div>
      </button>

      <Sheet
        open={expanded}
        onClose={onDismiss}
        title={failed ? 'Generation failed' : 'Result'}
      >
        <div className="space-y-4">
          {image ? (
            <button
              type="button"
              onClick={() => {
                onDismiss();
                navigate('/gallery');
              }}
              className="block w-full overflow-hidden rounded-2xl border border-line bg-surface-2"
            >
              <img src={imageUrl(image)} alt={record.title} className="w-full object-contain" />
            </button>
          ) : (
            <div className="rounded-2xl border border-line bg-surface-2 p-6 text-center text-sm text-muted">
              {record.error ?? 'No image was produced.'}
            </div>
          )}

          <div>
            <p className="text-sm">{record.title}</p>
            {record.error && <p className="mt-1 text-xs text-danger">{record.error}</p>}
          </div>

          {image && (
            <div className="flex items-center justify-between gap-3 rounded-xl border border-line bg-surface px-3 py-2.5">
              <div>
                <p className="text-sm">Rate it</p>
                <p className="text-xs text-muted">
                  {rating > 0 ? 'Saved to this device' : 'Rating keeps a local copy'}
                </p>
              </div>
              <RatingStars value={rating} onChange={rate} />
            </div>
          )}

          <ErrorNote>{error}</ErrorNote>

          <div className="flex gap-2">
            <Button
              variant="secondary"
              className="flex-1"
              onClick={() => {
                onDismiss();
                navigate('/gallery');
              }}
            >
              Open gallery
            </Button>
            <Button variant="ghost" onClick={onDismiss}>
              Dismiss
            </Button>
          </div>
        </div>
      </Sheet>
    </>
  );
}
