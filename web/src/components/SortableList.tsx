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
 * no help on the device this app is for. This measures the rows once when a drag
 * starts and then works entirely in transforms: nothing re-flows mid-drag, the
 * rows under your finger move out of the way, and the new order is committed in
 * one call when you let go.
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
    startY: number;
    tops: number[];
    heights: number[];
  } | null>(null);

  const [active, setActive] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [target, setTarget] = useState(0);

  const start = (event: ReactPointerEvent, id: string) => {
    const index = items.findIndex((item) => idOf(item) === id);
    if (index < 0) return;

    const measured = items.map((item) => rows.current.get(idOf(item))?.getBoundingClientRect());
    if (measured.some((rect) => !rect)) return;

    drag.current = {
      id,
      from: index,
      startY: event.clientY,
      tops: measured.map((rect) => rect!.top),
      heights: measured.map((rect) => rect!.height),
    };
    setActive(id);
    setOffset(0);
    setTarget(index);

    try {
      (event.target as Element).setPointerCapture(event.pointerId);
    } catch {
      // Synthetic pointers (and some engines) refuse capture; the window
      // listeners below still see the rest of the gesture.
    }
  };

  const move = (event: { clientY: number; preventDefault: () => void }) => {
    const state = drag.current;
    if (!state) return;
    event.preventDefault();

    const dy = event.clientY - state.startY;
    setOffset(dy);

    // Where the dragged row's middle now sits, against where every other row's
    // middle started. The count of rows above it *is* the insertion index.
    const centre = state.tops[state.from]! + state.heights[state.from]! / 2 + dy;
    let next = 0;
    for (let index = 0; index < items.length; index += 1) {
      if (index === state.from) continue;
      if (state.tops[index]! + state.heights[index]! / 2 < centre) next += 1;
    }
    setTarget(next);
  };

  const end = () => {
    const state = drag.current;
    drag.current = null;
    setActive(null);
    setOffset(0);

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

  const shiftFor = (index: number): number => {
    const state = drag.current;
    if (!state || index === state.from) return 0;
    const height = state.heights[state.from]!;
    if (state.from < target && index > state.from && index <= target) return -height;
    if (target < state.from && index >= target && index < state.from) return height;
    return 0;
  };

  return (
    <ul className={className}>
      {items.map((item, index) => {
        const id = idOf(item);
        const dragging = active === id;
        const shift = dragging ? offset : shiftFor(index);

        return (
          <li
            key={id}
            ref={(element) => {
              if (element) rows.current.set(id, element);
              else rows.current.delete(id);
            }}
            style={{
              transform: shift ? `translateY(${shift}px)` : undefined,
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
