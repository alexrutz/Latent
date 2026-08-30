import { useCallback, useEffect, useRef, useState } from 'react';

import type { EditOrigin } from '@latent/shared';

import { cn } from './ui';

/**
 * The picture an edit was made from, wiped across the one it produced.
 *
 * An edit workflow gives back a changed picture, and the only interesting
 * question about it is what changed. Two thumbnails side by side answer that
 * badly — the eye cannot hold one still enough to subtract the other — where a
 * seam dragged across a single frame answers it exactly: everything on one side
 * is before, everything on the other is after, and moving the seam sweeps the
 * difference under your thumb.
 *
 * Two seams, one per axis, because an edit does not change the picture evenly.
 * A new coat is somewhere in the middle, a replaced sky is along the top, and a
 * horizontal seam can be dragged through the first while a vertical one is
 * useless against the second. Having both means whatever moved, there is a seam
 * that crosses it.
 *
 * Each rests parked against an edge — which edge is a setting, because it is a
 * question about the hand holding the phone rather than about the picture.
 * Parked, it reveals nothing and the edited picture is whole.
 */

export type VerticalEdge = 'left' | 'right';
export type HorizontalEdge = 'top' | 'bottom';

/** How far a finger may travel and still count as a tap on the handle. */
const TAP_SLOP = 8;
/** One press of an arrow key, as a fraction of the screen. */
const KEY_STEP = 0.05;

/**
 * How much of the screen the viewer's own furniture takes, top and bottom.
 *
 * A grab tab has to stop short of both: the close button and the counter are up
 * there, and two rows of actions are down there — a tab parked on top of Delete
 * is a tap that deletes the picture you were comparing. The footer is the
 * taller of the two because it is two rows and a safe area.
 */
const CHROME_TOP = 72;
const CHROME_BOTTOM = 168;

/**
 * How big a grab tab is, in pixels.
 *
 * Smaller than a standard target on purpose. It lives on the edge of a screen
 * whose whole content is one picture, and every pixel it takes is a pixel of
 * that picture — so it is sized to be found and dragged rather than to be
 * comfortable, which is the right trade for a control you touch deliberately
 * and never by accident.
 */
const HANDLE = 36;

/** Rounded on the side facing the picture, square against the edge it sits on. */
const TAB_SHAPE: Record<string, string> = {
  left: 'rounded-r-full',
  right: 'rounded-l-full',
  top: 'rounded-b-full',
  bottom: 'rounded-t-full',
};

interface CompareWipeProps {
  origin: EditOrigin;
  /** The origin at the size this screen shows it, same as the picture over it. */
  src: string;
  /** What the edited picture is under, so the origin sits exactly on top of it. */
  transform: { scale: number; offsetX: number; offsetY: number };
  verticalEdge: VerticalEdge;
  horizontalEdge: HorizontalEdge;
  /**
   * How much of the origin is laid over the whole frame, 0 to 1.
   *
   * The third way to see it, and the only one that is not a seam. A seam is for
   * "what changed *here*"; laying one picture over the other at half strength
   * is for "did anything move at all" — a shift of a few pixels that no seam
   * will find is obvious the moment the two are superimposed.
   *
   * Owned by the viewer rather than by this component, because the control for
   * it is up in the header beside the blur: it belongs with the other things
   * that change how the whole screen looks.
   */
  blend: number;
  /** The tabs are hidden with the rest of the viewer's controls. */
  controlsVisible: boolean;
  /** The origin's file has gone; the viewer drops the whole comparison. */
  onMissing: () => void;
}

