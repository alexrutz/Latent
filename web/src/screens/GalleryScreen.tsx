import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import type { GenerationRecord } from '@latent/shared';

import { api, imageUrl } from '../api/client';
import { useGallery, useSettings, useWorkflows } from '../api/queries';
import { ImageViewer, Thumb } from '../components/ImageViewer';
import { Button, cn, EmptyState, ErrorNote, Sheet, Spinner } from '../components/ui';
import { usePendingStore } from '../state/pending';

export function GalleryScreen() {
  const gallery = useGallery();
  const [selected, setSelected] = useState<{ record: GenerationRecord; index: number } | null>(null);
  const sentinel = useRef<HTMLDivElement>(null);

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

  // The open record must track live updates, or a still-running generation
  // would never gain its images while the viewer is open.
  const openRecord = selected ? (items.find((item) => item.id === selected.record.id) ?? selected.record) : null;

  if (gallery.isLoading) {
    return (
      <div className="grid h-full place-items-center">
        <Spinner className="size-6 text-muted" />
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <EmptyState
        icon="▦"
        title="Nothing generated yet"
        hint="Results appear here as soon as a run finishes."
      />
    );
  }

  return (
    <div className="safe-t px-4 pt-3 pb-6">
      <h1 className="mb-3 text-xl font-semibold">Gallery</h1>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {items.map((record) =>
          record.images.length > 0 ? (
            record.images.map((image, imageIndex) => (
              <Thumb
                key={`${record.id}-${image.filename}`}
                image={image}
                alt={record.title}
                onClick={() => setSelected({ record, index: imageIndex })}
              />
            ))
          ) : (
            <PlaceholderCard key={record.id} record={record} />
          ),
        )}
      </div>

      <div ref={sentinel} className="h-8" />
      {gallery.isFetchingNextPage && (
        <div className="grid place-items-center py-4">
          <Spinner className="size-5 text-muted" />
        </div>
      )}

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
          <div className="no-scrollbar flex gap-2 overflow-x-auto [&>button]:shrink-0 [&>button]:whitespace-nowrap">
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
