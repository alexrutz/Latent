import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { api } from '../api/client';
import { useGallery } from '../api/queries';
import { useDock } from '../state/dock';
import { useLiveStore } from '../state/live';
import { Thumb, type ViewerEntry } from './ImageViewer';
import { RunProgress } from './LiveBar';
import { ViewerWithActions } from './ViewerWithActions';
import { useGridSettings } from '../state/grid';
import { Button, cn, ErrorNote, Spinner } from './ui';

/**
 * The column that belongs to no screen.
 *
 * Everything this app does orbits one loop — queue something, watch it, look at
 * what came out — and on a phone that loop is three tabs. Which is right there:
 * a phone shows one thing, so the loop has to be walked. It is not right on a
 * desk, where the reason to have the width is that the thing you are *doing*
 * and the thing the machine is doing are different things, happening at once.
 *
 * So this is the second half of the answer to what a large screen is for. The
 * first half — the render beside the form — is `GenerateWorkbench`, and it is
 * about one screen having room for two panes. This is about the app having room
 * for something that is not the screen at all: read the model library, edit a
 * block, hold a conversation, and the run you started ten minutes ago is still
 * in front of you, still cancellable, with its output landing beside it.
 *
 * Nothing in here is new. It is the live bar's progress, the queue screen's
 * list and the gallery's newest, in a column — which is exactly the point.
 * A panel that invented a fourth way to show a queue would be a second thing to
 * keep true; every part of this reads the same store the tab it duplicates
 * does, so there is nothing to keep in step.
 */
export function Dock() {
  const open = useDock((state) => state.open);
  const toggle = useDock((state) => state.toggle);

  const job = useLiveStore((state) => state.live.job);
  const queue = useLiveStore((state) => state.queue);
  const pending = queue.pending;

  if (!open) {
    /*
     * Shut, it is a strip you can reopen, not nothing.
     *
     * A panel that vanishes entirely is a feature somebody turns off once and
     * never finds again — and it still has one thing worth saying while shut,
     * which is whether anything is running.
     */
    return (
      <div className="flex w-9 shrink-0 flex-col items-center gap-3 border-l border-line bg-surface/40 py-3">
        <button
          type="button"
          onClick={toggle}
          aria-label="Show the run panel"
          title="Show the run panel  ["
          className="grid size-7 place-items-center rounded-md text-muted active:bg-surface-2"
        >
          ‹
        </button>
        {(job || pending.length > 0) && (
          <span
            aria-hidden
            title={job ? 'Running' : `${pending.length} queued`}
            className={cn('size-2 rounded-full', job ? 'animate-pulse bg-accent' : 'bg-muted')}
          />
        )}
      </div>
    );
  }

  return (
    <aside
      data-testid="dock"
      aria-label="Run panel"
      className="safe-t flex w-[20rem] shrink-0 flex-col border-l border-line bg-surface/40"
    >
      <div className="flex h-12 shrink-0 items-center gap-2 px-3">
        <span className="flex-1 text-[13px] font-semibold tracking-[0.14em] text-muted uppercase">
          Bench
        </span>
        <button
          type="button"
          onClick={toggle}
          aria-label="Hide the run panel"
          title="Hide the run panel  ["
          className="grid size-7 place-items-center rounded-md text-muted active:bg-surface-2"
        >
          ›
        </button>
      </div>

      {/* One scrolling column: three sections that each grow with what is in
          them, rather than three panes fighting over a fixed height. */}
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-3 pb-4">
        <Now />
        <Queued />
        <Latest />
      </div>
    </aside>
  );
}

/** A section heading, with whatever the section wants to say beside it. */
function Head({ title, aside }: { title: string; aside?: React.ReactNode }) {
  return (
    <div className="mb-1.5 flex items-baseline justify-between gap-2">
      <h2 className="text-[11px] font-medium tracking-wide text-muted uppercase">{title}</h2>
      {aside}
    </div>
  );
}

/**
 * What the machine is doing, if anything.
 *
 * The same `RunProgress` the chat's cards use rather than a second progress
 * bar — the preview frame, the node, the ETA and the step rate are all already
 * arriving over the socket for it, and a panel with its own copy of that
 * arithmetic would be a second thing to get right.
 */
