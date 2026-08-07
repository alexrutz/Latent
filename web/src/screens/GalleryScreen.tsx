import { forwardRef, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { textOutputLabel } from '@latent/shared';
import type {
  GallerySort,
  GenerationImage,
  GenerationRecord,
  GridSettings,
} from '@latent/shared';

import { api, imageUrl } from '../api/client';
import {
  useAddFavorite,
  useDeleteFavorite,
  useFavorites,
  useDeleteImage,
  useGallery,
  useKeepImage,
  useRateImage,
  reportImageDimensions,
  useSetTileSpan,
  useSettings,
  useWorkflows,
} from '../api/queries';
import { ImageViewer, Thumb, type ViewerEntry } from '../components/ImageViewer';
import {
  overlayValues,
  ParamOverlayLine,
  ParamOverlayPicker,
} from '../components/ParamOverlay';
import { RatingStars } from '../components/RatingStars';
import { ThumbGrid, useTileStyle } from '../components/ThumbGrid';
import { Toggle } from '../components/ParamControl';
import { cn, EmptyState, ErrorNote, Sheet, Spinner } from '../components/ui';
import { useBlur } from '../state/blur';
import { TILE_OPTIONS, useGridSettings } from '../state/grid';
import { useGalleryTargetStore } from '../state/galleryTarget';
import { usePendingStore } from '../state/pending';

/** A stable identity for one picture, unique across runs. */
function identify(entry: ViewerEntry | undefined): string | null {
  if (!entry) return null;
  return `${entry.record.id}/${entry.image.subfolder}/${entry.image.filename}`;
}

const COLLAPSED_KEY = 'latent.galleryCollapsed';

const SORTS: { value: GallerySort; label: string; hint: string }[] = [
  { value: 'newest', label: 'Newest first', hint: 'what you just made' },
  { value: 'oldest', label: 'Oldest first', hint: 'where a project started' },
  { value: 'rating', label: 'Best rated', hint: 'across every day at once' },
];

/** The local day a run belongs to, as a key that sorts and compares. */
function dayKey(at: number): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

/**
 * How that day reads.
 *
 * Today and yesterday by name, because those are the two you look for most and
 * a date tells you less than the word does. The year only when it is not this
 * one — otherwise every heading carries four digits nobody needed.
 */
function dayLabel(at: number): string {
  const date = new Date(at);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);

  if (dayKey(at) === dayKey(today.getTime())) return 'Today';
  if (dayKey(at) === dayKey(yesterday.getTime())) return 'Yesterday';

  return date.toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(date.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }),
  });
}

/** Sorting and the workflow filter, out of the way until asked for. */
function FilterSheet({
  open,
  onClose,
  sort,
  onSort,
  workflowId,
  onWorkflow,
}: {
  open: boolean;
  onClose: () => void;
  sort: GallerySort;
  onSort: (sort: GallerySort) => void;
  workflowId: string | null;
  onWorkflow: (id: string | null) => void;
}) {
  const workflows = useWorkflows();

  return (
    <Sheet open={open} onClose={onClose} title="Sort and filter">
      <div className="space-y-4">
        <div className="space-y-1">
          <p className="text-xs tracking-wide text-muted uppercase">Order</p>
          {SORTS.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={sort === option.value}
              onClick={() => onSort(option.value)}
              className={cn(
                'flex w-full flex-col items-start gap-0.5 rounded-lg px-3 py-2 text-left',
                sort === option.value ? 'bg-accent/15 text-accent' : 'bg-surface-2 active:bg-surface-3',
              )}
            >
              <span className="text-sm">{option.label}</span>
              <span className="text-[11px] text-muted">{option.hint}</span>
            </button>
          ))}
          {sort === 'rating' && (
            <p className="text-[11px] text-muted">
              Sorted by the best picture in each run, so a five-star image is not buried under the
              near-misses it came with. Days are not shown, because this order crosses them.
            </p>
          )}
        </div>

        <div className="space-y-1">
          <p className="text-xs tracking-wide text-muted uppercase">Workflow</p>
          <div className="flex flex-wrap gap-1">
            <button
              type="button"
              aria-pressed={workflowId === null}
              onClick={() => onWorkflow(null)}
              className={cn(
                'rounded-lg px-2.5 py-1.5 text-xs',
                workflowId === null ? 'bg-accent text-white' : 'bg-surface-2 text-muted',
              )}
            >
              All
            </button>
            {(workflows.data ?? []).map((workflow) => (
              <button
                key={workflow.id}
                type="button"
                aria-pressed={workflowId === workflow.id}
                onClick={() => onWorkflow(workflow.id)}
                className={cn(
                  'max-w-full truncate rounded-lg px-2.5 py-1.5 text-xs',
                  workflowId === workflow.id ? 'bg-accent text-white' : 'bg-surface-2 text-muted',
                )}
              >
                {workflow.name}
              </button>
            ))}
          </div>
        </div>
      </div>
    </Sheet>
  );
}

