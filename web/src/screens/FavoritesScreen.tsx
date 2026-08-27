import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import type { Favorite, FavoriteSort, GenerationImage, GenerationRecord } from '@latent/shared';

import { useFavorites, useGeneration } from '../api/queries';
import { Thumb, type ViewerEntry } from '../components/ImageViewer';
import { shapeOf, ThumbGrid, useTileStyle } from '../components/ThumbGrid';
import { useMeasuredVersion } from '../state/measured';
import { Toggle } from '../components/ParamControl';
import { cn, EmptyState, Spinner } from '../components/ui';
import { ViewerWithActions } from '../components/ViewerWithActions';
import { useGridSettings } from '../state/grid';
import { showInGallery } from '../state/galleryTarget';

const SORTS: { label: string; value: FavoriteSort }[] = [
  { label: 'Rating', value: 'rating' },
  { label: 'Newest', value: 'newest' },
  { label: 'Oldest', value: 'oldest' },
];

/**
 * Images kept for reuse, with the settings that made them.
 *
 * Distinct from a gallery rating on purpose: the gallery star says "this
 * picture is good", a favourite says "I want to make more of these". They are
 * rated separately because the two judgements are not the same.
 */
export function FavoritesScreen() {
  const navigate = useNavigate();
  const [sort, setSort] = useState<FavoriteSort>('rating');
  const favorites = useFavorites(sort);
  const [settings, updateSettings] = useGridSettings();
  /** Which favourite is open in the viewer, by its id. */
  const [viewing, setViewing] = useState<string | null>(null);

  const items = favorites.data ?? [];
  // The grid works its rows out from the whole list at once, so it needs the
  // shapes in the order they are shown. A favourite with no picture is a slot
  // like any other.
  const measured = useMeasuredVersion();
  const shapes = useMemo(
    () => items.map((favorite) => shapeOf(favorite.image)),
    // `measured` is a signal rather than a value: it changes when a picture's
    // size becomes known, which is when the rows need working out again.
    [items, measured],
  );

  /*
   * Every favourite, in the order they are listed, as viewer entries.
   *
   * Tapping one used to open a page about it, with the viewer a tap further
   * in — so the picture took two taps to see properly, and the swipe when you
   * got there went through the batch that picture came out of rather than
   * through the favourites you were looking at. This is the gallery's
   * behaviour instead: one tap opens it full-screen, and a swipe is the next
   * favourite.
   */
  const entries = useMemo<ViewerEntry[]>(
    () =>
      items
        .filter((favorite): favorite is Favorite & { image: GenerationImage } =>
          Boolean(favorite.image),
        )
        .map((favorite) => ({ record: standInRecord(favorite, favorite.image), image: favorite.image })),
    [items],
  );

  const viewerIndex = viewing
    ? items.filter((favorite) => favorite.image).findIndex((favorite) => favorite.id === viewing)
    : -1;

  const header = (
    <div className="mb-3 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Favourites</h1>
        <div className="flex gap-1 rounded-full bg-surface p-1">
          {SORTS.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => setSort(option.value)}
              className={cn(
                'rounded-full px-3 py-1.5 text-xs',
                sort === option.value ? 'bg-accent text-white' : 'text-muted',
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {/*
        A switch belongs next to what it is called.

        Full width is right above a phone's grid and wrong above a tablet's,
        where it puts the words at one edge of the screen and the switch at the
        other with three feet of empty bar between them. The grid underneath
        still takes the whole width — it is pictures, and pictures want it.
      */}
      <div className="flex items-center justify-between gap-3 rounded-xl border border-line bg-surface px-3 py-2 tablet:max-w-md">
        <span className="text-sm">Show thumbnails</span>
        <Toggle
          checked={settings.favoriteThumbnails}
          onChange={(favoriteThumbnails) => updateSettings({ favoriteThumbnails })}
        />
      </div>
    </div>
  );

  if (favorites.isLoading) {
    return (
      <div className="grid h-full place-items-center">
        <Spinner className="size-6 text-muted" />
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="safe-t px-4 pt-3">
        {header}
        <EmptyState
          icon="☆"
          title="No favourites yet"
          hint="Open a result in the gallery and tap Favourite. It keeps the image and the settings that produced it, so you can make more like it."
        />
      </div>
    );
  }

  return (
    <div className="safe-t px-4 pt-3 pb-6">
      {header}

      {settings.favoriteThumbnails ? (
        <ThumbGrid
          columns={settings.columns}
          shapes={shapes}
          uniform={settings.uniformTiles}
        >
          {items.map((favorite, at) => (
            <FavoriteTile
              key={favorite.id}
              favorite={favorite}
              at={at}
              onOpen={() => setViewing(favorite.id)}
            />
          ))}
        </ThumbGrid>
      ) : (
        <ul className="space-y-2">
          {items.map((favorite) => (
            <li key={favorite.id}>
              <button
                type="button"
                onClick={() => setViewing(favorite.id)}
                className="w-full rounded-xl border border-line bg-surface px-3 py-3 text-left active:bg-surface-2"
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {favorite.title || 'Untitled'}
                  </span>
                  <span className="shrink-0 text-xs text-warn">
                    {favorite.rating > 0 ? '★'.repeat(favorite.rating) : '—'}
                  </span>
                </div>
                {favorite.note && (
                  <p className="mt-1 truncate text-xs text-muted">{favorite.note}</p>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}

      {viewerIndex >= 0 && (
        <FavoriteViewer
          entries={entries}
          index={viewerIndex}
          onIndexChange={(next) => {
            const withImages = items.filter((favorite) => favorite.image);
            const favorite = withImages[next];
            if (favorite) setViewing(favorite.id);
          }}
          onClose={() => setViewing(null)}
          onShowInGallery={(entry) => {
            if (!entry.record.id || !entry.image) return;
            showInGallery(entry.record.id, entry.image);
            setViewing(null);
            navigate('/gallery');
          }}
        />
      )}
    </div>
  );
}

function FavoriteTile({
  favorite,
  at,
  onOpen,
}: {
  favorite: Favorite;
  /** Its place in the grid; the shape belongs to the row. See `planTiles`. */
  at: number;
  onOpen: () => void;
}) {
  const style = useTileStyle(at);

  return (
    <div className="relative min-w-0" style={style}>
      {favorite.image ? (
        <Thumb image={favorite.image} alt={favorite.title} className="size-full" onClick={onOpen} />
      ) : (
        <button
          type="button"
          onClick={onOpen}
          className="size-full rounded-xl border border-line bg-surface p-3 text-left text-xs text-muted"
        >
          {favorite.title || 'Untitled'}
        </button>
      )}
      {favorite.rating > 0 && (
        <span className="pointer-events-none absolute bottom-1 left-1 rounded-md bg-black/60 px-1.5 py-0.5 text-[10px] text-warn backdrop-blur">
          {'★'.repeat(favorite.rating)}
        </span>
      )}
      {/*
        Marked while the picture is only borrowed.

        Favouriting copies the bytes here, but that copy can fail — ComfyUI
        busy, the connection dropped — and it was only logged. The favourite
        then looked fine right up until the instance holding the picture went
        away, which is the day a favourite is supposed to survive.
      */}
      {!favorite.archived && (
        <span
          title="Not stored here yet"
          className="pointer-events-none absolute top-1 right-1 rounded-md bg-black/60 px-1.5 py-0.5 text-[10px] text-warn backdrop-blur"
        >
          ⚠
        </span>
      )}
    </div>
  );
}

/**
 * A record made out of the favourite itself.
 *
 * Only for the case where the run behind it cannot be read — it was deleted, or
 * it is still being fetched. A favourite snapshots the values, not the rendered
 * summary, so this carries the picture, the prompt and the settings and nothing
 * else.
 */
function standInRecord(favorite: Favorite, image: GenerationImage): GenerationRecord {
  return {
    id: favorite.generationId ?? favorite.id,
    promptId: '',
    workflowId: favorite.workflowId,
    workflowName: '',
    status: 'completed',
    error: null,
    values: favorite.values,
    seeds: {},
    params: [],
    // A favourite snapshots the values, not what the run was made from, so
    // there is nothing here to compare an edit against. The real record is
    // fetched on top of this one and brings its origins with it.
    origins: [],
    title: favorite.title,
    texts: [],
    images: [image],
    createdAt: favorite.createdAt,
    completedAt: favorite.createdAt,
    source: 'comfy',
  };
}

/**
 * A favourite, in the viewer everything else opens in.
 *
 * The entries are the whole list, so a swipe is the next favourite — the same
 * gesture the gallery answers with the next picture. The run behind whichever
 * one is open is fetched on top of that: a favourite stores its own copy of the
 * image and the values, which is enough to look at and to re-run, but not the
 * printed outputs or the workflow's name, and those are what the details sheet
 * is for.
 */
function FavoriteViewer({
  entries,
  index,
  onIndexChange,
  onClose,
  onShowInGallery,
}: {
  entries: ViewerEntry[];
  index: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
  onShowInGallery: (entry: ViewerEntry) => void;
}) {
  const [grid, updateGrid] = useGridSettings();
  const current = entries[index];
  /*
   * Only the one being looked at.
   *
   * Fetching every favourite's run to build the list would be one request per
   * picture for something you can only read one of at a time.
   */
  const generation = useGeneration(current?.record.id ?? null);

  const withRealRecord = useMemo<ViewerEntry[]>(() => {
    const record = generation.data;
    if (!record || !current || record.id !== current.record.id) return entries;
    return entries.map((entry, at) => (at === index ? { ...entry, record } : entry));
  }, [entries, current, generation.data, index]);

  return (
    <ViewerWithActions
      entries={withRealRecord}
      index={index}
      grid={grid}
      onGridChange={updateGrid}
      onIndexChange={onIndexChange}
      onClose={onClose}
      onShowInGallery={onShowInGallery}
    />
  );
}
