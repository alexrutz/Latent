import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import type { BrowseFavorite, BrowseListing } from '@latent/shared';
import { favoritesFor, nameOfRef, splitRef, toggleFavorite } from '@latent/shared';

import { api, browseThumbUrl } from '../api/client';
import { useSettings, useUpdateSettings } from '../api/queries';
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
 * The pseudo-root the starred entries live under.
 *
 * A category beside `output` and `input` rather than a mode of its own, because
 * that is what it is to whoever is looking: another place the picture might be.
 * It is not a folder on the far machine, so it never reaches the browse routes
 * — the name only has to be something no real root is called.
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
  kind = 'image',
}: {
  open: boolean;
  onClose: () => void;
  /** The chosen reference, as `root/relative/path.png`. */
  onPicked: (reference: string) => void;
  /** What this slot can use. A video slot has no business listing pictures. */
  kind?: 'image' | 'video' | 'audio';
}) {
  const [root, setRoot] = useState(remembered.root);
  const [path, setPath] = useState(remembered.path);
  const [sortKey, setSortKey] = useState(remembered.sort);
  const [recursive, setRecursive] = useState(remembered.recursive);
  const [typed, setTyped] = useState('');
  const [query, setQuery] = useState('');

  const roots = useQuery({ queryKey: ['browse-roots'], queryFn: api.browseRoots, enabled: open });

  const settings = useSettings();
  const updateSettings = useUpdateSettings();

  // Only the starred entries this slot could actually use.
  const favorites = useMemo(
    () => favoritesFor(settings.data?.browseFavorites ?? [], kind),
    [settings.data, kind],
  );
  const starred = useMemo(() => new Set(favorites.map((entry) => entry.ref)), [favorites]);

  const toggleStar = (ref: string, entryKind: BrowseFavorite['kind']) => {
    // Toggled against the whole list, not the filtered view: a picture slot
    // must not drop the starred clips it is not showing.
    const all = settings.data?.browseFavorites ?? [];
    updateSettings.mutate({ browseFavorites: toggleFavorite(all, ref, entryKind, Date.now()) });
  };

  // The first root is the one to open on: comfyllama offers `output` first,
  // which is what somebody looking for a render wants.
  useEffect(() => {
    const first = roots.data?.roots[0]?.key;
    if (!root && first) setRoot(first);
  }, [roots.data, root]);

  /*
   * Starring the last favourite away while looking at them leaves nowhere to
   * be, so fall back to the first real root rather than an empty category.
   */
  useEffect(() => {
    if (root === FAVORITES && settings.isSuccess && favorites.length === 0) {
      setRoot(roots.data?.roots[0]?.key ?? '');
      setPath('');
    }
  }, [root, favorites.length, settings.isSuccess, roots.data]);

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
  /** The folder currently open, as a reference. A root is bare, with no slash. */
  const hereRef = path === '' ? root : `${root}/${path}`;
  const data: BrowseListing | undefined = listing.data;

  const pick = (reference: string) => {
    onPicked(reference);
    onClose();
  };

  /** Open a starred folder where it actually lives, in its own root. */
  const openFavorite = (ref: string) => {
    const { root: inRoot, path: within } = splitRef(ref);
    setRoot(inRoot);
    setPath(within);
  };

  return (
    <Sheet open={open} onClose={onClose} title="Pick a picture" closeLabel="Cancel" full>
      <div className="space-y-3">
        <div className="flex flex-wrap gap-1.5">
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
          {/* Last, and only once there is something in it: an empty category
              you can select is a dead end that has to be backed out of. */}
          {favorites.length > 0 && (
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
          )}
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
            {/*
              Starring the folder you are in, rather than each picture in it:
              a series worked on over a week is a folder you come back to, and
              one star saves the walk down to it every time.
            */}
            {root !== '' && (
              <Star
                on={starred.has(hereRef)}
                onClick={() => toggleStar(hereRef, 'folder')}
                label={`Keep ${path || root} in favourites`}
              />
            )}
          </div>
        )}

        {onFavorites && (
          <FavoriteList
            favorites={favorites}
            kind={kind}
            starred={starred}
            onToggle={toggleStar}
            onOpen={openFavorite}
            onPick={pick}
          />
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
                    <FolderRow
                      name={folder.name}
                      onOpen={() => setPath(folder.path)}
                      starred={starred.has(refOf(root, folder))}
                      onToggle={() => toggleStar(refOf(root, folder), 'folder')}
                    />
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
                    starred={starred.has(refOf(root, file))}
                    onToggle={() => toggleStar(refOf(root, file), 'file')}
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
      </div>
    </Sheet>
  );
}

