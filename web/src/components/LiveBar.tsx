import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import type { GenerationRecord, JobStats, LiveJob } from '@latent/shared';

import { api, thumbnailUrl } from '../api/client';
import { formatSeconds, formatStepRate } from '../lib/format';
import { useTicker } from '../lib/useTicker';
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
export function LiveBar({ inline = false }: { inline?: boolean } = {}) {
  const job = useLiveStore((state) => state.live.job);
  const liveAt = useLiveStore((state) => state.liveAt);
  const finished = useLiveStore((state) => state.finished);
  const queueRemaining = useLiveStore((state) => state.live.queueRemaining);
  const previewUrl = useLiveStore((state) => state.previewUrl);
  const dismissFinished = useLiveStore((state) => state.dismissFinished);

  const [expanded, setExpanded] = useState(false);
  const [showStats, setShowStats] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  // Only ticks while something is running, so an idle app repaints never.
  const now = useTicker(Boolean(job));

  /*
   * The result opens by itself only if you were already watching.
   *
   * `expanded` is one flag across both states of this bar, so a progress sheet
   * left open simply becomes the result sheet when the job ends — which is the
   * whole of the rule. Opening it regardless was the old behaviour, and it was
   * wrong for the commonest case there is: you queue something, then carry on
   * typing the next prompt, and a sheet lands over the keyboard for a picture
   * you were not waiting to look at. Collapsed, the bar still shows the
   * thumbnail and says Done, one tap from the same sheet.
   */

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
        inline={inline}
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

  const elapsed = job.stats.elapsedMs + sinceUpdate(now, liveAt);
  const eta = remainingEta(job.stats, now, liveAt);

  /*
   * While the next item of a batch warms up there is nothing to show — no
   * preview frame yet, and the result that just landed has been superseded as
   * "current". Holding the last picture until the new one has something of its
   * own is the difference between watching a batch and watching an empty box.
   */
  const lastImage = finished?.images[0];
  const holdover = !previewUrl && lastImage ? thumbnailUrl(lastImage) : null;

  /*
   * The full detail, shared by both shapes. Whichever bar you tapped, the same
   * preview, progress and statistics open — the inline form is a summary of
   * this, not a cut-down version of it.
   */
  const sheet = (
      <Sheet open={expanded} onClose={() => setExpanded(false)} title="Generating">
        <div className="space-y-4">
          <div className="overflow-hidden rounded-2xl border border-line bg-surface-2">
            {previewUrl ? (
              <img src={previewUrl} alt="Live preview" className="w-full object-contain" />
            ) : holdover ? (
              <img src={holdover} alt="The previous result" className="w-full object-contain" />
            ) : (
              <div className="grid aspect-square place-items-center text-sm text-muted">
                Waiting for the first preview…
              </div>
            )}
          </div>
          {!previewUrl && holdover && (
            <p className="-mt-2 text-center text-[11px] text-muted">
              The run before this one — the new preview replaces it.
            </p>
          )}

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

          <JobStatsPanel job={job} now={now} liveAt={liveAt} queueRemaining={queueRemaining} />

          <Button variant="danger" size="lg" busy={cancelling} onClick={cancel}>
            Cancel this run
          </Button>
        </div>
      </Sheet>
  );

  /*
   * Inline: the Generate screen puts this in the same row as its button, so the
   * two together cost one row instead of two. Everything the full bar carries is
   * still a tap away in the sheet — this is a summary, not a reduced feature.
   */
  if (inline) {
    return (
      <>
        <button
          type="button"
          onClick={() => setExpanded(true)}
          aria-label="Generation progress"
          className="flex min-w-0 flex-1 flex-col justify-center gap-1 rounded-xl border border-line bg-surface px-2.5 py-1.5 text-left"
        >
          <p className="truncate text-[11px] tabular-nums text-muted">
            {Math.round(fraction * 100)}%
            {eta !== null && ` · ${formatSeconds(eta)} left`}
            {job.progressMax > 0 && ` · ${job.progress}/${job.progressMax}`}
            {queueRemaining > 1 && ` · ${queueRemaining - 1} queued`}
          </p>
          <span className="block h-1 overflow-hidden rounded-full bg-surface-3">
            <span
              className="block h-full rounded-full bg-accent transition-[width] duration-150"
              style={{ width: `${Math.min(100, Math.max(2, fraction * 100))}%` }}
            />
          </span>
        </button>

        {sheet}
      </>
    );
  }

  return (
    <>
      <div className="border-t border-line bg-surface/95 backdrop-blur">
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="block w-full px-4 py-2 text-left"
        >
          <div className="flex items-center gap-3">
            <div className="size-9 shrink-0 overflow-hidden rounded-lg bg-surface-2">
              {previewUrl ?? holdover ? (
                <img src={previewUrl ?? (holdover as string)} alt="" className="size-full object-cover" />
              ) : (
                <div className="grid size-full animate-pulse place-items-center text-xs opacity-40">
                  ●
                </div>
              )}
            </div>

            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{job.title}</p>
              {/*
                The line people actually watch. ETA first because it answers the
                only question being asked, then the rate, then where in the graph
                we are — and all of it on one line, because this bar sits above
                the tab bar and cannot afford a second.
              */}
              <p className="truncate text-xs tabular-nums text-muted">
                {eta !== null ? `${formatSeconds(eta)} left` : (job.nodeTitle ?? 'Starting…')}
                {job.progressMax > 0 && ` · ${job.progress}/${job.progressMax}`}
                {job.stats.msPerStep !== null && ` · ${formatStepRate(job.stats.msPerStep)}`}
                {queueRemaining > 1 && ` · ${queueRemaining - 1} queued`}
              </p>
            </div>

            <span className="shrink-0 text-xs tabular-nums text-muted">
              {Math.round(fraction * 100)}%
            </span>
          </div>

          <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-surface-3">
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-150"
              style={{ width: `${Math.min(100, Math.max(2, fraction * 100))}%` }}
            />
          </div>
        </button>

        {/*
          Detail stays collapsed by default and, unlike the sheet, does not cover
          the screen — so you can leave it open and keep using the app.
        */}
        <button
          type="button"
          onClick={() => setShowStats((current) => !current)}
          aria-expanded={showStats}
          className="flex w-full items-center justify-between px-4 pb-1.5 text-[11px] text-muted"
        >
          <span>{formatSeconds(elapsed)} elapsed</span>
          <span className="text-accent">{showStats ? 'Hide stats' : 'Stats'}</span>
        </button>

        {showStats && (
          <div className="px-4 pb-2">
            <JobStatsPanel job={job} now={now} liveAt={liveAt} queueRemaining={queueRemaining} />
          </div>
        )}
      </div>

      {sheet}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Statistics                                                          */
/* ------------------------------------------------------------------ */

/**
 * How long ago this client received the current state, by its own clock.
 *
 * Never the server's timestamps: on a rented box the clock is routinely minutes
 * off, and subtracting one clock from another would produce an ETA in the past.
 */
function sinceUpdate(now: number, liveAt: number): number {
  if (now === 0 || liveAt === 0) return 0;
  return Math.max(0, now - liveAt);
}

/** The server's ETA, counted down by however long ago it arrived. */
function remainingEta(stats: JobStats, now: number, liveAt: number): number | null {
  if (stats.etaMs === null) return null;
  return Math.max(0, stats.etaMs - sinceUpdate(now, liveAt));
}

function JobStatsPanel({
  job,
  now,
  liveAt,
  queueRemaining,
}: {
  job: LiveJob;
  now: number;
  liveAt: number;
  queueRemaining: number;
}) {
  const { stats } = job;
  const drift = sinceUpdate(now, liveAt);
  const eta = remainingEta(stats, now, liveAt);
  const done = stats.stepsRemaining > 0 ? job.progressMax - stats.stepsRemaining : job.progress;

  /*
   * The whole queue's estimate, not just this job's.
   *
   * Assumes the jobs behind this one take as long as the last completed run,
   * which is right when you have queued eight of the same thing — the case where
   * you actually want the number. Omitted entirely when there is nothing to base
   * it on, rather than guessed.
   */
  const queueEta =
    queueRemaining > 1 && stats.lastRunMs !== null && eta !== null
      ? eta + (queueRemaining - 1) * stats.lastRunMs
      : null;

  // One formatter for every duration here. Mixing `0s` with `0.39s` in adjacent
  // rows made the panel look broken when it was merely inconsistent.
  const rows: [string, string][] = [
    ['Elapsed', formatSeconds(stats.elapsedMs + drift)],
    ['Remaining', eta !== null ? formatSeconds(eta) : 'measuring…'],
    ['Per step', stats.msPerStep !== null ? formatStepRate(stats.msPerStep) : 'measuring…'],
    ['Steps', job.progressMax > 0 ? `${done} of ${job.progressMax}` : 'not sampling yet'],
    ['Node', job.nodeTitle ?? 'starting'],
    ['In this node', formatSeconds(stats.nodeElapsedMs + drift)],
    [
      // "Nodes done", not "Graph": `0 of 7` under a heading of "Graph" reads as
      // "nothing is happening" when in fact the first node is mid-sample.
      'Nodes done',
      stats.nodesTotal > 0
        ? `${stats.nodesDone} of ${stats.nodesTotal}`
        : `${Math.round(job.graphProgress * 100)}%`,
    ],
  ];

  if (queueEta !== null) rows.push(['Queue done in', formatSeconds(queueEta)]);
  if (stats.lastRunMs !== null) rows.push(['Last run took', formatSeconds(stats.lastRunMs)]);

  return (
    <dl
      data-testid="job-stats"
      className="grid grid-cols-2 gap-x-3 gap-y-1 rounded-lg bg-surface-2 px-3 py-2 text-[11px]"
    >
      {rows.map(([label, value]) => (
        <div key={label} className="flex items-baseline justify-between gap-2">
          <dt className="text-muted">{label}</dt>
          <dd className="truncate tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/* ------------------------------------------------------------------ */
/* The finished result                                                 */
/* ------------------------------------------------------------------ */

function ResultBar({
  record,
  inline,
  expanded,
  onExpand,
  onDismiss,
}: {
  record: GenerationRecord;
  /** In the Generate screen's button row rather than across the screen. */
  inline: boolean;
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

  /*
   * Labelled by what it does, not by what it contains.
   *
   * Read off its contents the name came out as "Done <title> View" — which
   * announces a state where a button should announce an action, and collides
   * with the Done that closes every sheet in the app.
   */
  const label = failed ? 'Show what went wrong' : 'Show the finished picture';

  const thumbnail = image ? (
    <img src={thumbnailUrl(image)} alt="" className="size-full object-cover" />
  ) : (
    <div className="grid size-full place-items-center text-sm">{failed ? '!' : '✓'}</div>
  );

  /*
   * Two shapes, the same as the progress bar has.
   *
   * The Generate screen puts this in the row with its button, and a bar that is
   * `w-full` in a flex row with a full-width button leaves the button a sliver
   * — which is exactly what it did, because this one shape was used in both
   * places and the case never came up while the sheet opened over it.
   */
  const bar = inline ? (
    <button
      type="button"
      onClick={onExpand}
      aria-label={label}
      className={cn(
        'flex min-w-0 flex-1 items-center gap-2 rounded-xl border px-2 py-1.5 text-left',
        failed ? 'border-danger/40 bg-danger/10' : 'border-line bg-surface',
      )}
    >
      <span className="size-8 shrink-0 overflow-hidden rounded-md bg-surface-2">{thumbnail}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[11px] font-medium">
          {failed ? 'Failed' : 'Done'}
        </span>
        <span className="block truncate text-[11px] text-muted">{record.title}</span>
      </span>
    </button>
  ) : (
    <button
      type="button"
      onClick={onExpand}
      aria-label={label}
      className={cn(
        'block w-full border-t px-4 py-2.5 text-left backdrop-blur',
        failed ? 'border-danger/40 bg-danger/10' : 'border-line bg-surface/95',
      )}
    >
      <div className="flex items-center gap-3">
        <div className="size-10 shrink-0 overflow-hidden rounded-lg bg-surface-2">{thumbnail}</div>

        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{failed ? 'Generation failed' : 'Done'}</p>
          <p className="truncate text-xs text-muted">{record.title}</p>
        </div>

        <span className="shrink-0 text-xs text-accent">View</span>
      </div>
    </button>
  );

  return (
    <>
      {bar}

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
              {/* A preview, not the original: this sheet appears on its own
                  after every render, and a 4000×4000 picture behind it is
                  64 MB of bitmap for something the size of a phone screen. */}
              <img src={thumbnailUrl(image)} alt={record.title} className="w-full object-contain" />
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
