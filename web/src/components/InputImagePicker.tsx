import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';

import type { InputImage } from '@latent/shared';

import { api, inputImageUrl } from '../api/client';
import { BatchBar } from './BatchBar';
import { Button, cn, ErrorNote, Sheet, Spinner } from './ui';

/**
 * Which name each picture was copied into ComfyUI under, by its path here.
 *
 * A slot's batch holds the copies' names — `latent_<hash>_<name>`, taken from
 * the bytes — and nothing in a name says which file it came from. This dialog
 * kept that knowledge in its own state, which went when the sheet closed, so
 * reopening it showed every box empty while the slot was still working
 * through the list. Kept here instead, for the tab, and in the browser's
 * storage, so it outlives a reload; the cap keeps that small.
 */
const COPIES_KEY = 'latent-input-copies';
const COPIES_KEPT = 500;
const copies = new Map<string, string>(readCopies());

function readCopies(): [string, string][] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(COPIES_KEY) ?? '[]');
    return Array.isArray(parsed)
      ? parsed.filter(
          (entry): entry is [string, string] =>
            Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'string',
        )
      : [];
  } catch {
    return [];
  }
}

function rememberCopy(path: string, name: string): void {
  copies.delete(path);
  copies.set(path, name);
  while (copies.size > COPIES_KEPT) copies.delete(copies.keys().next().value!);
  try {
    localStorage.setItem(COPIES_KEY, JSON.stringify([...copies]));
  } catch {
    // Private mode, or full: the tab still remembers.
  }
}

/** Whether `entry` is a copy the server named `latent_<12 hex>_<key>`. */
function isCopyNamed(entry: string, key: string): boolean {
  const base = entry.slice(entry.lastIndexOf('/') + 1);
  const match = /^latent_[0-9a-f]{12}_(.+)$/.exec(base);
  return match?.[1] === key;
}

/** The part of a copy's name that came from the original, as the server writes it. */
function safeName(original: string): string {
  return (original || 'input.png').replace(/[^\w.-]+/g, '_').slice(-80);
}

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
  batch = [],
  onBatch,
  onEdit,
}: {
  open: boolean;
  onClose: () => void;
  /** A file already copied into ComfyUI's input directory. */
  onPicked: (filename: string) => void;
  /**
   * The list this slot is already working through, so reopening shows what is
   * ticked rather than starting from nothing.
   */
  batch?: string[];
  /**
   * Hand back a list rather than one picture. See `advanceBatch`.
   *
   * The folder browser next door has had this since it arrived and this dialog
   * did not, which made the feature depend on which *kind* of image node a
   * workflow happened to use — the two dialogs look alike and are reached by
   * the same button, so "tick several" working in one and not the other reads
   * as it being broken rather than absent.
   */
  onBatch?: (filenames: string[]) => void;
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

  /*
   * What is ticked, in the order it was ticked — which is the order the runs
   * will happen in. Seeded from the slot's list whenever the sheet opens, so
   * coming back to add one more shows the ones already in it.
   */
  const [checked, setChecked] = useState<string[]>(batch);
  useEffect(() => {
    // Only on the transition to open: `batch` changes when the ticking is
    // confirmed, and re-seeding on that would fight what it was just told.
    if (open) setChecked(batch);
  }, [open]);

  const multiple = Boolean(onBatch);
  const ticked = useMemo(() => new Set(checked), [checked]);

  /** Bumped when a copy is remembered, so the boxes redraw. */
  const [, setCopiedCount] = useState(copies.size);

  /**
   * Ticking holds the *uploaded* name, not the path in the input folder.
   *
   * A slot's value is what ComfyUI will be asked to load, and for this dialog
   * that is a filename inside ComfyUI's input directory — which only exists
   * once the file has been copied there. So a tick copies it, exactly as
   * picking one does, and remembers what came back.
   */
  const tick = async (file: InputImage) => {
    const known = copyOf(file);
    if (known) {
      setChecked((current) =>
        current.includes(known) ? current.filter((entry) => entry !== known) : [...current, known],
      );
      return;
    }

    setBusy(file.path);
    setError(null);
    try {
      const result = await api.useInputImage(file.path);
      const name = result.subfolder ? `${result.subfolder}/${result.name}` : result.name;
      rememberCopy(file.path, name);
      setCopiedCount(copies.size);
      setChecked((current) => (current.includes(name) ? current : [...current, name]));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not use that image');
    } finally {
      setBusy(null);
    }
  };


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

  /*
   * The copy a file stands for in the batch, when it is known.
   *
   * Remembered when this browser made the copy. Otherwise read off the name:
   * a copy ends in the original's name, which identifies the file when it is
   * the only one in the folder called that — and only then, because ticking
   * the wrong one of two `portrait.png`s would be worse than ticking neither.
   */
  const byName = useMemo(() => {
    const counts = new Map<string, number>();
    for (const file of scan.data?.files ?? []) {
      const key = safeName(file.name);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [scan.data]);

  const copyOf = (file: InputImage): string | undefined => {
    const remembered = copies.get(file.path);
    if (remembered) return remembered;
    const key = safeName(file.name);
    if (byName.get(key) !== 1) return undefined;
    return checked.find((entry) => isCopyNamed(entry, key));
  };

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
                // Positioned, so the tick box sits on this tile and not on the
                // corner of whichever ancestor happened to be.
                <li key={file.path} className="relative space-y-1">
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

                  {/*
                    Two gestures, kept apart, which is what lets a batch exist
                    without a mode: tapping the picture picks that picture and
                    shuts the sheet, ticking the box adds it to the list and
                    leaves the sheet open.

                    A sibling of the picture button rather than a child of it —
                    a button inside a button is invalid, and the browsers that
                    render it anyway disagree about which one a tap belongs to.
                  */}
                  {multiple && (
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={ticked.has(copyOf(file) ?? '')}
                      aria-label={`Add ${file.name} to the batch`}
                      disabled={busy !== null}
                      onClick={() => void tick(file)}
                      className={cn(
                        'absolute top-1 right-1 grid size-6 place-items-center rounded-md border text-xs leading-none',
                        ticked.has(copyOf(file) ?? '')
                          ? 'border-accent bg-accent text-white'
                          : 'border-line bg-ink/70 text-transparent',
                      )}
                    >
                      ✓
                    </button>
                  )}

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

        {multiple && (
          <BatchBar
            checked={checked}
            batch={batch}
            onChange={(list) => {
              setChecked(list);
              onBatch?.(list);
            }}
            onClose={onClose}
          />
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
