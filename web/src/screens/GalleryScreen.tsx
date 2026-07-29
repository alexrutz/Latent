import { forwardRef, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import type { GenerationImage, GenerationRecord, GridSettings } from '@latent/shared';

import { api, imageUrl } from '../api/client';
import {
  useAddFavorite,
  useGallery,
  useRateImage,
  useReportDimensions,
  useSetTileSpan,
  useSettings,
  useWorkflows,
} from '../api/queries';
import { ImageViewer, Thumb } from '../components/ImageViewer';
import { RatingStars } from '../components/RatingStars';
import { ThumbGrid, useTileStyle } from '../components/ThumbGrid';
import { Toggle } from '../components/ParamControl';
import { Button, cn, EmptyState, ErrorNote, Sheet, Spinner } from '../components/ui';
import { TILE_OPTIONS, useGridSettings } from '../state/grid';
import { usePendingStore } from '../state/pending';

const FILTERS = [
  { label: 'All', minRating: 0 },
  { label: 'Rated', minRating: 1 },
  { label: '★ 4+', minRating: 4 },
] as const;

export function GalleryScreen() {
  const [minRating, setMinRating] = useState(0);
  const gallery = useGallery({ minRating });
  const [selected, setSelected] = useState<{ record: GenerationRecord; index: number } | null>(null);
  const [tileTarget, setTileTarget] = useState<
    { record: GenerationRecord; image: GenerationImage } | null
  >(null);
  const [settings, updateSettings] = useGridSettings();
  const [showLayout, setShowLayout] = useState(false);
  const sentinel = useRef<HTMLDivElement>(null);
  const firstResult = useRef<HTMLDivElement>(null);
  const scrolledOnce = useRef(false);
  const reportDimensions = useReportDimensions();
  const setTileSpan = useSetTileSpan();

  const items = useMemo(
    () => gallery.data?.pages.flatMap((page) => page.items) ?? [],
    [gallery.data],
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

  // The open record must track live updates, or a still-running generation
  // would never gain its images while the viewer is open.
  const openRecord = selected ? (items.find((item) => item.id === selected.record.id) ?? selected.record) : null;

  const filterBar = (
    <div className="mb-3 flex items-center justify-between gap-2">
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

      <ThumbGrid columns={settings.columns}>
        {items.map((record, recordIndex) =>
          record.images.length > 0 ? (
            record.images.map((image, imageIndex) => (
              <GalleryTile
                key={`${record.id}-${image.filename}`}
                ref={recordIndex === firstResultIndex && imageIndex === 0 ? firstResult : undefined}
                record={record}
                image={image}
                settings={settings}
                onOpen={() => setSelected({ record, index: imageIndex })}
                onHold={() => setTileTarget({ record, image })}
                onMeasured={(width, height) =>
                  reportDimensions.mutate({ image, width, height })
                }
              />
            ))
          ) : (
            <PlaceholderCard key={record.id} record={record} />
          ),
        )}
      </ThumbGrid>

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

      {openRecord && selected && (
        <ViewerWithActions
          record={openRecord}
          index={Math.min(selected.index, Math.max(0, openRecord.images.length - 1))}
          onIndexChange={(index) => setSelected({ record: openRecord, index })}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

/** One thumbnail, shaped by its aspect ratio and badged with its rating. */
const GalleryTile = forwardRef<
  HTMLDivElement,
  {
    record: GenerationRecord;
    image: GenerationImage;
    settings: GridSettings;
    onOpen: () => void;
    onHold: () => void;
    onMeasured: (width: number, height: number) => void;
  }
>(function GalleryTile({ record, image, settings, onOpen, onHold, onMeasured }, ref) {
  const style = useTileStyle(image, settings);

  return (
    <div ref={ref} className="relative min-w-0" style={style}>
      <Thumb
        image={image}
        alt={record.title}
        className="size-full"
        onClick={onOpen}
        onLongPress={onHold}
        onMeasured={onMeasured}
      />
      {image.rating > 0 && (
        <span
          title={
            image.archived ? 'Rated and stored on this device' : 'Rated, but not copied locally yet'
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
    </div>
  );
});

/** A queued, running or failed generation that has no image to show yet. */
function PlaceholderCard({ record }: { record: GenerationRecord }) {
  const failed = record.status === 'failed';
  const cancelled = record.status === 'cancelled';

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
      ) : cancelled ? (
        <p className="text-xs text-muted">Cancelled</p>
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
  record,
  index,
  onIndexChange,
  onClose,
}: {
  record: GenerationRecord;
  index: number;
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

  const image = record.images[index];
  const workflowExists = workflows.data?.some((item) => item.id === record.workflowId) ?? false;
  const rateImage = useRateImage();
  const addFavorite = useAddFavorite();

  const favorite = async () => {
    if (!image) return;
    setError(null);
    try {
      await addFavorite.mutateAsync({ generationId: record.id, image });
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
      record={record}
      index={index}
      onIndexChange={onIndexChange}
      onClose={onClose}
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
                  : image.rating > 0
                    ? 'Not copied locally'
                    : 'Rate to keep a local copy'}
              </span>
            </div>
          )}

          <div className="no-scrollbar flex gap-2 overflow-x-auto [&>button]:shrink-0 [&>button]:whitespace-nowrap">
            <Button
              variant="secondary"
              size="sm"
              busy={addFavorite.isPending}
              onClick={favorite}
              title="Keep this image and its settings in Favourites"
            >
              ☆ Favourite
            </Button>
            <Button variant="secondary" size="sm" onClick={share}>
              Save
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={!workflowExists}
              onClick={() => rerun(true)}
              title={workflowExists ? undefined : 'That workflow has been deleted'}
            >
              New seed
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={!workflowExists}
              onClick={() => rerun(false)}
            >
              Reuse settings
            </Button>
            <Button
              variant="secondary"
              size="sm"
              busy={busy === 'img2img'}
              onClick={() => void sendTo('img2img')}
            >
              img2img
            </Button>
            <Button
              variant="secondary"
              size="sm"
              busy={busy === 'upscale'}
              onClick={() => void sendTo('upscale')}
            >
              Upscale
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setShowDetails(true)}>
              Details
            </Button>
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

      <div>
        <p className="mb-2 text-xs tracking-wide text-muted uppercase">All parameters</p>
        <dl className="space-y-1.5 text-xs">
          {entries.map(([id, value]) => (
            <div key={id} className="flex justify-between gap-4 border-b border-line/50 pb-1.5">
              <dt className="shrink-0 text-muted">{id}</dt>
              <dd className="min-w-0 truncate text-right">{String(value)}</dd>
            </div>
          ))}
        </dl>
      </div>
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