function Now() {
  const job = useLiveStore((state) => state.live.job);
  const [cancelling, setCancelling] = useState(false);

  return (
    <section>
      <Head title="Now" />
      {job ? (
        <div className="space-y-1.5">
          {/* Whatever is running — including a run started from ComfyUI's own
              editor, which has no Latent generation to name. */}
          <RunProgress />
          <Button
            variant="ghost"
            size="sm"
            className="w-full"
            busy={cancelling}
            onClick={async () => {
              setCancelling(true);
              try {
                await api.interrupt();
              } finally {
                setCancelling(false);
              }
            }}
          >
            Stop
          </Button>
        </div>
      ) : (
        <p className="rounded-xl border border-dashed border-line px-3 py-3 text-center text-xs text-muted">
          Nothing running.
        </p>
      )}
    </section>
  );
}

/**
 * What is waiting, and the one action worth having here.
 *
 * Titles only. The queue tab exists for "which of these do I not want", which
 * is a comparison and needs the parameters; this is for "how much is in front
 * of the thing I just started", which is a count and a list of names. Clearing
 * is the exception because it is the answer people actually want at a glance —
 * you queued eight by mistake and want them gone without leaving the screen.
 */
function Queued() {
  const pending = useLiveStore((state) => state.queue.pending);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (pending.length === 0) return null;

  return (
    <section>
      <Head
        title="Queued"
        aside={
          <button
            type="button"
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await api.clearQueue();
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : 'That did not work');
              } finally {
                setBusy(false);
              }
            }}
            className="text-[11px] text-muted underline decoration-dotted active:text-danger"
          >
            {busy ? 'Clearing…' : `Clear ${pending.length}`}
          </button>
        }
      />
      <ErrorNote>{error}</ErrorNote>
      <ul className="space-y-1">
        {pending.slice(0, 8).map((entry) => (
          <li
            key={entry.promptId}
            className="flex items-baseline gap-2 rounded-lg bg-surface-2/60 px-2.5 py-1.5"
          >
            <span className="min-w-0 flex-1 truncate text-xs">{entry.title || 'Untitled'}</span>
            <span className="shrink-0 truncate text-[10px] text-muted">{entry.workflowName}</span>
          </li>
        ))}
      </ul>
      {pending.length > 8 && (
        <p className="mt-1 text-center text-[11px] text-muted">and {pending.length - 8} more</p>
      )}
    </section>
  );
}

/**
 * What came out, newest first, across every workflow.
 *
 * Across every workflow deliberately — the Generate pane beside the form is
 * already filtered to the graph you are editing, and this is the other
 * question: what has this machine made lately, whatever made it. Three columns,
 * because that is the width at which a thumbnail is still a picture rather than
 * a swatch.
 *
 * It opens the gallery's own viewer rather than a preview of its own, so a
 * picture found here can be rated, favourited and reused exactly as one found
 * in the gallery can. A panel that showed pictures you could only look at would
 * be a decoration.
 */
function Latest() {
  const gallery = useGallery({});
  const navigate = useNavigate();
  const [grid, updateGrid] = useGridSettings();
  const [viewing, setViewing] = useState<number | null>(null);

  const entries = useMemo<ViewerEntry[]>(() => {
    const pages = gallery.data?.pages ?? [];
    return pages
      .flatMap((page) => page.items)
      .flatMap((record) => record.images.map((image) => ({ record, image })))
      .slice(0, 12);
  }, [gallery.data]);

  return (
    <section>
      <Head
        title="Latest"
        aside={
          <button
            type="button"
            onClick={() => navigate('/gallery')}
            className="text-[11px] text-muted underline decoration-dotted"
          >
            All
          </button>
        }
      />

      {gallery.isPending ? (
        <div className="grid place-items-center py-6">
          <Spinner className="size-5 text-muted" />
        </div>
      ) : entries.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line px-3 py-3 text-center text-xs text-muted">
          Nothing made yet.
        </p>
      ) : (
        <div data-testid="dock-latest" className="grid grid-cols-3 gap-1">
          {entries.map((entry, index) => (
            <Thumb
              key={`${entry.record.id}-${entry.image.filename}`}
              image={entry.image}
              alt={entry.record.title}
              onClick={() => setViewing(index)}
              className="aspect-square w-full"
            />
          ))}
        </div>
      )}

      {viewing !== null && entries[viewing] && (
        <ViewerWithActions
          entries={entries}
          index={viewing}
          grid={grid}
          onGridChange={updateGrid}
          onIndexChange={setViewing}
          onClose={() => setViewing(null)}
        />
      )}
    </section>
  );
}
