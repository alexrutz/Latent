import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import type { Favorite, FavoriteSort } from '@latent/shared';

import { useQueryClient } from '@tanstack/react-query';

import { api, thumbnailUrl } from '../api/client';
import {
  queryKeys,
  useDeleteFavorite,
  useFavorites,
  useUpdateFavorite,
} from '../api/queries';
import { ImageViewer, Thumb } from '../components/ImageViewer';
import { RatingStars } from '../components/RatingStars';
import { ThumbGrid, useTileStyle } from '../components/ThumbGrid';
import { Toggle } from '../components/ParamControl';
import { Button, Card, cn, EmptyState, ErrorNote, Sheet, Spinner } from '../components/ui';
import { useGridSettings } from '../state/grid';
import { showInGallery } from '../state/galleryTarget';
import { usePendingStore } from '../state/pending';

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
  const [sort, setSort] = useState<FavoriteSort>('rating');
  const favorites = useFavorites(sort);
  const [settings, updateSettings] = useGridSettings();
  const [open, setOpen] = useState<Favorite | null>(null);

  const items = favorites.data ?? [];

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

      <div className="flex items-center justify-between gap-3 rounded-xl border border-line bg-surface px-3 py-2">
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
        <ThumbGrid columns={settings.columns}>
          {items.map((favorite) => (
            <FavoriteTile key={favorite.id} favorite={favorite} onOpen={() => setOpen(favorite)} />
          ))}
        </ThumbGrid>
      ) : (
        <ul className="space-y-2">
          {items.map((favorite) => (
            <li key={favorite.id}>
              <button
                type="button"
                onClick={() => setOpen(favorite)}
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

      {open && <FavoriteSheet favorite={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function FavoriteTile({ favorite, onOpen }: { favorite: Favorite; onOpen: () => void }) {
  const [settings] = useGridSettings();
  const style = useTileStyle(
    favorite.image ?? { width: null, height: null, tileSpan: null },
    settings,
  );

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

function FavoriteSheet({ favorite, onClose }: { favorite: Favorite; onClose: () => void }) {
  const navigate = useNavigate();
  const setPending = usePendingStore((state) => state.setPending);
  const update = useUpdateFavorite();
  const remove = useDeleteFavorite();

  const queryClient = useQueryClient();
  const [note, setNote] = useState(favorite.note ?? '');
  const [viewing, setViewing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);

  const makeMore = (freshSeed: boolean) => {
    if (!favorite.workflowId || !favorite.workflowAvailable) return;
    setPending({ workflowId: favorite.workflowId, values: favorite.values, freshSeed });
    onClose();
    navigate('/');
  };

  /**
   * Open the picture where the rest of its run is.
   *
   * A favourite is one image out of a batch, and "show me the others" is the
   * commonest thing to want from it — previously a scroll through the gallery
   * looking for something you were already holding.
   */
  const openInGallery = () => {
    if (!favorite.generationId || !favorite.image) return;
    showInGallery(favorite.generationId, favorite.image);
    onClose();
    navigate('/gallery');
  };

  if (viewing && favorite.image) {
    return (
      <ImageViewer
        // One favourite at a time: there is nothing to swipe to from here, and
        // the surrounding list is sorted by rating rather than by run.
        entries={[
          {
            record: {
              id: favorite.generationId ?? favorite.id,
              promptId: '',
              workflowId: favorite.workflowId,
              workflowName: '',
              status: 'completed',
              error: null,
              values: favorite.values,
              seeds: {},
              // A favourite snapshots the values, not the rendered summary — the
              // viewer only needs the image and the title here.
              params: [],
              title: favorite.title,
              texts: [],
              images: [favorite.image],
              createdAt: favorite.createdAt,
              completedAt: favorite.createdAt,
              source: 'comfy',
            },
            image: favorite.image,
          },
        ]}
        index={0}
        onIndexChange={() => undefined}
        onClose={() => setViewing(false)}
      />
    );
  }

  return (
    <Sheet open onClose={onClose} title="Favourite" full>
      <div className="space-y-4">
        {favorite.image && (
          <button
            type="button"
            onClick={() => setViewing(true)}
            className="block w-full overflow-hidden rounded-2xl border border-line bg-surface-2"
          >
            {/* A preview: tapping it opens the viewer, which is where the
                full-size picture belongs. */}
            <img src={thumbnailUrl(favorite.image)} alt={favorite.title} className="w-full" />
          </button>
        )}

        <p className="text-sm break-words">{favorite.title || 'Untitled'}</p>

        <Card className="flex items-center justify-between gap-3">
          <span className="text-sm">Rating</span>
          <RatingStars
            value={favorite.rating}
            onChange={(rating) => update.mutate({ id: favorite.id, patch: { rating } })}
          />
        </Card>

        <label className="block">
          <span className="mb-1.5 block text-xs tracking-wide text-muted uppercase">Note</span>
          <textarea
            value={note}
            onChange={(event) => setNote(event.target.value)}
            onBlur={() => {
              if (note !== (favorite.note ?? '')) {
                update.mutate({ id: favorite.id, patch: { note: note.trim() || null } });
              }
            }}
            rows={2}
            placeholder="What you liked about it…"
            className="w-full resize-none rounded-xl border border-line bg-surface px-4 py-3 focus:border-accent focus:outline-none"
          />
        </label>

        <ErrorNote>{error}</ErrorNote>

        {/* The copy that never happened, and the second chance at it. */}
        {!favorite.archived && (
          <Card className="space-y-2">
            <p className="text-xs text-warn">
              This picture is not stored on this device. It is still being read from ComfyUI,
              so it will disappear when that instance does.
            </p>
            <Button
              variant="secondary"
              className="w-full"
              busy={saving}
              onClick={async () => {
                setError(null);
                setSaving(true);
                try {
                  await api.archiveFavorite(favorite.id);
                  await queryClient.invalidateQueries({ queryKey: queryKeys.favorites });
                } catch (cause) {
                  setError(cause instanceof Error ? cause.message : 'Could not fetch it');
                } finally {
                  setSaving(false);
                }
              }}
            >
              Store it here now
            </Button>
          </Card>
        )}

        <div className="space-y-2">
          {favorite.generationId && favorite.image && (
            <Button variant="secondary" className="w-full" onClick={openInGallery}>
              Show in the gallery
            </Button>
          )}
          <Button
            variant="primary"
            size="lg"
            disabled={!favorite.workflowAvailable}
            onClick={() => makeMore(true)}
          >
            Make more like this
          </Button>
          <Button
            variant="secondary"
            className="w-full"
            disabled={!favorite.workflowAvailable}
            onClick={() => makeMore(false)}
          >
            Reproduce exactly
          </Button>
          {!favorite.workflowAvailable && (
            <p className="text-center text-xs text-muted">
              The workflow this came from has been deleted, so it cannot be re-run. The image and
              its settings are still here.
            </p>
          )}
        </div>

        <Button
          variant="danger"
          className="w-full"
          busy={remove.isPending}
          onClick={async () => {
            setError(null);
            try {
              await remove.mutateAsync(favorite.id);
              onClose();
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : 'Could not remove that favourite');
            }
          }}
        >
          Remove from favourites
        </Button>
        <p className="text-center text-xs text-muted">
          The image itself stays in your gallery and on this device.
        </p>
      </div>
    </Sheet>
  );
}
