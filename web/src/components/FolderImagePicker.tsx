import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import type { BrowseListing, Favorite } from '@latent/shared';

import { api, browseThumbUrl, thumbnailUrl } from '../api/client';
import { useFavorites } from '../api/queries';
import { ErrorNote, Sheet, Spinner, cn } from './ui';

/**
 * Choosing a picture out of a folder on the ComfyUI machine.
 *
 * Not the same thing as the *input image* picker next door, though they look
 * alike. That one lists ComfyUI's **input** directory, which is where photos
 * sent from this phone land. This one browses whatever comfyllama is configured
 * to serve — normally **output** first — because the commonest thing anybody
 * wants to do with a render is feed it back in, and until now that meant finding
 * it in a file manager and copying it across.
 *
 * What it holds is a path, `output/monday/render_0007.png`, not a filename: the
 * same relative path exists under `output` and under `input`, and a picture that
 * silently came from the wrong one is a bug nobody would think to look for.
 *
 * Everything it offers comes from the ComfyUI machine, through Latent's proxy,
 * so it can only ever show what the node will actually agree to load.
 */

const SORTS: { key: string; sort: string; order: string; label: string }[] = [
  { key: 'date', sort: 'date', order: 'desc', label: 'Newest' },
  { key: 'date-asc', sort: 'date', order: 'asc', label: 'Oldest' },
  { key: 'name', sort: 'name', order: 'asc', label: 'A–Z' },
  { key: 'name-desc', sort: 'name', order: 'desc', label: 'Z–A' },
  { key: 'size', sort: 'size', order: 'desc', label: 'Largest' },
];

/**
 * Where the browser was left, for the lifetime of the tab.
 *
 * Module scope rather than component state, because the sheet unmounts when it
 * closes. Picking a second reference out of the same folder is the normal case,
 * and navigating back to it every time is what makes a browser tiresome.
 */
const remembered = { root: '', path: '', sort: 'date', recursive: false };

/**
 * The pseudo-root Latent's own favourites live under.
 *
 * A category beside `output` and `input` rather than a mode of its own, because
 * that is what it is to whoever is looking: another place the picture might be.
 * It is not a folder on the far machine, so it never reaches the browse routes
 * — the name only has to be something no real root is called.
 *
 * These are the favourites from the Gallery — the ★ tab of the app — and not a
 * second, private list kept inside this dialog. That second list is what this
 * used to be, and it was wrong in a way that took a while to name: you already
 * have a list of the pictures worth coming back to, you curate it every day
 * from the viewer, and being asked to build a *separate* one out of file paths
 * in a folder browser is being asked to do the same work twice with worse
 * tools. A picture kept in the gallery is a picture you want again, and
 * wanting it again is mostly what a reference slot is for.
 */
const FAVORITES = '★';

/** The reference a listed entry would be starred under. */
function refOf(root: string, entry: { path: string }): string {
  return `${root}/${entry.path}`;
}

