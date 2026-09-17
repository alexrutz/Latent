import { useMemo, useState } from 'react';

import { api } from '../api/client';
import { useGallery } from '../api/queries';
import { formatClock } from '../lib/format';
import { useTicker } from '../lib/useTicker';
import { useGridSettings } from '../state/grid';
import { useLiveStore } from '../state/live';
import { Still, Thumb, type ViewerEntry } from './ImageViewer';
import { remainingEta, sinceUpdate } from './LiveBar';
import { ViewerWithActions } from './ViewerWithActions';
import { cn, Spinner } from './ui';

/**
 * The other half of the Generate screen, once there is room for one.
 *
 * On a phone the loop this app is built around is spread across three screens:
 * you write a prompt here, the picture lands in a bar you tap, that opens a
 * viewer over everything, and getting back to the prompt to change one word
 * means closing both. Every step of it is a screen change, and the thing you
 * are comparing against — what the last attempt actually looked like — is never
 * on screen at the same time as the words that produced it.
 *
 * A tablet has room for both at once, and that is the whole of this pane: the
 * render, big, beside the form that made it. Nothing here is new
 * functionality — it is the live bar's preview, the result, and the gallery
 * filtered to this workflow — but having them in view while you type is the
 * difference between iterating and navigating.
 */
export function GenerateWorkbench({ workflowId }: { workflowId: string | null }) {
  const job = useLiveStore((state) => state.live.job);
  const liveAt = useLiveStore((state) => state.liveAt);
  const previewUrl = useLiveStore((state) => state.previewUrl);
  const finished = useLiveStore((state) => state.finished);
  const [settings, updateSettings] = useGridSettings();
  const [viewing, setViewing] = useState<number | null>(null);
  const [cancelling, setCancelling] = useState(false);

  // Only ticks while something is running, so an idle screen repaints never.
  const now = useTicker(Boolean(job));

  /*
   * This workflow's recent output, newest first, one entry per picture.
   *
   * Filtered to the workflow the form is on rather than showing everything: the
   * pane is about what *this* graph has been producing, which is the comparison
   * you are making while you change its settings. The gallery tab is where you
   * go to see the lot.
   */
  const gallery = useGallery({ workflowId });
  const entries = useMemo<ViewerEntry[]>(() => {
    const pages = gallery.data?.pages ?? [];
    return pages
      .flatMap((page) => page.items)
      .flatMap((record) => record.images.map((image) => ({ record, image })));
  }, [gallery.data]);

  /*
   * What the stage shows, in order of how recent it is.
   *
   * The live frame first — a run in progress is the thing you are watching —
   * then the run that has just finished, then the last one in the gallery. The
   * last of those is what makes the pane useful on a cold start: opening
   * Generate in the morning shows you where you left off rather than an empty
   * box with the word "nothing" in it.
   */
  const done = finished?.images[0];
  const latest = entries[0];
  const stageEntry: ViewerEntry | null = finished && done
    ? { record: finished, image: done }
    : (latest ?? null);

  const cancel = async () => {
    setCancelling(true);
    try {
      await api.interrupt();
    } finally {
      setCancelling(false);
    }
  };

  return (
    <div
      data-testid="workbench"
      className="safe-t flex min-h-0 min-w-0 flex-1 flex-col gap-3 border-l border-line bg-surface/30 p-3"
    >
      <Stage
        previewUrl={previewUrl}
        entry={stageEntry}
        // While a run is going, the picture underneath is the one before it —
        // said out loud, because a preview and a finished render look alike
        // enough that a stale one is genuinely mistakable for the new one.
        stale={Boolean(job) && !previewUrl}
        onOpen={
          stageEntry
            ? () => {
                const index = entries.findIndex(
                  (entry) =>
                    entry.record.id === stageEntry.record.id &&
                    entry.image.filename === stageEntry.image.filename,
                );
                setViewing(index >= 0 ? index : 0);
              }
            : undefined
        }
      />

      {job && (
        <Progress
          title={job.title}
          nodeTitle={job.nodeTitle}
          /*
           * The sampler's steps once it is reporting them, and how much of the
           * graph is done before that — otherwise the bar sits at zero all the
           * way through loading a model, which reads as nothing happening.
           */
          fraction={job.progressMax > 0 ? job.progress / job.progressMax : job.graphProgress}
          elapsedMs={job.stats.elapsedMs + sinceUpdate(now, liveAt)}
          etaMs={remainingEta(job.stats, now, liveAt)}
          busy={cancelling}
          onCancel={() => void cancel()}
        />
      )}

      <Filmstrip
        entries={entries}
        loading={gallery.isLoading}
        onOpen={setViewing}
        currentId={stageEntry?.record.id ?? null}
      />

      {viewing !== null && entries[viewing] && (
        <ViewerWithActions
          entries={entries}
          index={viewing}
          grid={settings}
          onGridChange={updateSettings}
          onIndexChange={setViewing}
          onClose={() => setViewing(null)}
        />
      )}
    </div>
  );
}

