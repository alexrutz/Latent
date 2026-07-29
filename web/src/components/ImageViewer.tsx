import { useCallback, useEffect, useRef, useState } from 'react';

import type { GenerationImage, GenerationRecord } from '@latent/shared';

import { imageUrl } from '../api/client';
import { cn } from './ui';

interface ImageViewerProps {
  record: GenerationRecord;
  index: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
  footer?: React.ReactNode;
}

const MAX_SCALE = 5;
const DOUBLE_TAP_SCALE = 2.5;

/**
 * Full-screen image viewer with pinch-zoom, pan, and swipe between results.
 *
 * Gestures are handled explicitly rather than delegated to the browser: a
 * fixed-position overlay does not get native pinch-zoom, and the alternative
 * (letting the page zoom) breaks the surrounding UI.
 */
export function ImageViewer({ record, index, onIndexChange, onClose, footer }: ImageViewerProps) {
  const image = record.images[index];
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);

  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gestureStart = useRef({ distance: 0, scale: 1, x: 0, y: 0, offsetX: 0, offsetY: 0 });
  const lastTap = useRef(0);
  const swipeStart = useRef<{ x: number; y: number } | null>(null);

  const reset = useCallback(() => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }, []);

  // A new image always starts unzoomed.
  useEffect(reset, [index, record.id, reset]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'ArrowRight' && index < record.images.length - 1) onIndexChange(index + 1);
      if (event.key === 'ArrowLeft' && index > 0) onIndexChange(index - 1);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [index, record.images.length, onClose, onIndexChange]);

  if (!image) return null;

  const distanceBetween = (a: { x: number; y: number }, b: { x: number; y: number }) =>
    Math.hypot(a.x - b.x, a.y - b.y);

  const onPointerDown = (event: React.PointerEvent) => {
    (event.target as Element).setPointerCapture?.(event.pointerId);
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      gestureStart.current = {
        distance: distanceBetween(a!, b!),
        scale,
        x: (a!.x + b!.x) / 2,
        y: (a!.y + b!.y) / 2,
        offsetX: offset.x,
        offsetY: offset.y,
      };
    } else if (pointers.current.size === 1) {
      setDragging(true);
      gestureStart.current = {
        ...gestureStart.current,
        x: event.clientX,
        y: event.clientY,
        offsetX: offset.x,
        offsetY: offset.y,
      };
      swipeStart.current = scale === 1 ? { x: event.clientX, y: event.clientY } : null;
    }
  };

  const onPointerMove = (event: React.PointerEvent) => {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const start = gestureStart.current;
      if (start.distance === 0) return;
      const next = Math.min(
        MAX_SCALE,
        Math.max(1, (start.scale * distanceBetween(a!, b!)) / start.distance),
      );
      setScale(next);
      return;
    }

    if (pointers.current.size === 1 && scale > 1) {
      const start = gestureStart.current;
      setOffset({
        x: start.offsetX + (event.clientX - start.x),
        y: start.offsetY + (event.clientY - start.y),
      });
    }
  };

  const onPointerUp = (event: React.PointerEvent) => {
    const start = swipeStart.current;
    pointers.current.delete(event.pointerId);

    if (pointers.current.size === 0) {
      setDragging(false);

      // Unzoomed horizontal flick moves between images in the batch.
      if (start && scale === 1) {
        const dx = event.clientX - start.x;
        const dy = event.clientY - start.y;
        if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
          if (dx < 0 && index < record.images.length - 1) onIndexChange(index + 1);
          if (dx > 0 && index > 0) onIndexChange(index - 1);
          swipeStart.current = null;
          return;
        }
      }

      // Double tap toggles zoom, the standard photo-viewer gesture.
      const now = Date.now();
      if (now - lastTap.current < 300) {
        if (scale > 1) reset();
        else setScale(DOUBLE_TAP_SCALE);
        lastTap.current = 0;
      } else {
        lastTap.current = now;
      }
    }
    swipeStart.current = null;
  };

  return (
    <div className="fixed inset-0 z-60 flex flex-col bg-black">
      <div className="safe-t flex shrink-0 items-center justify-between px-2 py-2">
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="grid size-11 place-items-center rounded-full text-2xl text-white/80 active:bg-white/10"
        >
          ✕
        </button>
        {record.images.length > 1 && (
          <span className="text-sm text-white/60 tabular-nums">
            {index + 1} / {record.images.length}
          </span>
        )}
        <span className="size-11" />
      </div>

      <div
        className="min-h-0 flex-1 touch-none overflow-hidden"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <img
          src={imageUrl(image)}
          alt={record.title}
          draggable={false}
          className={cn(
            'size-full origin-center object-contain select-none',
            !dragging && 'transition-transform duration-150',
          )}
          style={{
            transform: `translate3d(${offset.x}px, ${offset.y}px, 0) scale(${scale})`,
          }}
        />
      </div>

      {footer && <div className="safe-b shrink-0 bg-black/80 px-4 py-3">{footer}</div>}
    </div>
  );
}

/**
 * A grid thumbnail.
 *
 * Only ever requests the preview variant — never the full image. The server
 * resolves that to a stored thumbnail, ComfyUI's own resizer, or (on an old
 * build with neither) the original; from the client's side there is no
 * fallback that could accidentally pull megabytes over mobile data.
 */
export function Thumb({
  image,
  alt,
  className,
  style,
  onClick,
  onLongPress,
  onMeasured,
  fit = 'cover',
}: {
  image: GenerationImage;
  alt: string;
  className?: string;
  style?: React.CSSProperties;
  onClick?: () => void;
  onLongPress?: () => void;
  /** Reports the real pixel size the first time we learn it. */
  onMeasured?: (width: number, height: number) => void;
  fit?: 'cover' | 'contain';
}) {
  const [failed, setFailed] = useState(false);
  const longPress = useLongPress(onLongPress);

  return (
    <button
      type="button"
      onClick={onClick}
      style={style}
      {...longPress}
      className={cn(
        'relative overflow-hidden rounded-xl bg-surface-2 active:opacity-80',
        className,
      )}
    >
      {failed ? (
        <span className="grid size-full place-items-center text-xs text-muted">missing</span>
      ) : (
        <img
          src={imageUrl(image, 'webp;70')}
          alt={alt}
          loading="lazy"
          decoding="async"
          onLoad={(event) => {
            const element = event.currentTarget;
            // The thumbnail's own dimensions carry the original's aspect ratio,
            // which is all the grid needs to shape the tile.
            if (!image.width && element.naturalWidth > 0) {
              onMeasured?.(element.naturalWidth, element.naturalHeight);
            }
          }}
          onError={() => setFailed(true)}
          className={cn('size-full', fit === 'cover' ? 'object-cover' : 'object-contain')}
        />
      )}
    </button>
  );
}

/**
 * Long-press without swallowing taps or triggering on a scroll.
 *
 * Used for the per-tile size override — a phone has no right-click, and a
 * dedicated button on every thumbnail would clutter the grid.
 */
function useLongPress(onLongPress?: () => void) {
  const timer = useRef<number | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);

  if (!onLongPress) return {};

  const cancel = () => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  };

  return {
    onPointerDown: (event: React.PointerEvent) => {
      start.current = { x: event.clientX, y: event.clientY };
      cancel();
      timer.current = window.setTimeout(() => {
        timer.current = null;
        onLongPress();
      }, 500);
    },
    onPointerMove: (event: React.PointerEvent) => {
      // Scrolling past a tile must not count as holding it.
      const origin = start.current;
      if (!origin) return;
      if (Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > 10) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onContextMenu: (event: React.MouseEvent) => event.preventDefault(),
  };
}
