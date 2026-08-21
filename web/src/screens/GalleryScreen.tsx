import { forwardRef, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { VIEWER_SCALE_STEPS, viewerScaleLabel, viewerScaleOf } from '@latent/shared';
import type {
  GallerySort,
  GenerationImage,
  GenerationRecord,
  GridSettings,
} from '@latent/shared';

import {
  useGallery,
  reportImageDimensions,
  useSetTileSpan,
  useWorkflows,
} from '../api/queries';
import { Thumb, type ViewerEntry } from '../components/ImageViewer';
import {
  overlayValues,
  ParamOverlayLine,
  ParamOverlayPicker,
} from '../components/ParamOverlay';
import { ThumbGrid, useTileStyle } from '../components/ThumbGrid';
import { Toggle } from '../components/ParamControl';
import { BlurButton } from '../components/BlurButton';
import {
  cn,
  CONTROL_FACE,
  CONTROL_FACE_SET,
  EmptyState,
  Sheet,
  Spinner,
} from '../components/ui';
import { ViewerWithActions } from '../components/ViewerWithActions';
import { TILE_OPTIONS, useGridSettings } from '../state/grid';
import { useGalleryTargetStore } from '../state/galleryTarget';

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
  // Read through the helper so a setting written by the switch this replaced
  // still means what it meant.
  const viewerScale = viewerScaleOf(settings);
  const [showLayout, setShowLayout] = useState(false);
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
    <div className="sticky top-0 z-20 -mx-4 mb-3 space-y-1.5 bg-ink/95 px-4 py-2 backdrop-blur">
      {/*
        Two rows, because five controls and a title do not fit across a phone.

        They used to be one row, and the last two — the blur and the grid — hung
        off the right-hand edge of the screen where nothing could reach them.
        The split is not arbitrary: the top row is what this screen *is* plus
        the things you open occasionally, and the rating filter gets a row of
        its own because it is the one you actually tap, which also lets each
        chip be a third of the screen wide instead of forty pixels.
      */}
      <div className="flex items-center justify-between gap-2">
        <h1 className="min-w-0 truncate text-xl font-semibold">Gallery</h1>
        <div className="flex shrink-0 items-center gap-1.5">
          {/* Sorting and the workflow filter live behind one button: they are
              decisions you make occasionally, and three more chips across the
              top would leave no room for the pictures. */}
          <button
            type="button"
            onClick={() => setShowFilters(true)}
            aria-label="Sort and filter"
            className={cn(
              'flex h-9 shrink-0 items-center gap-1 rounded-full px-2.5 text-[11px] leading-none',
              sort !== 'newest' || workflowId ? CONTROL_FACE_SET : CONTROL_FACE,
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
          <button
            type="button"
            onClick={() => setShowLayout(true)}
            aria-label="Grid layout"
            className={cn(
              'grid size-9 shrink-0 place-items-center rounded-full text-base',
              CONTROL_FACE,
            )}
          >
            ▦
          </button>
          {/*
            Last, always, on every screen that has one of these rows.

            Reachable from where the pictures are rather than only from
            Settings — the moment you want it is the moment somebody sits down
            next to you — and always in the same corner, because a control you
            reach for without looking has to be somewhere your thumb already
            knows.
          */}
          <BlurButton />
        </div>
      </div>

      <div className="flex gap-1 rounded-full bg-surface p-1">
        {FILTERS.map((filter) => (
          <button
            key={filter.label}
            type="button"
            onClick={() => setMinRating(filter.minRating)}
            className={cn(
              'min-w-0 flex-1 truncate rounded-full px-3 py-1.5 text-xs',
              minRating === filter.minRating ? 'bg-accent text-white' : 'text-muted',
            )}
          >
            {filter.label}
          </button>
        ))}
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

        {/*
          A scale rather than a switch. Both ends are real answers and so is the
          middle — below one for a slow line, where a picture that arrives beats
          a sharp one that does not; above one so the first moments of a zoom
          are already sharp, before the crop for it has been fetched.
        */}
        <div className="space-y-1.5">
          <div className="flex items-baseline justify-between gap-3">
            <p className="text-sm">Viewer resolution</p>
            <span className="text-xs text-muted">{viewerScaleLabel(viewerScale)}</span>
          </div>
          <div role="radiogroup" aria-label="Viewer resolution" className="flex flex-wrap gap-1">
            {VIEWER_SCALE_STEPS.map((step) => {
              const active = viewerScale === step;
              return (
                <button
                  key={step}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  aria-label={viewerScaleLabel(step)}
                  onClick={() => updateSettings({ viewerScale: step })}
                  className={cn(
                    'min-w-11 rounded-lg px-2.5 py-1.5 text-xs tabular-nums',
                    active ? 'bg-accent text-white' : 'bg-surface-2 text-muted',
                  )}
                >
                  {viewerScaleLabel(step)}
                </button>
              );
            })}
          </div>
          <p className="text-xs text-muted">
            A multiple of what this screen can resolve. At <strong className="text-body">1×</strong>
            {' '}opening a picture fetches a copy sized for the screen, and zooming in fetches
            that part of it the same way — a recent output is sixteen megapixels and this screen
            is about two, so the rest would be downloaded and thrown away, which is most of the
            wait and most of the memory while the next render is going.{' '}
            <strong className="text-body">The file</strong> fetches it whole, for when you want to
            inspect the pixels rather than look at the picture.
          </p>
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