export function CompareWipe({
  origin,
  src,
  transform,
  verticalEdge,
  horizontalEdge,
  blend,
  controlsVisible,
  onMissing,
}: CompareWipeProps) {
  /** How much each seam has been dragged in from its edge, as a fraction. */
  const [vertical, setVertical] = useState(0);
  const [horizontal, setHorizontal] = useState(0);

  // A different picture is a different comparison: both seams go back to park.
  useEffect(() => {
    setVertical(0);
    setHorizontal(0);
  }, [src]);

  const style = {
    transform: `translate3d(${transform.offsetX}px, ${transform.offsetY}px, 0) scale(${transform.scale})`,
  };

  /*
   * Two layers of the same picture rather than one clipped to the union.
   *
   * The union of a band down one side and a band across one end is an L, and
   * which corner the L turns is decided by two independent settings — four
   * polygons to get right, against two rectangles that cannot be got wrong.
   * They are the same image at the same URL, so the browser fetches it once and
   * the overlap costs nothing but a second composite.
   */
  const layers: { key: string; clip?: string; opacity?: number }[] = [
    {
      key: 'vertical',
      clip:
        verticalEdge === 'left'
          ? `inset(0 ${(1 - vertical) * 100}% 0 0)`
          : `inset(0 0 0 ${(1 - vertical) * 100}%)`,
    },
    {
      key: 'horizontal',
      clip:
        horizontalEdge === 'top'
          ? `inset(0 0 ${(1 - horizontal) * 100}% 0)`
          : `inset(${(1 - horizontal) * 100}% 0 0 0)`,
    },
    /*
     * The cross-fade, over the whole frame and over both bands.
     *
     * Last, so it composites on top of them — which is what makes the three
     * controls independent rather than fighting. Inside a wipe band the origin
     * is already opaque, and painting more of the same origin over it at any
     * strength leaves it exactly as it was; everywhere else this is the only
     * thing showing the origin, and it shows as much of it as you asked for.
     */
    { key: 'blend', opacity: blend },
  ];

  return (
    <>
      {layers.map((layer) => (
        <img
          key={layer.key}
          data-testid={`compare-origin-${layer.key}`}
          src={src}
          alt=""
          draggable={false}
          onError={onMissing}
          className="pointer-events-none absolute inset-0 size-full origin-center object-contain select-none"
          style={{
            ...style,
            ...(layer.clip ? { clipPath: layer.clip } : {}),
            ...(layer.opacity !== undefined ? { opacity: layer.opacity } : {}),
          }}
          // Nothing revealed is nothing to announce; the layer is still mounted
          // so the file is fetched and its absence is known before you drag.
          aria-hidden
        />
      ))}

      {/* The seam itself, drawn only where there is one to see. */}
      {vertical > 0 && (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-y-0 w-px bg-white/70 mix-blend-difference"
          style={{ [verticalEdge]: `${vertical * 100}%` } as React.CSSProperties}
        />
      )}
      {horizontal > 0 && (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-0 h-px bg-white/70 mix-blend-difference"
          style={{ [horizontalEdge]: `${horizontal * 100}%` } as React.CSSProperties}
        />
      )}

      {/*
        The tabs go with the rest of the controls.

        They are furniture on the edge of a picture like every other control
        here, and "show me only the picture" has to mean only the picture or it
        is not worth having. What they were set to survives the round trip —
        this hides them, it does not reset them.
      */}
      {controlsVisible && (
        <>
          <WipeHandle
            axis="vertical"
            edge={verticalEdge}
            value={vertical}
            onChange={setVertical}
            label={`Wipe in from the ${verticalEdge} to show ${origin.nodeTitle}`}
          />
          <WipeHandle
            axis="horizontal"
            edge={horizontalEdge}
            value={horizontal}
            onChange={setHorizontal}
            label={`Wipe in from the ${horizontalEdge} to show ${origin.nodeTitle}`}
          />
        </>
      )}
    </>
  );
}

/**
 * The grab tab for one seam.
 *
 * A slider, and says so: the platform already has a word for "a thing dragged
 * along an axis between two ends", and taking it means arrow keys work and a
 * test can read the position without measuring pixels.
 *
 * It stops its own pointer events dead. The layer underneath reads a drag as a
 * swipe to the next picture and a tap as "close" — both of which are exactly
 * what a finger on this handle is not asking for.
 */
