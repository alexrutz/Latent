import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';

import type { InputImage } from '@latent/shared';

import { api, inputImageUrl } from '../api/client';
import { Button, ErrorNote, Sheet, Spinner } from './ui';

/**
 * Choose a picture from the folder of inputs on the Latent machine.
 *
 * Two ways out, and the difference matters on mobile data:
 *
 * - **Use** copies the file into ComfyUI server-side. The bytes never touch the
 *   phone, so picking a 12 MP photo costs one small request.
 * - **Edit** pulls the original down so it can be cropped and straightened
 *   first. Only worth the download when you actually intend to change something,
 *   so it is the secondary action rather than the default.
 */
export function InputImagePicker({
  open,
  onClose,
  onPicked,
  onEdit,
}: {
  open: boolean;
  onClose: () => void;
  /** A file already copied into ComfyUI's input directory. */
  onPicked: (filename: string) => void;
  /** The user wants to edit this one first; the caller fetches and opens it. */
  onEdit: (image: InputImage) => void;
}) {
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * Which folder is open, as a relative path. Empty is the root.
   *
   * A reference library is not a heap: sketches, masks, photographs of the same
   * subject belong apart, and the folders they are already in on disk are the
   * categorisation — there is no reason to invent a second one inside Latent.
   */
  const [folder, setFolder] = useState('');

  // Only scanned when the sheet is actually open — the folder can be large.
  const scan = useQuery({ queryKey: ['input-images'], queryFn: api.inputImages, enabled: open });

  /*
   * Filtering searches the whole tree, browsing shows one level.
   *
   * Those are different questions — "where is the picture called sketch-3" and
   * "what is in this folder" — and answering the first one inside the current
   * folder only would mean navigating to find something you already named.
   */
  const searching = filter.trim() !== '';

  const files = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const all = scan.data?.files ?? [];
    if (needle) return all.filter((file: InputImage) => file.path.toLowerCase().includes(needle));
    const prefix = folder ? `${folder}/` : '';
    return all.filter(
      (file: InputImage) =>
        file.path.startsWith(prefix) && !file.path.slice(prefix.length).includes('/'),
    );
  }, [filter, folder, scan.data]);

  /** Immediate subfolders of the open one, with how much is under each. */
  const folders = useMemo(() => {
    if (searching) return [];
    const prefix = folder ? `${folder}/` : '';
    const counts = new Map<string, number>();
    for (const file of scan.data?.files ?? []) {
      if (!file.path.startsWith(prefix)) continue;
      const rest = file.path.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 0) continue;
      const name = rest.slice(0, slash);
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([name, images]) => ({ name, images }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [folder, scan.data, searching]);

  const crumbs = folder ? folder.split('/') : [];

  const use = async (file: InputImage) => {
    setBusy(file.path);
    setError(null);
    try {
      const result = await api.useInputImage(file.path);
      onPicked(result.subfolder ? `${result.subfolder}/${result.name}` : result.name);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not use that image');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title="From the input folder" full>
      <div className="space-y-3">
        {scan.isLoading && (
          <div className="grid place-items-center py-10">
            <Spinner className="size-6 text-muted" />
          </div>
        )}

        {scan.data && !scan.data.ok && (
          <div className="space-y-1">
            <p className="text-sm text-warn">{scan.data.message}</p>
            <p className="text-xs text-muted">
              Set the path under Settings → Input images.
            </p>
          </div>
        )}

        {scan.data?.ok && (
          <>
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted">
                {files.length} image{files.length === 1 ? '' : 's'}
                {searching ? ' matching' : folder ? ` in ${folder}` : ''}
                {scan.data.truncated && ' (first 2000)'}
              </span>
            </div>

            <input
              type="search"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Filter by name…"
              className="w-full rounded-xl border border-line bg-surface px-3 py-2 focus:border-accent focus:outline-none"
            />

            <ErrorNote>{error}</ErrorNote>

            {/* Where you are, as something tappable. */}
            {!searching && crumbs.length > 0 && (
              <div className="flex flex-wrap items-center gap-1 text-xs">
                <button type="button" onClick={() => setFolder('')} className="text-accent">
                  all
                </button>
                {crumbs.map((crumb, index) => (
                  <span key={`${crumb}-${index}`} className="flex items-center gap-1">
                    <span aria-hidden className="text-muted">
                      ›
                    </span>
                    <button
                      type="button"
                      onClick={() => setFolder(crumbs.slice(0, index + 1).join('/'))}
                      className={index === crumbs.length - 1 ? 'text-body' : 'text-accent'}
                    >
                      {crumb}
                    </button>
                  </span>
                ))}
              </div>
            )}

            {folders.length > 0 && (
              <ul className="grid grid-cols-2 gap-1.5">
                {folders.map((entry) => (
                  <li key={entry.name}>
                    <button
                      type="button"
                      onClick={() => setFolder(folder ? `${folder}/${entry.name}` : entry.name)}
                      className="flex w-full items-center justify-between gap-2 rounded-lg border border-line bg-surface px-2.5 py-2 text-left text-xs active:bg-surface-2"
                    >
                      <span className="min-w-0 truncate">{entry.name}</span>
                      <span className="shrink-0 text-[10px] text-muted tabular-nums">
                        {entry.images}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <ul className="grid grid-cols-3 gap-2">
              {files.map((file: InputImage) => (
                <li key={file.path} className="space-y-1">
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => void use(file)}
                    title={file.path}
                    className="relative block aspect-square w-full overflow-hidden rounded-lg border border-line bg-surface-2 active:opacity-80"
                  >
                    {/* Small version only — a folder of camera photos would be
                        tens of megabytes to browse otherwise. */}
                    <img
                      src={inputImageUrl(file.path, true)}
                      alt={file.name}
                      loading="lazy"
                      decoding="async"
                      className="size-full object-cover"
                    />
                    {busy === file.path && (
                      <span className="absolute inset-0 grid place-items-center bg-black/60">
                        <Spinner className="size-5 text-white" />
                      </span>
                    )}
                  </button>

                  <div className="flex items-center justify-between gap-1">
                    <span className="min-w-0 truncate text-[10px] text-muted" title={file.path}>
                      {file.name}
                    </span>
                    <button
                      type="button"
                      onClick={() => onEdit(file)}
                      aria-label={`Edit ${file.name}`}
                      className="shrink-0 text-[10px] text-accent"
                    >
                      Edit
                    </button>
                  </div>
                </li>
              ))}
            </ul>

            {files.length === 0 && (
              <p className="py-6 text-center text-sm text-muted">
                {scan.data.files.length === 0
                  ? 'That folder holds no images.'
                  : searching
                    ? `Nothing matches “${filter}”.`
                    : folders.length > 0
                      ? 'Nothing here directly — open one of the folders above.'
                      : 'This folder is empty.'}
              </p>
            )}
          </>
        )}

        <div className="border-t border-line pt-3">
          <Button variant="ghost" className="w-full" onClick={() => void scan.refetch()}>
            Rescan the folder
          </Button>
        </div>
      </div>
    </Sheet>
  );
}
