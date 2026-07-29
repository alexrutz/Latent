import { useCallback, useEffect, useRef, useState } from 'react';

import { Button, cn, Sheet, Spinner } from './ui';

/**
 * Basic edits before a photo is uploaded.
 *
 * A camera roll picture is almost never the right shape for a workflow: it is
 * 4032×3024 when the graph wants 1024×1024, it is rotated the wrong way, and the
 * subject sits off to one side. Fixing that on the phone before the bytes ever
 * leave it saves an upload and a wasted render.
 *
 * Canvas only — no image library, and nothing leaves the device until Use.
 */

const ASPECTS: { label: string; value: number | null }[] = [
  { label: 'Free', value: null },
  { label: '1:1', value: 1 },
  { label: '4:3', value: 4 / 3 },
  { label: '3:4', value: 3 / 4 },
  { label: '16:9', value: 16 / 9 },
  { label: '9:16', value: 9 / 16 },
];

/** Longest edge of the produced file. Beyond this is wasted on a sampler. */
const MAX_OUTPUT = 2048;

interface Crop {
  /** Fractions of the rotated image, 0..1. */
  x: number;
  y: number;
  width: number;
  height: number;
}

const FULL_CROP: Crop = { x: 0, y: 0, width: 1, height: 1 };

/**
 * Draw the source rotated and mirrored into a canvas of the resulting size.
 *
 * Doing this as its own step is what keeps the maths honest: everything
 * afterwards — the preview, the crop, the export — works on an upright image, so
 * there is no sign-juggling per rotation case.
 */
function renderStage(
  source: HTMLImageElement,
  rotation: number,
  flipH: boolean,
): HTMLCanvasElement {
  const swap = rotation % 180 !== 0;
  const width = swap ? source.naturalHeight : source.naturalWidth;
  const height = swap ? source.naturalWidth : source.naturalHeight;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext('2d');
  if (context) {
    context.translate(width / 2, height / 2);
    context.rotate((rotation * Math.PI) / 180);
    if (flipH) context.scale(-1, 1);
    context.drawImage(source, -source.naturalWidth / 2, -source.naturalHeight / 2);
  }
  return canvas;
}

