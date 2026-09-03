import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import type { BrowseEntry, BrowseListing } from '@latent/shared';

import { api, browseThumbUrl } from '../api/client';
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
    enabled: open && root !== '',
    retry: false,
  });

  useEffect(() => {
    remembered.root = root;
    remembered.path = path;
    remembered.sort = sortKey;
    remembered.recursive = recursive;
  }, [root, path, sortKey, recursive]);

  const crumbs = useMemo(() => (path === '' ? [] : path.split('/')), [path]);
  const data: BrowseListing | undefined = listing.data;

  const pick = (file: BrowseEntry) => {
    onPicked(`${root}/${file.path}`);
    onClose();
  };

  return (
    <Sheet open={open} onClose={onClose} title="Pick a picture" closeLabel="Cancel" full>
      <div className="space-y-3">
        {(roots.data?.roots.length ?? 0) > 1 && (
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
          </div>
        )}

        <input
          type="search"
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          placeholder="Search this folder and everything under it"
          aria-label="Search"
          className="w-full rounded-xl border border-line bg-surface px-4 py-2.5 text-sm focus:border-accent focus:outline-none"
        />

        <div className="flex flex-wrap items-center gap-2">
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
                    <button
                      type="button"
                      onClick={() => setPath(folder.path)}
                      className="flex w-full items-center gap-2 rounded-xl border border-line px-3 py-2 text-left text-sm active:bg-surface-2"
                    >
                      <span aria-hidden>📁</span>
                      <span className="min-w-0 flex-1 truncate">{folder.name}</span>
                      <span aria-hidden className="text-muted">
                        ›
                      </span>
                    </button>
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
                {data.files.map((file) =>
                  kind === 'image' ? (
                    <button
                      key={file.path}
                      type="button"
                      onClick={() => pick(file)}
                      title={file.path}
                      className="aspect-square overflow-hidden rounded-lg border border-line bg-surface-2 active:border-accent"
                    >
                      <img
                        src={browseThumbUrl(`${root}/${file.path}`)}
                        alt={file.name}
                        loading="lazy"
                        className="size-full object-cover"
                        onError={(event) => {
                          // A picture Pillow cannot open is a broken file, not a
                          // broken browser: leave the cell blank and carry on.
                          event.currentTarget.style.visibility = 'hidden';
                        }}
                      />
                    </button>
                  ) : (
                    /* Nothing to show for a clip or a sound, so say what it is. */
                    <button
                      key={file.path}
                      type="button"
                      onClick={() => pick(file)}
                      className="flex w-full items-center gap-2 rounded-xl border border-line px-3 py-2 text-left text-sm active:bg-surface-2"
                    >
                      <span aria-hidden>{kind === 'video' ? '🎞' : '🔊'}</span>
                      <span className="min-w-0 flex-1 truncate">{file.name}</span>
                    </button>
                  ),
                )}
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