const FILTERS = [
  { label: 'All', minRating: 0 },
  { label: 'Rated', minRating: 1 },
  { label: '★ 4+', minRating: 4 },
] as const;

export function GalleryScreen() {
  const [minRating, setMinRating] = useState(0);
  const [sort, setSort] = useState<GallerySort>('newest');
  const [workflowId, setWorkflowId] = useState<string | null>(null);
  const [showFilters, setShowFilters] = useState(false);
  /**
   * Days folded shut, by their key.
   *
   * Kept on the device: which days you have finished with is a fact about this
   * screen and this phone, not about the pictures.
   */
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]') as string[]);
    } catch {
      return new Set();
    }
  });

  useEffect(() => {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]));
  }, [collapsed]);

  const gallery = useGallery({ minRating, sort, workflowId });
  /**
   * Which picture the viewer is showing, as `generation/filename`.
   *
   * Not a position: the list grows underneath while a queue drains, and a stored
   * index would then point at a different picture. Not the filename alone
   * either — two runs can in principle write the same name, and then every
   * lookup would find the first one.
   */
  const [selected, setSelected] = useState<string | null>(null);
  const [tileTarget, setTileTarget] = useState<
    { record: GenerationRecord; image: GenerationImage } | null
  >(null);
  const [settings, updateSettings] = useGridSettings();
  const [showLayout, setShowLayout] = useState(false);
  const blurred = useBlur((state) => state.blurred);
  const toggleBlur = useBlur((state) => state.toggle);
  const sentinel = useRef<HTMLDivElement>(null);
  const firstResult = useRef<HTMLDivElement>(null);
  const scrolledOnce = useRef(false);
  const setTileSpan = useSetTileSpan();
  const consumeTarget = useGalleryTargetStore((state) => state.consume);


  /*
   * Stable callbacks so the memoised tiles stay memoised. A fresh arrow per tile
   * per render defeats `memo` entirely, and with a few hundred tiles in a long
   * gallery that is the difference between a smooth scroll and a stuttering one.
   */
  const openTile = useCallback(
    (record: GenerationRecord, image: GenerationImage) => setSelected(identify({ record, image })),
    [],
  );
  const holdTile = useCallback(
    (record: GenerationRecord, image: GenerationImage) => setTileTarget({ record, image }),
    [],
  );

  const items = useMemo(
    () => gallery.data?.pages.flatMap((page) => page.items) ?? [],
    [gallery.data],
  );

  /*
   * Someone sent us here to look at one picture.
   *
   * Consumed once, and only once its run is actually in the loaded pages —
   * setting `selected` to something the list does not contain yet would open
   * the viewer on nothing. A favourite from months ago is far enough down that
   * the first page will not have it, which is why this waits rather than
   * giving up.
   */
  useEffect(() => {
    const target = useGalleryTargetStore.getState().target;
    if (!target) return;
    const found = items.some((item) => item.id === target.generationId);
    if (!found) {
      if (gallery.hasNextPage && !gallery.isFetchingNextPage) void gallery.fetchNextPage();
      return;
    }
    consumeTarget();
    setSelected(`${target.generationId}/${target.image.subfolder}/${target.image.filename}`);
    // Arriving at a specific picture is not the moment to be auto-scrolled to
    // the newest one.
    scrolledOnce.current = true;
  }, [items, gallery, consumeTarget]);

  /**
   * The list, cut into days.
   *
   * A month of heavy use is thousands of tiles, and "the ones from Tuesday"
   * was a minute of scrolling. Consecutive runs only — the list already
   * arrives in order, so this is a walk rather than a sort, and it stays
   * correct when the order is oldest-first.
   *
   * Only for the time orderings: sorting by rating deliberately mixes days,
   * and heading such a list with dates would be nonsense. That case is one
   * unnamed section, which the rendering below leaves undivided.
   */
  const sections = useMemo(() => {
    if (sort === 'rating') return [{ key: '', label: '', items }];
    const out: { key: string; label: string; items: GenerationRecord[] }[] = [];
    for (const record of items) {
      const key = dayKey(record.createdAt);
      const last = out[out.length - 1];
      if (last?.key === key) last.items.push(record);
      else out.push({ key, label: dayLabel(record.createdAt), items: [record] });
    }
    return out;
  }, [items, sort]);

  /*
   * Every picture the gallery is currently showing, flattened.
   *
   * This is what the viewer swipes through. A batch of four is not a meaningful
   * boundary when you are flicking through results, and stopping dead at the end
   * of one run made swiping feel broken.
   *
   * Folded days are left out on purpose: putting a day away and then swiping
   * back into it would make the fold a lie.
   */
  const entries = useMemo<ViewerEntry[]>(
    () =>
      sections
        .filter((section) => !collapsed.has(section.key))
        .flatMap((section) =>
          section.items.flatMap((record) =>
            record.images.map((image) => ({ record, image })),
          ),
        ),
    [sections, collapsed],
  );

  // Infinite scroll: load the next page as the end of the list comes into view.
  useEffect(() => {
    const element = sentinel.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && gallery.hasNextPage && !gallery.isFetchingNextPage) {
          void gallery.fetchNextPage();
        }
      },
      { rootMargin: '400px' },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [gallery]);

  /** Index of the first entry that actually has a picture in it. */
  const firstResultIndex = useMemo(
    () => items.findIndex((item) => item.images.length > 0),
    [items],
  );

  /*
   * The same run, by id.
   *
   * The tiles are rendered a day at a time now, so the position in the flat
   * list is not to hand — and looking it up per tile turns drawing the grid
   * into a quadratic walk of a list that runs to thousands.
   */
  const firstResultId = firstResultIndex < 0 ? null : (items[firstResultIndex]?.id ?? null);

  /*
   * Jump straight to the newest finished image.
   *
   * Queued and running jobs are the newest entries, so they sit at the top of
   * the list. With a long queue that means opening the gallery lands you on a
   * wall of spinners with the picture you actually wanted to see pushed far
   * below. Scroll past them once, on arrival.
   */
  useEffect(() => {
    // Once the user scrolls for themselves, this must never move the view again.
    if (scrolledOnce.current) return;
    if (firstResultIndex < 0) return; // nothing finished yet
    if (firstResultIndex === 0) return; // already at the top; nothing to skip

    const element = firstResult.current;
    if (!element) return;

    // `auto` rather than `smooth`: this is a jump to the right starting point,
    // not an animation the user asked for.
    element.scrollIntoView({ block: 'start', behavior: 'auto' });
    // Deliberately not latching here: while the queue is draining, placeholders
    // keep appearing above and would push the image back off screen. The effect
    // re-runs and re-anchors until the user takes over.
  }, [firstResultIndex, items.length]);

  /** Hand control back the moment the user scrolls themselves. */
  useEffect(() => {
    const container = firstResult.current?.closest('main') ?? null;
    if (!container) return;

    const surrender = () => {
      scrolledOnce.current = true;
    };
    // Only genuine input counts — a programmatic scrollIntoView fires `scroll`,
    // but never `wheel` or `touchstart`.
    container.addEventListener('wheel', surrender, { passive: true });
    container.addEventListener('touchstart', surrender, { passive: true });
    return () => {
      container.removeEventListener('wheel', surrender);
      container.removeEventListener('touchstart', surrender);
    };
  }, [items.length]);

  /*
   * Where the open picture sits in the flat list, recomputed each render.
   *
   * Derived rather than stored, so a generation finishing while the viewer is
   * open shifts the list under it without the viewer jumping to a different
   * picture.
   */
  const viewerIndex = selected
    ? entries.findIndex((candidate) => identify(candidate) === selected)
    : -1;

  const filterBar = (
    /*
      Pinned, not scrolled away with the first row of pictures. The blur and
      the filters are wanted *while* looking through a long gallery, which is
      exactly when the top of the page is thousands of pixels behind you.
    */
    <div className="sticky top-0 z-20 -mx-4 mb-3 flex items-center justify-between gap-2 bg-ink/95 px-4 py-2 backdrop-blur">
      <h1 className="text-xl font-semibold">Gallery</h1>
      <div className="flex items-center gap-2">
        <div className="flex gap-1 rounded-full bg-surface p-1">
          {FILTERS.map((filter) => (
            <button
              key={filter.label}
              type="button"
              onClick={() => setMinRating(filter.minRating)}
              className={cn(
                'rounded-full px-3 py-1.5 text-xs',
                minRating === filter.minRating ? 'bg-accent text-white' : 'text-muted',
              )}
            >
              {filter.label}
            </button>
          ))}
        </div>
        {/* Sorting and the workflow filter live behind one button: they are
            decisions you make occasionally, and three more chips across the
            top would leave no room for the pictures. */}
        <button
          type="button"
          onClick={() => setShowFilters(true)}
          aria-label="Sort and filter"
          className={cn(
            'flex h-7 shrink-0 items-center gap-1 rounded-full px-2 text-[11px] leading-none',
            sort !== 'newest' || workflowId ? 'bg-accent/20 text-accent' : 'bg-surface text-muted',
          )}
        >
          <span aria-hidden className="text-base leading-none">
            ⇅
          </span>
          <span aria-hidden className="opacity-60">
            ▾
          </span>
        </button>

        {/* Its own selection, separate from the viewer's: a thumbnail has room
            for two or three numbers, not eight. */}
        <ParamOverlayPicker
          label="Values on thumbnails"
          records={items}
          selected={settings.gridParams}
          withLabels={settings.overlayLabels}
          onChange={(gridParams) => updateSettings({ gridParams })}
          onWithLabelsChange={(overlayLabels) => updateSettings({ overlayLabels })}
        />
        {/* Reachable from where the pictures are, not only from Settings —
            the moment you want it is the moment somebody sits down next to
            you. */}
        <button
          type="button"
          onClick={toggleBlur}
          aria-label="Blur every image"
          aria-pressed={blurred}
          className={cn(
            'grid size-9 shrink-0 place-items-center rounded-full active:bg-surface-2',
            blurred ? 'bg-accent text-white' : 'bg-surface text-muted',
          )}
        >
          ◌
        </button>
        <button
          type="button"
          onClick={() => setShowLayout(true)}
          aria-label="Grid layout"
          className="grid size-9 shrink-0 place-items-center rounded-full bg-surface text-muted active:bg-surface-2"
        >
          ▦
        </button>
      </div>
    </div>
  );

  const layoutSheet = (
    <Sheet open={showLayout} onClose={() => setShowLayout(false)} title="Layout">
      <div className="space-y-5">
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm">Columns</span>
            <span className="text-sm tabular-nums text-muted">{settings.columns}</span>
          </div>
          <input
            type="range"
            min={1}
            max={5}
            step={1}
            value={settings.columns}
            onChange={(event) => updateSettings({ columns: Number(event.target.value) })}
            aria-label="Columns"
            className="h-11 w-full accent-[var(--color-accent)]"
          />
        </div>

        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm">Equal-sized tiles</p>
            <p className="mt-0.5 text-xs text-muted">
              Off by default: a tile takes its shape from the image, so a wide
              picture gets a wide tile and nothing is cropped to a square. Hold
              any thumbnail to set its size by hand.
            </p>
          </div>
          <Toggle
            checked={settings.uniformTiles}
            onChange={(uniformTiles) => updateSettings({ uniformTiles })}
          />
        </div>
      </div>
    </Sheet>
  );

  if (gallery.isLoading) {
    return (
      <div className="grid h-full place-items-center">
        <Spinner className="size-6 text-muted" />
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="safe-t px-4 pt-3">
        {filterBar}
        {layoutSheet}
        <EmptyState
          icon="▦"
          title={minRating > 0 ? 'Nothing rated yet' : 'Nothing generated yet'}
          hint={
            minRating > 0
              ? 'Rate a result and it is copied to this device, so it survives the ComfyUI instance being shut down.'
              : 'Results appear here as soon as a run finishes.'
          }
        />
      </div>
    );
  }

  return (
    <div className="safe-t px-4 pt-3 pb-6">
      {filterBar}

      {sections.map((section) => {
        const shut = collapsed.has(section.key);
        const pictures = section.items.reduce((total, item) => total + item.images.length, 0);

        return (
          <div key={section.key || 'all'}>
            {section.key !== '' && (
              /*
                The divider is the control.
                A separate chevron would be a second thing to aim at on a
                phone; the line between two days is already the boundary you
                are thinking about, so tapping it is what folds the day away.
              */
              <button
                type="button"
                data-testid="day-divider"
                onClick={() =>
                  setCollapsed((current) => {
                    const next = new Set(current);
                    if (next.has(section.key)) next.delete(section.key);
                    else next.add(section.key);
                    return next;
                  })
                }
                aria-expanded={!shut}
                aria-label={`${section.label}, ${pictures} pictures`}
                className="mt-2 mb-2 flex w-full items-center gap-2 text-left"
              >
                <span aria-hidden className="text-[10px] text-muted">
                  {shut ? '▸' : '▾'}
                </span>
                <span className="shrink-0 text-xs font-medium">{section.label}</span>
                <span className="shrink-0 text-[11px] text-muted tabular-nums">{pictures}</span>
                <span className="h-px min-w-0 flex-1 bg-line" />
              </button>
            )}

            {!shut && (
              <ThumbGrid columns={settings.columns}>
                {section.items.map((record) =>
                  record.images.length > 0 ? (
                    record.images.map((image, imageIndex) => (
                      <GalleryTile
                        key={`${record.id}-${image.filename}`}
                        ref={record.id === firstResultId && imageIndex === 0 ? firstResult : undefined}
                        record={record}
                        image={image}
                        index={imageIndex}
                        settings={settings}
                        onOpen={openTile}
                        onHold={holdTile}
                      />
                    ))
                  ) : (
                    <PlaceholderCard key={record.id} record={record} />
                  ),
                )}
              </ThumbGrid>
            )}
          </div>
        );
      })}

      <FilterSheet
        open={showFilters}
        onClose={() => setShowFilters(false)}
        sort={sort}
        onSort={setSort}
        workflowId={workflowId}
        onWorkflow={setWorkflowId}
      />

      <div ref={sentinel} className="h-8" />
      {gallery.isFetchingNextPage && (
        <div className="grid place-items-center py-4">
          <Spinner className="size-5 text-muted" />
        </div>
      )}

      {layoutSheet}

      <Sheet open={tileTarget !== null} onClose={() => setTileTarget(null)} title="Tile size">
        <div className="space-y-2">
          <p className="text-xs text-muted">
            How much of the grid this one image takes up. “Auto” follows its
            aspect ratio.
          </p>
          {TILE_OPTIONS.map((option) => {
            const current = tileTarget?.image.tileSpan ?? null;
            const active = option.span
              ? current?.cols === option.span.cols && current?.rows === option.span.rows
              : current === null;
            return (
              <button
                key={option.label}
                type="button"
                onClick={() => {
                  if (tileTarget) {
                    setTileSpan.mutate({
                      generationId: tileTarget.record.id,
                      image: tileTarget.image,
                      span: option.span,
                    });
                  }
                  setTileTarget(null);
                }}
                className={cn(
                  'flex w-full items-center justify-between rounded-xl px-4 py-3 text-left',
                  active ? 'bg-accent/15 text-accent' : 'active:bg-surface-2',
                )}
              >
                <span>{option.label}</span>
                {active && <span aria-hidden>✓</span>}
              </button>
            );
          })}
        </div>
      </Sheet>

      {viewerIndex >= 0 && (
        <ViewerWithActions
          entries={entries}
          index={viewerIndex}
          grid={settings}
          onGridChange={updateSettings}
          onIndexChange={(next) => setSelected(identify(entries[next]))}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

/**
 * One thumbnail, shaped by its aspect ratio and badged with its rating.
 *
 * Memoised, and it matters: a gallery is hundreds of these, and without it every
 * one re-rendered whenever anything on the screen changed.
 */
const GalleryTile = memo(
  forwardRef<
    HTMLDivElement,
    {
      record: GenerationRecord;
      image: GenerationImage;
      index: number;
      settings: GridSettings;
      onOpen: (record: GenerationRecord, image: GenerationImage, index: number) => void;
      onHold: (record: GenerationRecord, image: GenerationImage) => void;
    }
  >(function GalleryTile({ record, image, index, settings, onOpen, onHold }, ref) {
    const style = useTileStyle(image, settings);
    const overlay = useMemo(
      () => overlayValues(record, settings.gridParams),
      [record, settings.gridParams],
    );

    return (
      <div
        ref={ref}
        className="relative min-w-0"
        style={{
          ...style,
          /*
           * Skip layout and paint for tiles that are off screen. With a few
           * hundred thumbnails the browser is otherwise doing that work for the
           * entire list on every frame of a scroll.
           *
           * `contain-intrinsic-size` supplies a placeholder size so the
           * scrollbar stays honest and skipped tiles do not collapse.
           */
          contentVisibility: 'auto',
          containIntrinsicSize: 'auto 200px',
        }}
      >
        <Thumb
          image={image}
          alt={record.title}
          className="size-full"
          onClick={() => onOpen(record, image, index)}
          onLongPress={() => onHold(record, image)}
          onMeasured={(width, height) => reportImageDimensions(image, width, height)}
        />
        {image.rating > 0 && (
          <span
            title={
              image.archived
                ? 'Rated and stored on this device'
                : 'Rated, but not copied locally yet'
            }
            className="pointer-events-none absolute bottom-1 left-1 rounded-md bg-black/60 px-1.5 py-0.5 text-[10px] text-warn backdrop-blur"
          >
            {'★'.repeat(image.rating)}
            {!image.archived && <span className="ml-1 text-danger">!</span>}
          </span>
        )}
        {record.source === 'import' && (
          <span className="pointer-events-none absolute top-1 right-1 rounded-md bg-black/60 px-1.5 py-0.5 text-[10px] text-muted backdrop-blur">
            imported
          </span>
        )}

        {/*
          The chosen values, inside the thumbnail.
          The point is comparing a sweep without opening anything: eight results
          of a step ramp are eight numbers, and tapping into each to find them
          loses the comparison entirely.
        */}
        {overlay.length > 0 && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 to-transparent px-1 pt-3 pb-0.5">
            <ParamOverlayLine items={overlay} withLabels={settings.overlayLabels} compact />
          </div>
        )}
      </div>
    );
  }),
);

/**
 * A queued, running or failed generation that has no image to show yet.
 *
 * There is deliberately no "cancelled" state here: the server leaves a
 * cancelled run out of the gallery entirely unless it managed to produce an
 * image. Clearing a queue of eight used to leave eight tombstones at the top of
 * the gallery for pictures that were never made.
 */
function PlaceholderCard({ record }: { record: GenerationRecord }) {
  const failed = record.status === 'failed';

  return (
    <div
      className={cn(
        'grid aspect-square place-items-center rounded-xl border p-3 text-center',
        failed ? 'border-danger/30 bg-danger/5' : 'border-line bg-surface',
      )}
      title={record.error ?? undefined}
    >
      {failed ? (
        <div className="space-y-1">
          <p className="text-xs font-medium text-danger">Failed</p>
          <p className="line-clamp-3 text-[10px] text-muted">{record.error}</p>
        </div>
      ) : (
        <div className="space-y-2">
          <Spinner className="mx-auto size-5 text-muted" />
          <p className="text-[10px] text-muted">
            {record.status === 'running' ? 'Rendering' : 'Queued'}
          </p>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Viewer with the actions that make a result reusable                 */
/* ------------------------------------------------------------------ */

function ViewerWithActions({
  entries,
  index,
  grid,
  onGridChange,
  onIndexChange,
  onClose,
}: {
  entries: ViewerEntry[];
  index: number;
  /** Which parameters to draw over the picture, shared with the grid's own. */
  grid: GridSettings;
  onGridChange: (patch: Partial<GridSettings>) => void;
  onIndexChange: (index: number) => void;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const setPending = usePendingStore((state) => state.setPending);
  const workflows = useWorkflows();
  const settings = useSettings();
  const [showDetails, setShowDetails] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const rateImage = useRateImage();
  const keepImage = useKeepImage();
  const deleteImage = useDeleteImage();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const addFavorite = useAddFavorite();
  const removeFavorite = useDeleteFavorite();
  const favorites = useFavorites();

  // Swiping to the next picture must not leave a primed delete button behind.
  useEffect(() => setConfirmDelete(false), [index]);

  // Every hook above runs unconditionally; only then is it safe to bail. The
  // gallery only renders this once it has found the entry, so a miss means the
  // picture was deleted underneath us — closing is the right answer.
  const entry = entries[index];
  if (!entry) return null;

  const { record, image } = entry;
  const workflowExists = workflows.data?.some((item) => item.id === record.workflowId) ?? false;

  /*
   * Whether *this* image is already a favourite.
   *
   * Read from the stored list rather than tracked locally, so the button tells
   * the truth when the viewer is reopened — and so a second tap removes it
   * instead of silently saving a duplicate, which is what used to happen.
   */
  const existingFavorite = image
    ? (favorites.data?.find(
        (entry) =>
          entry.generationId === record.id &&
          entry.image?.filename === image.filename &&
          entry.image?.subfolder === image.subfolder,
      ) ?? null)
    : null;

  const favorite = async () => {
    if (!image) return;
    setError(null);
    try {
      if (existingFavorite) {
        await removeFavorite.mutateAsync(existingFavorite.id);
      } else {
        await addFavorite.mutateAsync({ generationId: record.id, image });
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save that favourite');
    }
  };

  const rate = async (rating: number) => {
    if (!image) return;
    setError(null);
    try {
      await rateImage.mutateAsync({ generationId: record.id, image, rating });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save that rating');
    }
  };

  const rerun = (freshSeed: boolean) => {
    if (!record.workflowId) return;
    setPending({ workflowId: record.workflowId, values: record.values, freshSeed });
    onClose();
    navigate('/');
  };

  /** Copy this result into ComfyUI's inputs, then open the target workflow. */
  const sendTo = async (target: 'img2img' | 'upscale') => {
    if (!image) return;
    const workflowId =
      target === 'upscale' ? settings.data?.upscaleWorkflowId : settings.data?.img2imgWorkflowId;

    if (!workflowId) {
      setError(
        `No ${target} workflow chosen yet. Pick one in Settings so this button knows where to send the image.`,
      );
      return;
    }

    setBusy(target);
    setError(null);
    try {
      const uploaded = await api.toInput(image);
      setPending({
        workflowId,
        imageFilename: uploaded.subfolder ? `${uploaded.subfolder}/${uploaded.name}` : uploaded.name,
        freshSeed: true,
      });
      onClose();
      navigate('/');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not send the image');
    } finally {
      setBusy(null);
    }
  };

  const share = async () => {
    if (!image) return;
    const url = imageUrl(image);
    try {
      const response = await fetch(url);
      const blob = await response.blob();
      const file = new File([blob], image.filename, { type: blob.type || 'image/png' });

      // Web Share with files is the only route to "save to camera roll" on iOS.
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: record.title });
        return;
      }
    } catch {
      // Fall through to a plain download.
    }

    const link = document.createElement('a');
    link.href = url;
    link.download = image.filename;
    link.click();
  };

  return (
    <ImageViewer
      entries={entries}
      index={index}
      onIndexChange={onIndexChange}
      onClose={onClose}
      /*
        Text a node produced is chosen here like any other value now, rather
        than always being on: a node that writes the prompt is describing the
        picture the way the seed is, but a caption several lines long is not
        something to have permanently across the bottom of every image.
      */
      overlay={
        <ParamOverlayLine
          items={overlayValues(record, grid.viewerParams)}
          withLabels={grid.overlayLabels}
        />
      }
      footer={
        <div className="space-y-2">
          <ErrorNote>{error}</ErrorNote>

          {/* Scrolls sideways rather than wrapping — a two-line button row eats
              the bottom of the image on a small screen. */}
          {/*
            Rating is what copies the bytes onto this device, so it is the first
            thing offered — it is the difference between keeping an image and
            losing it when the instance is destroyed.
          */}
          {image && (
            <div className="flex items-center justify-between gap-3">
              <RatingStars value={image.rating} onChange={rate} size="sm" />
              <span className="text-[11px] text-muted">
                {image.archived
                  ? 'Stored on this device'
                  : image.rating > 0 || image.kept
                    ? 'Not copied locally'
                    : 'Rate or keep it to store a copy'}
              </span>
            </div>
          )}

          {/*
            Five columns of icon-led cells, two rows.

            Three columns of full-width buttons was flush at both edges and far
            too tall: ten actions became four rows of text that ate the bottom
            of the picture, which is the thing you opened. An icon with a small
            label underneath says the same in a fifth of the width, so
            everything stays reachable without a sheet and the image keeps the
            room.
          */}
          <div className="grid grid-cols-5 gap-1">
            <ViewerAction
              glyph={existingFavorite ? '★' : '☆'}
              // The label carries the state as well as the colour: "on or off"
              // has to survive being read rather than looked at.
              label={existingFavorite ? 'Favourited' : 'Favourite'}
              active={Boolean(existingFavorite)}
              busy={addFavorite.isPending || removeFavorite.isPending}
              onClick={favorite}
              title={
                existingFavorite
                  ? 'In Favourites — tap to remove'
                  : 'Keep this image and its settings in Favourites'
              }
            />
            <ViewerAction glyph="⤓" label="Save" onClick={share} />
            {/*
              Keeping is the promise a rating makes, without the judgement.
              With automatic cleanup switched on this is the difference between
              a picture surviving and not, and being made to award it stars
              first is a tax on saying "not sure yet, but don't bin it".
            */}
            <ViewerAction
              glyph="⌾"
              label={image?.kept ? 'Kept' : 'Keep'}
              active={Boolean(image?.kept)}
              busy={keepImage.isPending}
              onClick={() => {
                if (!image) return;
                keepImage.mutate(
                  { generationId: record.id, image, kept: !image.kept },
                  {
                    onError: (cause) =>
                      setError(cause instanceof Error ? cause.message : 'Could not keep that'),
                  },
                );
              }}
              title={
                image?.kept
                  ? 'Kept — the cleanup will leave it alone'
                  : 'Keep this picture without rating it'
              }
            />
            <ViewerAction
              glyph="⟳"
              label="Reseed"
              disabled={!workflowExists}
              onClick={() => rerun(true)}
              title={workflowExists ? 'Run again with a new seed' : 'That workflow has been deleted'}
            />
            <ViewerAction
              glyph="⇥"
              label="Reuse"
              disabled={!workflowExists}
              onClick={() => rerun(false)}
              title="Load these settings into the form"
            />
            <ViewerAction
              glyph="◨"
              label="img2img"
              busy={busy === 'img2img'}
              onClick={() => void sendTo('img2img')}
            />
            <ViewerAction
              glyph="⤢"
              label="Upscale"
              busy={busy === 'upscale'}
              onClick={() => void sendTo('upscale')}
            />
            <ViewerAction glyph="≡" label="Details" onClick={() => setShowDetails(true)} />
            {/* Which values are drawn over the picture. Its own choice, separate
                from the grid's — there is room for more here. */}
            <ParamOverlayPicker
              label="Values on the picture"
              caption="Values"
              records={entries.map((candidate) => candidate.record)}
              selected={grid.viewerParams}
              withLabels={grid.overlayLabels}
              onChange={(viewerParams) => onGridChange({ viewerParams })}
              onWithLabelsChange={(overlayLabels) => onGridChange({ overlayLabels })}
              // Shaped like the cells it shares a row with: glyph, then a word.
              className="h-auto w-full flex-col justify-center gap-0.5 rounded-lg px-1 py-1 shadow-md shadow-black/40"
            />
            {/* Two taps, because it cannot be undone. */}
            <ViewerAction
              glyph="⌫"
              label={confirmDelete ? 'Sure?' : 'Delete'}
              danger={confirmDelete}
              busy={deleteImage.isPending}
              onClick={() => {
                if (!confirmDelete) return setConfirmDelete(true);
                if (!image) return;
                deleteImage.mutate(
                  { generationId: record.id, image },
                  {
                    onSuccess: () => onClose(),
                    onError: (cause) =>
                      setError(cause instanceof Error ? cause.message : 'Could not delete that'),
                  },
                );
              }}
            />
          </div>

          <Sheet open={showDetails} onClose={() => setShowDetails(false)} title="Settings used" full>
            <DetailsList record={record} />
          </Sheet>
        </div>
      }
    />
  );
}

function DetailsList({ record }: { record: GenerationRecord }) {
  const entries = Object.entries(record.values).filter(
    ([, value]) => value !== null && value !== '',
  );

  return (
    <div className="space-y-4">
      <div>
        <p className="text-xs tracking-wide text-muted uppercase">Prompt</p>
        <p className="mt-1 text-sm break-words">{record.title}</p>
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
        <Detail label="Workflow" value={record.workflowName} />
        <Detail label="Status" value={record.status} />
        <Detail label="Created" value={new Date(record.createdAt).toLocaleString()} />
        {record.completedAt && (
          <Detail
            label="Took"
            value={`${Math.round((record.completedAt - record.createdAt) / 100) / 10}s`}
          />
        )}
      </div>

      {record.error && <ErrorNote>{record.error}</ErrorNote>}

      {/*
        Whatever the graph printed, one line each until you open it.

        A workflow can print several things — a rewritten prompt, a caption, the
        reasoning that produced either — and a node titled `rewrite prompt
        [thinking]` says which is which. Shown the same way as the parameters,
        because that is what they are: something the run decided, which you
        occasionally want to read in full and usually only want to know exists.
      */}
      {record.texts.length > 0 && (
        <div>
          <p className="mb-2 text-xs tracking-wide text-muted uppercase">What the graph printed</p>
          <dl className="space-y-1.5 text-xs">
            {record.texts.map((output, index) => (
              <DetailRow
                key={`${output.nodeId}-${index}`}
                name={textOutputLabel(output.nodeTitle)}
                value={output.text}
              />
            ))}
          </dl>
        </div>
      )}

      <div>
        <p className="mb-2 text-xs tracking-wide text-muted uppercase">All parameters</p>
        <dl className="space-y-1.5 text-xs">
          {entries.map(([id, value]) => (
            <DetailRow key={id} name={id} value={String(value)} />
          ))}
        </dl>
      </div>
    </div>
  );
}

/**
 * One action in the viewer's footer: a glyph with a small label under it.
 *
 * Ten actions belong on that screen and none of them is worth a row of its own
 * — the picture is what the screen is for. A 44px cell is still a comfortable
 * target, and the label means the glyph never has to be guessed at.
 */
function ViewerAction({
  glyph,
  label,
  onClick,
  active = false,
  danger = false,
  disabled = false,
  busy = false,
  title,
}: {
  glyph: string;
  label: string;
  onClick: () => void;
  active?: boolean;
  danger?: boolean;
  disabled?: boolean;
  busy?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || busy}
      aria-pressed={active}
      aria-label={label}
      title={title}
      className={cn(
        // The shadow does what the bar behind these used to: separates them
        // from whatever part of the picture they happen to be sitting on.
        'flex flex-col items-center justify-center gap-0.5 rounded-lg px-1 py-1 shadow-md shadow-black/40 disabled:opacity-40',
        danger
          ? 'bg-danger/20 text-danger'
          : active
            ? 'bg-accent/20 text-accent'
            : 'bg-surface text-body active:bg-surface-2',
      )}
    >
      <span aria-hidden className="text-base leading-none">
        {busy ? <Spinner className="size-4" /> : glyph}
      </span>
      <span className="w-full truncate text-center text-[9px] leading-none text-muted">
        {label}
      </span>
    </button>
  );
}

/**
 * One parameter, cut to a line until you tap it.
 *
 * A prompt is the value people most often want to read here and the one least
 * likely to fit, so truncating it permanently hides exactly what the list is
 * for. Tapping opens the whole thing; tapping again puts it back, so a long
 * value does not push everything below it off the screen for good.
 */
function DetailRow({ name, value }: { name: string; value: string }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="border-b border-line/50 pb-1.5">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        className="flex w-full items-start justify-between gap-4 text-left"
      >
        <dt className="shrink-0 text-muted">{name}</dt>
        <dd
          className={cn(
            'min-w-0 text-right',
            open ? 'break-words [overflow-wrap:anywhere]' : 'truncate',
          )}
        >
          {value}
        </dd>
      </button>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-muted">{label}</p>
      <p className="truncate">{value}</p>
    </div>
  );
}