function WipeHandle({
  axis,
  edge,
  value,
  onChange,
  label,
}: {
  axis: 'vertical' | 'horizontal';
  edge: VerticalEdge | HorizontalEdge;
  value: number;
  onChange: (value: number) => void;
  label: string;
}) {
  const pressed = useRef<{ x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  /** Where along its axis a point on the screen puts the seam. */
  const fractionAt = useCallback(
    (event: React.PointerEvent) => {
      const along =
        axis === 'vertical'
          ? event.clientX / Math.max(1, window.innerWidth)
          : event.clientY / Math.max(1, window.innerHeight);
      // Measured from the parked edge, so both edges behave the same way round.
      const fromEdge = edge === 'left' || edge === 'top' ? along : 1 - along;
      return Math.min(1, Math.max(0, fromEdge));
    },
    [axis, edge],
  );

  const onPointerDown = (event: React.PointerEvent) => {
    event.stopPropagation();
    try {
      (event.target as Element).setPointerCapture?.(event.pointerId);
    } catch {
      // Carry on without it; the move handler works either way.
    }
    pressed.current = { x: event.clientX, y: event.clientY };
    setDragging(true);
  };

  const onPointerMove = (event: React.PointerEvent) => {
    event.stopPropagation();
    if (!dragging) return;
    onChange(fractionAt(event));
  };

  const onPointerUp = (event: React.PointerEvent) => {
    event.stopPropagation();
    setDragging(false);
    const start = pressed.current;
    pressed.current = null;
    /*
     * A tap is the whole way, or back to park.
     *
     * "Show me the before" is the commonest thing wanted here and it should not
     * need a careful drag to the far edge; a tap says it. Dragging is for the
     * part in between, which is where the comparison actually happens.
     */
    if (
      start &&
      Math.abs(event.clientX - start.x) <= TAP_SLOP &&
      Math.abs(event.clientY - start.y) <= TAP_SLOP
    ) {
      onChange(value > 0 ? 0 : 1);
    }
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    const back = axis === 'vertical' ? 'ArrowLeft' : 'ArrowUp';
    const forward = axis === 'vertical' ? 'ArrowRight' : 'ArrowDown';
    // Towards the parked edge is "less revealed" whichever edge that is.
    const towards = edge === 'left' || edge === 'top' ? 1 : -1;

    if (event.key === back || event.key === forward) {
      event.preventDefault();
      event.stopPropagation();
      const step = (event.key === forward ? KEY_STEP : -KEY_STEP) * towards;
      onChange(Math.min(1, Math.max(0, value + step)));
    }
  };

  /*
   * Along its own axis the handle follows the seam; across it, it sits on the
   * screen's own edge — flush, not floating a few pixels inside it.
   *
   * That distinction is the whole of this: a tab inset from the edge sits *on
   * the picture* and takes a bite out of the thing you are looking at, and a
   * picture is what this screen is for. Against the edge it reads as furniture
   * belonging to the window rather than to the image, and on a phone the edge
   * is where a thumb already rests.
   *
   * Clamped along the axis rather than centred on the seam exactly. Centred, a
   * parked handle is half off the screen — half a target, on the one control
   * you have to find before you can use any of this — and at the far end it
   * would park on the viewer's own furniture; see `CHROME_TOP`.
   *
   * The *seam* still runs edge to edge. Only the tab holds back.
   */
  const near = axis === 'vertical' ? 0 : edge === 'top' ? CHROME_TOP : CHROME_BOTTOM;
  const far = axis === 'vertical' ? HANDLE : edge === 'top' ? CHROME_BOTTOM : CHROME_TOP;
  const half = HANDLE / 2;
  const along = `clamp(${near}px, calc(${value * 100}% - ${half}px), calc(100% - ${far}px))`;
  const position: React.CSSProperties =
    axis === 'vertical'
      ? { top: '50%', marginTop: -half, [edge]: along }
      : { left: '50%', marginLeft: -half, [edge]: along };

  return (
    <button
      type="button"
      role="slider"
      aria-label={label}
      aria-orientation={axis === 'vertical' ? 'horizontal' : 'vertical'}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value * 100)}
      data-testid={`compare-handle-${axis}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
      onClick={(event) => event.stopPropagation()}
      style={{ ...position, width: HANDLE, height: HANDLE }}
      className={cn(
        'absolute z-20 grid touch-none place-items-center',
        'bg-black/50 text-[11px] text-white/90 backdrop-blur',
        'ring-1 ring-white/25',
        TAB_SHAPE[edge],
        dragging && 'bg-black/70 ring-white/50',
      )}
    >
      {/* Arrows across the axis it moves on: what it does, in one glyph. */}
      <span aria-hidden>{axis === 'vertical' ? '⇹' : '⇳'}</span>
    </button>
  );
}
