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

  // Only scanned when the sheet is actually open — the folder can be large.
  const scan = useQuery({ queryKey: ['input-images'], queryFn: api.inputImages, enabled: open });

  const files = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const all = scan.data?.files ?? [];
    return needle ? all.filter((file: InputImage) => file.path.toLowerCase().includes(needle)) : all;
  }, [filter, scan.data]);

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
                  : `Nothing matches “${filter}”.`}
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
