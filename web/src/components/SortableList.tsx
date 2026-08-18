import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';

export interface DragHandleProps {
  onPointerDown: (event: ReactPointerEvent) => void;
  style: { touchAction: 'none' };
}

interface SortableListProps<T> {
  items: T[];
  idOf: (item: T) => string;
  /** The new order, as ids. Called once, on release. */
  onReorder: (ids: string[]) => void;
  children: (item: T, handle: DragHandleProps, dragging: boolean) => ReactNode;
  className?: string;
}

/**
 * A list you reorder by dragging, built on pointer events.
 *
 * HTML5 drag and drop does not exist on touch, so the browser's own mechanism is
 * no help on the device this app is for. This measures the items once when a
 * drag starts and then works entirely in transforms: nothing re-flows mid-drag,
 * the slot you are over is outlined, and the new order is committed in one call
 * when you let go.
 *
 * Works for a column and for a grid, because the same component lays out both —
 * the target is whichever item's centre is nearest the finger, which needs no
 * assumption about how they are arranged.
 *
 * Dragging is deliberately restricted to a handle. A list whose rows are also
 * buttons cannot start a drag from anywhere without swallowing taps.
 */
export function SortableList<T>({
  items,
  idOf,
  onReorder,
  children,
  className,
}: SortableListProps<T>) {
  const rows = useRef(new Map<string, HTMLLIElement>());
  const drag = useRef<{
    id: string;
    from: number;
    startX: number;
    startY: number;
    centres: { x: number; y: number }[];
  } | null>(null);

  const [active, setActive] = useState<string | null>(null);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [target, setTarget] = useState(0);

  const start = (event: ReactPointerEvent, id: string) => {
    const index = items.findIndex((item) => idOf(item) === id);
    if (index < 0) return;

    const measured = items.map((item) => rows.current.get(idOf(item))?.getBoundingClientRect());
    if (measured.some((rect) => !rect)) return;

    drag.current = {
      id,
      from: index,
      startX: event.clientX,
      startY: event.clientY,
      centres: measured.map((rect) => ({
        x: rect!.left + rect!.width / 2,
        y: rect!.top + rect!.height / 2,
      })),
    };
    setActive(id);
    setOffset({ x: 0, y: 0 });
    setTarget(index);

    try {
      (event.target as Element).setPointerCapture(event.pointerId);
    } catch {
      // Synthetic pointers (and some engines) refuse capture; the window
      // listeners below still see the rest of the gesture.
    }
  };

  const move = (event: { clientX: number; clientY: number; preventDefault: () => void }) => {
    const state = drag.current;
    if (!state) return;
    event.preventDefault();

    setOffset({ x: event.clientX - state.startX, y: event.clientY - state.startY });

    /*
     * The slot nearest the finger, measured in two dimensions.
     *
     * Counting how many rows sit above the dragged one only works for a single
     * column; the same component now lays blocks out two across, where two
     * items share a y and that rule picks the wrong one. Nearest-centre is the
     * same answer for a list and the right one for a grid.
     */
    let next = state.from;
    let best = Number.POSITIVE_INFINITY;
    state.centres.forEach((centre, index) => {
      const distance = (centre.x - event.clientX) ** 2 + (centre.y - event.clientY) ** 2;
      if (distance < best) {
        best = distance;
        next = index;
      }
    });
    setTarget(next);
  };

  const end = () => {
    const state = drag.current;
    drag.current = null;
    setActive(null);
    setOffset({ x: 0, y: 0 });

    if (!state) return;
    if (target !== state.from) {
      const ids = items.map(idOf);
      const [moved] = ids.splice(state.from, 1);
      ids.splice(target, 0, moved!);
      onReorder(ids);
    }
  };

  /*
   * The rest of the gesture is watched on the window.
   *
   * `setPointerCapture` routes every later event to the handle itself, so a
   * listener anywhere else in the tree — an overlay, the list — never sees the
   * drag at all. The window sees it either way, captured or not.
   */
  useEffect(() => {
    if (active === null) return;

    const onMove = (event: PointerEvent) => move(event);
    const onUp = () => end();

    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  });

  return (
    <ul className={className}>
      {items.map((item, index) => {
        const id = idOf(item);
        const dragging = active === id;
        // The slot this would land in, outlined rather than animated: shuffling
        // the others out of the way has no sensible meaning in a grid.
        const landing = active !== null && !dragging && index === target;

        return (
          <li
            key={id}
            ref={(element) => {
              if (element) rows.current.set(id, element);
              else rows.current.delete(id);
            }}
            className={landing ? 'rounded-xl ring-2 ring-accent' : undefined}
            style={{
              transform: dragging ? `translate(${offset.x}px, ${offset.y}px)` : undefined,
              transition: dragging ? 'none' : 'transform 0.15s ease',
              zIndex: dragging ? 10 : undefined,
              position: dragging ? 'relative' : undefined,
            }}
          >
            {children(
              item,
              {
                onPointerDown: (event) => start(event, id),
                style: { touchAction: 'none' },
              },
              dragging,
            )}
          </li>
        );
      })}

    </ul>
  );
}