/**
 * The star, beside a thing rather than on it.
 *
 * A sibling of the button that opens or picks the entry, never a child of it:
 * a button inside a button is invalid, and the browsers that do render it
 * disagree about which one a tap belongs to. `stopPropagation` covers the tile,
 * where the star is laid over the picture and a tap would otherwise pick it.
 */
function Star({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={label}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className={cn('shrink-0 px-1 text-sm leading-none', on ? 'text-accent' : 'text-muted')}
    >
      {on ? '★' : '☆'}
    </button>
  );
}

function FolderRow({
  name,
  onOpen,
  starred,
  onToggle,
}: {
  name: string;
  onOpen: () => void;
  starred: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="flex items-center gap-1 rounded-xl border border-line pr-2">
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left text-sm active:bg-surface-2"
      >
        <span aria-hidden>📁</span>
        <span className="min-w-0 flex-1 truncate">{name}</span>
        <span aria-hidden className="text-muted">
          ›
        </span>
      </button>
      <Star on={starred} onClick={onToggle} label={`Keep ${name} in favourites`} />
    </div>
  );
}

/** One pickable file: a thumbnail for a picture, a labelled row for anything else. */
function FileEntry({
  reference,
  name,
  kind,
  starred,
  onToggle,
  onPick,
}: {
  reference: string;
  name: string;
  kind: 'image' | 'video' | 'audio';
  starred: boolean;
  onToggle: () => void;
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
        <Star on={starred} onClick={onToggle} label={`Keep ${name} in favourites`} />
      </div>
    );
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={onPick}
        title={reference}
        className="block aspect-square w-full overflow-hidden rounded-lg border border-line bg-surface-2 active:border-accent"
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
      {/* Over the corner of the thumbnail, on its own dark disc, because a
          star drawn straight onto a photograph is invisible half the time. */}
      <span className="absolute top-0.5 right-0.5 rounded-full bg-ink/70">
        <Star on={starred} onClick={onToggle} label={`Keep ${name} in favourites`} />
      </span>
    </div>
  );
}

/**
 * The starred entries, as their own listing.
 *
 * Folders first and then pictures, which is the order the real listing uses —
 * the category is meant to feel like another folder, not a different screen.
 * Nothing here is fetched: the references are already in the settings, and a
 * thumbnail is a URL built from one.
 */
function FavoriteList({
  favorites,
  kind,
  starred,
  onToggle,
  onOpen,
  onPick,
}: {
  favorites: BrowseFavorite[];
  kind: 'image' | 'video' | 'audio';
  starred: Set<string>;
  onToggle: (ref: string, kind: BrowseFavorite['kind']) => void;
  onOpen: (ref: string) => void;
  onPick: (ref: string) => void;
}) {
  const folders = favorites.filter((entry) => entry.kind === 'folder');
  const files = favorites.filter((entry) => entry.kind === 'file');

  return (
    <div className="space-y-3">
      {folders.length > 0 && (
        <ul className="space-y-1">
          {folders.map((entry) => (
            <li key={entry.ref}>
              <FolderRow
                name={entry.ref}
                onOpen={() => onOpen(entry.ref)}
                starred={starred.has(entry.ref)}
                onToggle={() => onToggle(entry.ref, 'folder')}
              />
            </li>
          ))}
        </ul>
      )}

      {files.length > 0 && (
        <div className={cn('gap-1.5', kind === 'image' ? 'grid grid-cols-3' : 'space-y-1')}>
          {files.map((entry) => (
            <FileEntry
              key={entry.ref}
              reference={entry.ref}
              name={nameOfRef(entry.ref)}
              kind={kind}
              starred={starred.has(entry.ref)}
              onToggle={() => onToggle(entry.ref, 'file')}
              onPick={() => onPick(entry.ref)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