export function FolderImagePicker({
  open,
  onClose,
  onPicked,
  batch = [],
  onBatch,
  kind = 'image',
}: {
  open: boolean;
  onClose: () => void;
  /** The chosen reference, as `root/relative/path.png`. */
  onPicked: (reference: string) => void;
  /**
   * The list this slot is already working through, so reopening the picker
   * shows what is ticked rather than starting from nothing.
   */
  batch?: string[];
  /**
   * Hand back a list rather than one picture.
   *
   * Absent for a slot that has no business holding several — then the
   * checkboxes are not drawn at all, and the sheet is exactly what it was.
   */
  onBatch?: (references: string[]) => void;
  /** What this slot can use. A video slot has no business listing pictures. */
  kind?: 'image' | 'video' | 'audio';
}) {
  const [root, setRoot] = useState(remembered.root);
  const [path, setPath] = useState(remembered.path);
  const [sortKey, setSortKey] = useState(remembered.sort);
  const [recursive, setRecursive] = useState(remembered.recursive);
  const [typed, setTyped] = useState('');
  const [query, setQuery] = useState('');

  /*
   * What is ticked, in the order it was ticked.
   *
   * Order matters and is not the listing's: it is the order the renders will
   * happen in, so ticking the three you want in the sequence you want them is
   * the whole interaction. Appending rather than re-sorting is what makes that
   * true.
   *
   * Seeded from the slot's current list whenever the sheet opens, so coming
   * back to add a fourth picture shows the three already ticked instead of an
   * empty dialog that would silently replace them.
   */
  const [checked, setChecked] = useState<string[]>(batch);
  useEffect(() => {
    // Only on the transition to open. `batch` is deliberately not a dependency:
    // it changes when the ticking is confirmed, and re-seeding on that would
    // have the sheet fighting the thing it was just told.
    if (open) setChecked(batch);
  }, [open]);

  const multiple = Boolean(onBatch);
  const ticked = useMemo(() => new Set(checked), [checked]);

  const tick = (reference: string) =>
    setChecked((current) =>
      current.includes(reference)
        ? current.filter((entry) => entry !== reference)
        : [...current, reference],
    );

  const roots = useQuery({ queryKey: ['browse-roots'], queryFn: api.browseRoots, enabled: open });

  /*
   * The gallery's favourites, newest first.
   *
   * Only fetched while the sheet is open — it is a list of every picture ever
   * kept, and nothing needs it until somebody taps the ★ chip. Newest first
   * because a reference slot is overwhelmingly filled from recent work.
   */
  const galleryFavorites = useFavorites('newest');

  /*
   * The ones this slot could actually load.
   *
   * A favourite records what kind of media it is, so a clip kept from a video
   * workflow is simply not offered in a picture slot — the node would refuse
   * it, and an entry that can only fail is worse than no entry. A favourite
   * with no picture at all (the copy failed, and the original is gone) is out
   * for the same reason.
   */
  const favorites = useMemo(
    () =>
      (galleryFavorites.data ?? []).filter(
        (favorite): favorite is Favorite & { image: NonNullable<Favorite['image']> } =>
          Boolean(favorite.image) && favorite.image!.kind === kind,
      ),
    [galleryFavorites.data, kind],
  );

  // The first root is the one to open on: comfyllama offers `output` first,
  // which is what somebody looking for a render wants.
  useEffect(() => {
    const first = roots.data?.roots[0]?.key;
    if (!root && first) setRoot(first);
  }, [roots.data, root]);

  /*
   * Typing does not fetch on every keystroke.
   *
   * A recursive search of a month of renders is a walk of thousands of files on
   * the far machine, and firing one per letter would have the phone waiting on
   * answers to questions it has already stopped asking.
   */
  useEffect(() => {
    const timer = setTimeout(() => setQuery(typed.trim()), 220);
    return () => clearTimeout(timer);
  }, [typed]);

  const chosen = SORTS.find((entry) => entry.key === sortKey) ?? SORTS[0]!;

  const listing = useQuery({
    queryKey: ['browse', kind, root, path, query, chosen.key, recursive],
    queryFn: () =>
      api.browseFolder({
        root,
        path,
        q: query,
        sort: chosen.sort,
        order: chosen.order,
        // Searching implies looking underneath: you know the name, not where it
        // ended up, which is the whole reason you are typing.
        recursive: recursive || query !== '',
        kind,
      }),
    // Favourites are a list Latent already holds; there is nothing to ask the
    // far machine for until one of them is opened.
    enabled: open && root !== '' && root !== FAVORITES,
    retry: false,
  });

  useEffect(() => {
    remembered.root = root;
    remembered.path = path;
    remembered.sort = sortKey;
    remembered.recursive = recursive;
  }, [root, path, sortKey, recursive]);

  const crumbs = useMemo(() => (path === '' ? [] : path.split('/')), [path]);
  const onFavorites = root === FAVORITES;
  const data: BrowseListing | undefined = listing.data;

  const pick = (reference: string) => {
    onPicked(reference);
    onClose();
  };

  /**
   * A favourite, turned into something the node can open.
   *
   * A favourite is a row in Latent's database; the slot holds a path on the
   * ComfyUI machine. The server works out which — the file where it already
   * lies when it is still there, a copy sent into `input` when it is not — so
   * this waits on one request rather than guessing. See the `/reference` route.
   */
  const [resolving, setResolving] = useState<string | null>(null);
  const [favoriteError, setFavoriteError] = useState<string | null>(null);

  /**
   * Ticking a favourite resolves it there and then.
   *
   * The alternative — remembering "favourite 3f2a" and working out its path at
   * the end — would mean the ticked list held two different kinds of thing, and
   * that a batch of six could fail after you had finished choosing it. Resolving
   * on the tick costs one request at the moment you can see it happening, and
   * keeps the list plain references throughout.
   *
   * Untidying is local: a resolved favourite is remembered against its id, so
   * unticking finds the same reference rather than asking again.
   */
  const [resolvedFavorites, setResolvedFavorites] = useState<Record<string, string>>({});

  const tickFavorite = async (favorite: Favorite) => {
    const known = resolvedFavorites[favorite.id];
    if (known) {
      setChecked((current) =>
        current.includes(known) ? current.filter((entry) => entry !== known) : [...current, known],
      );
      return;
    }

    setResolving(favorite.id);
    setFavoriteError(null);
    try {
      const { reference } = await api.favoriteReference(favorite.id);
      setResolvedFavorites((current) => ({ ...current, [favorite.id]: reference }));
      setChecked((current) =>
        current.includes(reference) ? current : [...current, reference],
      );
    } catch (cause) {
      setFavoriteError(
        cause instanceof Error ? cause.message : 'Could not open that favourite here',
      );
    } finally {
      setResolving(null);
    }
  };

  /** The favourites whose resolved reference is in the list, by id. */
  const tickedFavorites = useMemo(
    () =>
      new Set(
        Object.entries(resolvedFavorites)
          .filter(([, reference]) => ticked.has(reference))
          .map(([id]) => id),
      ),
    [resolvedFavorites, ticked],
  );

  const pickFavorite = async (favorite: Favorite) => {
    setResolving(favorite.id);
    setFavoriteError(null);
    try {
      const { reference } = await api.favoriteReference(favorite.id);
      pick(reference);
    } catch (cause) {
      setFavoriteError(
        cause instanceof Error ? cause.message : 'Could not open that favourite here',
      );
    } finally {
      setResolving(null);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title="Pick a picture" closeLabel="Cancel" full>
      <div className="space-y-3">
        {/* Named, because the breadcrumb underneath repeats the root's name as
            a button too — they are the same word doing two different jobs. */}
        <div data-testid="browse-categories" className="flex flex-wrap gap-1.5">
          {roots.data?.roots.map((entry) => (
            <button
              key={entry.key}
              type="button"
              onClick={() => {
                setRoot(entry.key);
                setPath('');
              }}
              className={cn(
                'rounded-full border px-3 py-1 text-xs',
                entry.key === root
                  ? 'border-accent bg-accent/20 text-accent'
                  : 'border-line text-muted',
              )}
            >
              {entry.key}
            </button>
          ))}
          {/*
            Always here, beside the real roots, even with nothing in it.
            A category that only appears once you have used it cannot teach you
            that it exists: the star on every row is the way in, and this chip is
            what tells you where the starred things went. Empty, it says so.
          */}
          <button
            type="button"
            onClick={() => {
              setRoot(FAVORITES);
              setPath('');
            }}
            className={cn(
              'rounded-full border px-3 py-1 text-xs',
              onFavorites ? 'border-accent bg-accent/20 text-accent' : 'border-line text-muted',
            )}
          >
            ★ Favourites
          </button>
        </div>

        {!onFavorites && (
          <input
            type="search"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            placeholder="Search this folder and everything under it"
            aria-label="Search"
            className="w-full rounded-xl border border-line bg-surface px-4 py-2.5 text-sm focus:border-accent focus:outline-none"
          />
        )}

        <div className={cn('flex flex-wrap items-center gap-2', onFavorites && 'hidden')}>
          <select
            value={sortKey}
            onChange={(event) => setSortKey(event.target.value)}
            aria-label="Sort"
            className="rounded-xl border border-line bg-surface px-3 py-1.5 text-xs"
          >
            {SORTS.map((entry) => (
              <option key={entry.key} value={entry.key}>
                {entry.label}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-1.5 text-xs text-muted">
            <input
              type="checkbox"
              checked={recursive}
              onChange={(event) => setRecursive(event.target.checked)}
            />
            Include subfolders
          </label>
        </div>

        {/* Breadcrumbs. Tapping one goes back to it, which is the only way up. */}
        {!onFavorites && (
          <div className="flex flex-wrap items-center gap-1 text-xs text-muted">
            <button type="button" onClick={() => setPath('')} className="underline">
              {root || '…'}
            </button>
            {crumbs.map((crumb, index) => (
              <span key={`${crumb}-${index}`} className="flex items-center gap-1">
                <span aria-hidden>/</span>
                <button
                  type="button"
                  onClick={() => setPath(crumbs.slice(0, index + 1).join('/'))}
                  className="underline"
                >
                  {crumb}
                </button>
              </span>
            ))}
          </div>
        )}

        {onFavorites && (
          <>
            <ErrorNote>{favoriteError}</ErrorNote>
            <GalleryFavorites
              favorites={favorites}
              loading={galleryFavorites.isLoading}
              hidden={(galleryFavorites.data ?? []).length - favorites.length}
              kind={kind}
              resolving={resolving}
              ticked={multiple ? tickedFavorites : null}
              onTick={(favorite) => void tickFavorite(favorite)}
              onPick={(favorite) => void pickFavorite(favorite)}
            />
          </>
        )}

        {listing.isError && (
          <ErrorNote>
            {listing.error instanceof Error ? listing.error.message : 'Could not read that folder'}
          </ErrorNote>
        )}

        {listing.isPending && root !== '' && (
          <div className="grid place-items-center py-8">
            <Spinner className="size-6 text-muted" />
          </div>
        )}

        {data && (
          <>
            {data.folders.length > 0 && !query && (
              <ul className="space-y-1">
                {data.folders.map((folder) => (
                  <li key={folder.path}>
                    <FolderRow name={folder.name} onOpen={() => setPath(folder.path)} />
                  </li>
                ))}
              </ul>
            )}

            {data.files.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted">
                {query ? 'Nothing here matches that.' : 'No pictures in this folder.'}
              </p>
            ) : (
              <div className={cn('gap-1.5', kind === 'image' ? 'grid grid-cols-3' : 'space-y-1')}>
                {data.files.map((file) => (
                  <FileEntry
                    key={file.path}
                    reference={refOf(root, file)}
                    name={file.name}
                    kind={kind}
                    ticked={multiple ? ticked.has(refOf(root, file)) : null}
                    onTick={() => tick(refOf(root, file))}
                    onPick={() => pick(refOf(root, file))}
                  />
                ))}
              </div>
            )}

            {data.truncated && (
              <p className="text-center text-xs text-muted">
                Showing the first {data.files.length} of {data.total}. Narrow the search.
              </p>
            )}
          </>
        )}

        {/*
          The way out of a batch, and only once there is one.

          Nothing about this sheet changes until the first box is ticked — the
          bar appears then, and it is the only thing that makes the sheet
          behave differently from the one-picture sheet it has always been.
          That is the whole design: picking one picture is tapping one picture,
          and a batch is the thing you have to opt into a tick at a time.

          Sticky to the bottom of the sheet's own scroll, because ticking the
          twelfth picture happens a long way down a folder and walking back up
          to a button at the top would be the point at which somebody gives up.
        */}
        {multiple && checked.length > 0 && (
          <div className="sticky bottom-0 -mx-1 flex items-center gap-2 border-t border-line bg-surface/95 px-1 py-2 backdrop-blur">
            <span className="min-w-0 flex-1 text-xs text-muted">
              {checked.length} ticked — one per run, then back to the first.
            </span>
            <button
              type="button"
              onClick={() => setChecked([])}
              className="shrink-0 px-2 py-1.5 text-xs text-muted"
            >
              Clear
            </button>
            <button
              type="button"
              onClick={() => {
                onBatch?.(checked);
                onClose();
              }}
              className="shrink-0 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white"
            >
              Use {checked.length}
            </button>
          </div>
        )}
      </div>
    </Sheet>
  );
}

function FolderRow({ name, onOpen }: { name: string; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full min-w-0 items-center gap-2 rounded-xl border border-line px-3 py-2 text-left text-sm active:bg-surface-2"
    >
      <span aria-hidden>📁</span>
      <span className="min-w-0 flex-1 truncate">{name}</span>
      <span aria-hidden className="text-muted">
        ›
      </span>
    </button>
  );
}

/**
 * One pickable file: a thumbnail for a picture, a labelled row for anything else.
 *
 * Two gestures, and keeping them apart is what lets a batch exist without a
 * mode. Tapping the picture picks that picture and shuts the sheet, which is
 * what it has always done and what you want nearly every time. Tapping the box
 * in its corner adds it to the list instead and leaves the sheet open, so
 * ticking six is six taps in one place.
 */
function FileEntry({
  reference,
  name,
  kind,
  ticked,
  onTick,
  onPick,
}: {
  reference: string;
  name: string;
  kind: 'image' | 'video' | 'audio';
  /** `null` for a slot that takes one picture, which draws no box at all. */
  ticked: boolean | null;
  onTick: () => void;
  onPick: () => void;
}) {
  if (kind !== 'image') {
    return (
      <div className="flex items-center gap-1 rounded-xl border border-line pr-2">
        <button
          type="button"
          onClick={onPick}
          className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left text-sm active:bg-surface-2"
        >
          <span aria-hidden>{kind === 'video' ? '🎞' : '🔊'}</span>
          <span className="min-w-0 flex-1 truncate">{name}</span>
        </button>
        {ticked !== null && <TickBox on={ticked} name={name} onClick={onTick} />}
      </div>
    );
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={onPick}
        title={reference}
        className={cn(
          'block aspect-square w-full overflow-hidden rounded-lg border bg-surface-2 active:border-accent',
          ticked ? 'border-accent ring-2 ring-accent/50' : 'border-line',
        )}
      >
        <img
          src={browseThumbUrl(reference)}
          alt={name}
          loading="lazy"
          className="size-full object-cover"
          onError={(event) => {
            // A picture Pillow cannot open is a broken file, not a broken
            // browser: leave the cell blank and carry on.
            event.currentTarget.style.visibility = 'hidden';
          }}
        />
      </button>
      {ticked !== null && (
        <span className="absolute top-0.5 right-0.5">
          <TickBox on={ticked} name={name} onClick={onTick} />
        </span>
      )}
    </div>
  );
}

/**
 * The box that adds a picture to the list, beside the tile rather than on it.
 *
 * A sibling of the button that picks the entry, never a child of it: a button
 * inside a button is invalid, and the browsers that render it anyway disagree
 * about which one a tap belongs to. `stopPropagation` covers the thumbnail,
 * where the box is laid over the picture and a tap would otherwise pick it.
 *
 * Its own dark disc because a tick drawn straight onto a photograph is
 * invisible half the time, and the half it is invisible in is not predictable.
 */
function TickBox({ on, name, onClick }: { on: boolean; name: string; onClick: () => void }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={on}
      aria-label={`Add ${name} to the batch`}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className={cn(
        'grid size-5 place-items-center rounded-md border text-[11px] leading-none',
        on ? 'border-accent bg-accent text-white' : 'border-line bg-ink/70 text-transparent',
      )}
    >
      ✓
    </button>
  );
}

/**
 * The gallery's favourites, as somewhere to pick from.
 *
 * Deliberately flat, and deliberately not a folder browser. Everything else in
 * this sheet is about *finding* a file — breadcrumbs, sorting, a search that
 * walks a month of renders — because that is the problem when the picture you
 * want is one of nine thousand in `output`. None of that applies here: the
 * whole point of a favourite is that you already found it, and a list of forty
 * pictures newest-first is a list you read rather than navigate.
 *
 * The thumbnails come from Latent's own copies rather than from the ComfyUI
 * machine. That is what lets the list keep working when the instance that made
 * them has been destroyed — which is the case favouriting exists for, and the
 * case where a folder browser has nothing left to show.
 */
function GalleryFavorites({
  favorites,
  loading,
  hidden,
  kind,
  resolving,
  ticked,
  onTick,
  onPick,
}: {
  favorites: (Favorite & { image: NonNullable<Favorite['image']> })[];
  loading: boolean;
  /** Kept, but the wrong sort of media for this slot. See below. */
  hidden: number;
  kind: 'image' | 'video' | 'audio';
  /** The id of the one being resolved, while the server works out its path. */
  resolving: string | null;
  /**
   * Which favourites are in the list, by id, or `null` for a one-picture slot.
   *
   * Ids rather than references because that is what this list is drawn from.
   * The parent keeps the mapping — a favourite only *has* a reference once the
   * server has been asked for one — and hands down the answer, so an
   * unresolved favourite is simply not ticked, which is also exactly true.
   */
  ticked: Set<string> | null;
  onTick: (favorite: Favorite) => void;
  onPick: (favorite: Favorite) => void;
}) {
  if (loading) {
    return (
      <div className="grid place-items-center py-8">
        <Spinner className="size-6 text-muted" />
      </div>
    );
  }

  if (favorites.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-muted">
        {hidden > 0
          ? `Nothing in your favourites fits this slot. The other ${hidden} ${
              hidden === 1 ? 'is' : 'are'
            } the wrong sort of file for it.`
          : 'Nothing in your favourites yet. Open a result in the gallery and tap Favourite, and it will be waiting here.'}
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className={cn('gap-1.5', kind === 'image' ? 'grid grid-cols-3' : 'space-y-1')}>
        {favorites.map((favorite) => (
          <FavoriteEntry
            key={favorite.id}
            favorite={favorite}
            kind={kind}
            busy={resolving === favorite.id}
            ticked={ticked}
            onTick={() => onTick(favorite)}
            onPick={() => onPick(favorite)}
          />
        ))}
      </div>

      {/*
        Said rather than silently dropped. A clip is not offered in a picture
        slot — the node would refuse it — but a favourite that is simply absent
        reads as a favourite that was lost.
      */}
      {hidden > 0 && (
        <p className="text-center text-xs text-muted">
          {hidden} more kept, {hidden === 1 ? 'but it is' : 'but they are'} the wrong sort of file
          for this slot.
        </p>
      )}
    </div>
  );
}

/** One favourite, drawn the way the folder listing draws one of its files. */
function FavoriteEntry({
  favorite,
  kind,
  busy,
  ticked,
  onTick,
  onPick,
}: {
  favorite: Favorite & { image: NonNullable<Favorite['image']> };
  kind: 'image' | 'video' | 'audio';
  busy: boolean;
  /** Ticked favourites by id; `null` when this slot takes one picture. */
  ticked: Set<string> | null;
  onTick: () => void;
  onPick: () => void;
}) {
  const name = favorite.title || favorite.image.filename;
  const on = ticked === null ? null : ticked.has(favorite.id);

  if (kind !== 'image') {
    return (
      <div className="flex items-center gap-1 rounded-xl border border-line pr-2">
        <button
          type="button"
          disabled={busy}
          onClick={onPick}
          className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left text-sm active:bg-surface-2"
        >
          <span aria-hidden>{kind === 'video' ? '🎞' : '🔊'}</span>
          <span className="min-w-0 flex-1 truncate">{name}</span>
          {busy && <Spinner className="size-4 shrink-0 text-muted" />}
        </button>
        {on !== null && <TickBox on={on} name={name} onClick={onTick} />}
      </div>
    );
  }

  return (
    <div className="relative">
      <button
        type="button"
        disabled={busy}
        onClick={onPick}
        title={name}
        className={cn(
          'block aspect-square w-full overflow-hidden rounded-lg border bg-surface-2 active:border-accent',
          on ? 'border-accent ring-2 ring-accent/50' : 'border-line',
        )}
      >
        <img
          src={thumbnailUrl(favorite.image)}
          alt={name}
          loading="lazy"
          className="size-full object-cover"
          onError={(event) => {
            event.currentTarget.style.visibility = 'hidden';
          }}
        />
      </button>

      {/*
        Marked while the picture is only borrowed.

        A favourite whose bytes were never copied here can still be picked —
        the server falls back to the file where it lies — but it is the one
        that will stop working the day the instance goes away, and saying so
        here is saying so at the moment somebody is relying on it.
      */}
      {!favorite.archived && (
        <span
          title="Not stored here yet"
          className="pointer-events-none absolute top-0.5 left-0.5 rounded-md bg-ink/70 px-1 text-[10px] text-warn"
        >
          ⚠
        </span>
      )}

      {favorite.rating > 0 && (
        <span className="pointer-events-none absolute bottom-0.5 left-0.5 rounded-md bg-ink/70 px-1 text-[10px] text-warn">
          {'★'.repeat(favorite.rating)}
        </span>
      )}

      {on !== null && (
        <span className="absolute top-0.5 right-0.5">
          <TickBox on={on} name={name} onClick={onTick} />
        </span>
      )}

      {busy && (
        <span className="absolute inset-0 grid place-items-center rounded-lg bg-ink/60">
          <Spinner className="size-5 text-white" />
        </span>
      )}
    </div>
  );
}