export function ImageEditor({
  file,
  onCancel,
  onDone,
}: {
  file: File;
  onCancel: () => void;
  onDone: (edited: File) => void;
}) {
  const [source, setSource] = useState<HTMLImageElement | null>(null);
  const [rotation, setRotation] = useState(0);
  const [flipH, setFlipH] = useState(false);
  const [crop, setCrop] = useState<Crop>(FULL_CROP);
  const [aspect, setAspect] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const previewRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; crop: Crop } | null>(null);

  useEffect(() => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => setSource(image);
    image.onerror = () => setError('That file could not be read as an image.');
    image.src = url;
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const stageSize = source
    ? rotation % 180 === 0
      ? { width: source.naturalWidth, height: source.naturalHeight }
      : { width: source.naturalHeight, height: source.naturalWidth }
    : { width: 1, height: 1 };

  /** Paint the upright image into the visible canvas. */
  useEffect(() => {
    const canvas = previewRef.current;
    if (!canvas || !source) return;

    const stage = renderStage(source, rotation, flipH);
    // Preview at a modest size — this repaints on every rotate.
    const scale = Math.min(1, 1024 / Math.max(stage.width, stage.height));
    canvas.width = Math.max(1, Math.round(stage.width * scale));
    canvas.height = Math.max(1, Math.round(stage.height * scale));

    const context = canvas.getContext('2d');
    context?.drawImage(stage, 0, 0, canvas.width, canvas.height);
  }, [source, rotation, flipH]);

  /** Re-fit the crop box whenever the shape or the rotation changes. */
  useEffect(() => {
    if (!source) return;
    if (aspect === null) {
      setCrop(FULL_CROP);
      return;
    }

    const imageAspect = stageSize.width / stageSize.height;
    // Largest centred box of the requested shape that still fits.
    const width = aspect >= imageAspect ? 1 : aspect / imageAspect;
    const height = aspect >= imageAspect ? imageAspect / aspect : 1;
    setCrop({ x: (1 - width) / 2, y: (1 - height) / 2, width, height });
  }, [aspect, source, stageSize.width, stageSize.height]);

  const onPointerDown = (event: React.PointerEvent) => {
    if (aspect === null) return;
    (event.currentTarget as Element).setPointerCapture?.(event.pointerId);
    drag.current = { x: event.clientX, y: event.clientY, crop };
  };

  const onPointerMove = (event: React.PointerEvent) => {
    const start = drag.current;
    const frame = frameRef.current;
    if (!start || !frame) return;

    const bounds = frame.getBoundingClientRect();
    const dx = (event.clientX - start.x) / bounds.width;
    const dy = (event.clientY - start.y) / bounds.height;

    setCrop({
      ...start.crop,
      x: Math.min(Math.max(0, start.crop.x + dx), 1 - start.crop.width),
      y: Math.min(Math.max(0, start.crop.y + dy), 1 - start.crop.height),
    });
  };

  const endDrag = () => {
    drag.current = null;
  };

  const apply = useCallback(async () => {
    if (!source) return;
    setBusy(true);
    setError(null);

    try {
      // Step 1: upright. Step 2: a plain sub-rectangle copy out of it.
      const stage = renderStage(source, rotation, flipH);

      const sx = Math.round(crop.x * stage.width);
      const sy = Math.round(crop.y * stage.height);
      const sw = Math.max(1, Math.round(crop.width * stage.width));
      const sh = Math.max(1, Math.round(crop.height * stage.height));

      // Downscale on the way out; a 12 MP phone photo is pointless as a latent.
      const scale = Math.min(1, MAX_OUTPUT / Math.max(sw, sh));
      const outWidth = Math.max(1, Math.round(sw * scale));
      const outHeight = Math.max(1, Math.round(sh * scale));

      const canvas = document.createElement('canvas');
      canvas.width = outWidth;
      canvas.height = outHeight;

      const context = canvas.getContext('2d');
      if (!context) throw new Error('Canvas is unavailable');
      context.imageSmoothingQuality = 'high';
      context.drawImage(stage, sx, sy, sw, sh, 0, 0, outWidth, outHeight);

      const blob = await new Promise<Blob | null>((resolve) =>
        // PNG keeps it lossless; these go straight into a sampler.
        canvas.toBlob(resolve, 'image/png'),
      );
      if (!blob) throw new Error('Could not encode the edited image');

      const name = file.name.replace(/\.[^.]+$/, '') || 'photo';
      onDone(new File([blob], `${name}_edited.png`, { type: 'image/png' }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not apply those edits');
    } finally {
      setBusy(false);
    }
  }, [source, rotation, flipH, crop, file, onDone]);

  const cropWidthPx = Math.round(stageSize.width * crop.width);
  const cropHeightPx = Math.round(stageSize.height * crop.height);
  const willScale = Math.max(cropWidthPx, cropHeightPx) > MAX_OUTPUT;

  // The sheet's dismiss button says "Cancel", not "Done": nothing is applied
  // until Use, and "Done" in the header would look like the way to accept the
  // crop while actually discarding it.
  return (
    <Sheet open onClose={onCancel} title="Adjust photo" closeLabel="Cancel" full>
      <div className="space-y-4">
        {!source ? (
          <div className="grid place-items-center py-16">
            <Spinner className="size-6 text-muted" />
          </div>
        ) : (
          <>
            <div
              ref={frameRef}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              className="relative touch-none overflow-hidden rounded-2xl border border-line bg-surface-2"
              style={{ aspectRatio: `${stageSize.width} / ${stageSize.height}` }}
            >
              <canvas ref={previewRef} className="absolute inset-0 size-full" />

              {/*
                Four dimmed panels around the crop, rather than a hole punched in
                an overlay — simple, and it makes the kept region unmistakable.
              */}
              {aspect !== null && (
                <>
                  <div
                    className="pointer-events-none absolute inset-x-0 top-0 bg-black/55"
                    style={{ height: `${crop.y * 100}%` }}
                  />
                  <div
                    className="pointer-events-none absolute inset-x-0 bottom-0 bg-black/55"
                    style={{ height: `${(1 - crop.y - crop.height) * 100}%` }}
                  />
                  <div
                    className="pointer-events-none absolute left-0 bg-black/55"
                    style={{
                      top: `${crop.y * 100}%`,
                      height: `${crop.height * 100}%`,
                      width: `${crop.x * 100}%`,
                    }}
                  />
                  <div
                    className="pointer-events-none absolute right-0 bg-black/55"
                    style={{
                      top: `${crop.y * 100}%`,
                      height: `${crop.height * 100}%`,
                      width: `${(1 - crop.x - crop.width) * 100}%`,
                    }}
                  />
                  <div
                    className="pointer-events-none absolute border-2 border-white/90"
                    style={{
                      left: `${crop.x * 100}%`,
                      top: `${crop.y * 100}%`,
                      width: `${crop.width * 100}%`,
                      height: `${crop.height * 100}%`,
                    }}
                  />
                </>
              )}
            </div>

            {aspect !== null && (
              <p className="text-center text-xs text-muted">Drag to reposition the frame</p>
            )}

            <div className="space-y-2">
              <span className="text-xs font-medium tracking-wide text-muted uppercase">Crop</span>
              <div className="flex flex-wrap gap-2">
                {ASPECTS.map((option) => (
                  <button
                    key={option.label}
                    type="button"
                    onClick={() => setAspect(option.value)}
                    className={cn(
                      'h-9 rounded-lg border px-3 text-sm',
                      aspect === option.value
                        ? 'border-accent bg-accent/15 text-accent'
                        : 'border-line bg-surface text-muted',
                    )}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <span className="text-xs font-medium tracking-wide text-muted uppercase">
                Orientation
              </span>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setRotation((current) => (current + 270) % 360)}
                >
                  ↺ Left
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setRotation((current) => (current + 90) % 360)}
                >
                  ↻ Right
                </Button>
                <Button
                  variant={flipH ? 'primary' : 'secondary'}
                  size="sm"
                  onClick={() => setFlipH((current) => !current)}
                >
                  ⇄ Mirror
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setRotation(0);
                    setFlipH(false);
                    setAspect(null);
                    setCrop(FULL_CROP);
                  }}
                >
                  Reset
                </Button>
              </div>
            </div>

            <p className="text-xs text-muted" data-testid="editor-output-size">
              Result: {cropWidthPx}×{cropHeightPx}
              {willScale && ` — scaled down to fit ${MAX_OUTPUT}px`}
            </p>
          </>
        )}

        {error && (
          <p className="rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
            {error}
          </p>
        )}

        <div className="flex gap-2">
          <Button variant="ghost" className="flex-1" onClick={onCancel}>
            Cancel
          </Button>
          {/* An unedited photo should not have to go through the canvas at all. */}
          <Button variant="secondary" className="flex-1" disabled={busy} onClick={() => onDone(file)}>
            Original
          </Button>
          <Button variant="primary" className="flex-1" busy={busy} disabled={!source} onClick={apply}>
            Use
          </Button>
        </div>
      </div>
    </Sheet>
  );
}