/**
 * The big one.
 *
 * `object-contain` on a fixed box rather than a box that takes the picture's
 * shape: the pane's height is what the window gives it, and a stage that
 * resized itself to every result would move the filmstrip and the progress bar
 * up and down the screen between one render and the next.
 */
function Stage({
  previewUrl,
  entry,
  stale,
  onOpen,
}: {
  previewUrl: string | null;
  entry: ViewerEntry | null;
  stale: boolean;
  onOpen?: () => void;
}) {
  return (
    <div className="relative grid min-h-0 flex-1 place-items-center overflow-hidden rounded-2xl border border-line bg-surface-2/40">
      {previewUrl ? (
        <img
          src={previewUrl}
          alt="Live preview"
          className="max-h-full max-w-full object-contain"
        />
      ) : entry ? (
        <button
          type="button"
          onClick={onOpen}
          data-testid="workbench-still"
          aria-label={`Open ${entry.record.title}`}
          className="grid size-full place-items-center active:opacity-80"
        >
          <Still image={entry.image} alt={entry.record.title} fit="inside" className="size-full" />
        </button>
      ) : (
        <p className="px-6 text-center text-sm text-muted">
          Nothing rendered yet. What you generate lands here, beside the settings
          that made it.
        </p>
      )}

      {stale && entry && (
        <span className="pointer-events-none absolute top-2 left-2 rounded-lg bg-black/70 px-2 py-1 text-[11px] text-muted backdrop-blur">
          The run before this one
        </span>
      )}
    </div>
  );
}

/** What is happening, and the way to stop it. */
function Progress({
  title,
  nodeTitle,
  fraction,
  elapsedMs,
  etaMs,
  busy,
  onCancel,
}: {
  title: string;
  nodeTitle: string | null;
  fraction: number;
  elapsedMs: number;
  etaMs: number | null;
  busy: boolean;
  onCancel: () => void;
}) {
  return (
    <div className="shrink-0 space-y-1.5 rounded-xl border border-line bg-surface px-3 py-2">
      <div className="flex items-baseline gap-3">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{title}</span>
        <span className="shrink-0 text-xs text-muted tabular-nums">
          {formatClock(elapsedMs)}
          {etaMs !== null && ` · ${formatClock(etaMs)} left`}
        </span>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="shrink-0 text-xs text-danger disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-surface-3">
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-150"
          style={{ width: `${Math.min(100, Math.max(2, fraction * 100))}%` }}
        />
      </div>
      <p className="truncate text-[11px] text-muted">{nodeTitle ?? 'Starting…'}</p>
    </div>
  );
}

/**
 * The last few, in a row you can scroll sideways.
 *
 * Deliberately one row rather than a grid: this is context for what is on the
 * stage, not a second gallery, and a grid down here would compete with the
 * render for the height that makes the render worth having.
 */
function Filmstrip({
  entries,
  loading,
  currentId,
  onOpen,
}: {
  entries: ViewerEntry[];
  loading: boolean;
  currentId: string | null;
  onOpen: (index: number) => void;
}) {
  if (loading) {
    return (
      <div className="grid h-20 shrink-0 place-items-center">
        <Spinner className="size-4 text-muted" />
      </div>
    );
  }
  if (entries.length === 0) return null;

  return (
    <div className="no-scrollbar -mx-1 flex shrink-0 gap-2 overflow-x-auto px-1 pb-1">
      {entries.slice(0, 24).map((entry, index) => (
        <Tile
          key={`${entry.record.id}-${entry.image.filename}`}
          entry={entry}
          onOpen={() => onOpen(index)}
          current={entry.record.id === currentId}
        />
      ))}
    </div>
  );
}

function Tile({
  entry,
  current,
  onOpen,
}: {
  entry: ViewerEntry;
  current: boolean;
  onOpen: () => void;
}) {
  return (
    <Thumb
      image={entry.image}
      alt={entry.record.title}
      onClick={onOpen}
      className={cn(
        'size-20 shrink-0',
        // A ring rather than a border, so the row does not shift by two pixels
        // as the newest render takes over from the one before it.
        current && 'ring-2 ring-accent ring-inset',
      )}
    />
  );
}
