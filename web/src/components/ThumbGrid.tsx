import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import type { ComfyImageRef, GridSettings, TilePlan, TileShape } from '@latent/shared';
import { planTiles, ROW_UNITS, tileUnits } from '@latent/shared';

import { measuredSize } from '../state/measured';

/** The gutter between tiles, in pixels. One number, used by both axes. */
const GAP = 8;

/**
 * The thumbnail grid.
 *
 * Rows are a *twelfth* of a column's width rather than a whole cell, which is
 * what lets a tile be 2:3 or 4:3 instead of only 1:1, 2:1 or 1:2. The row gap
 * is zero because a gap between every sub-row would add up to more than the
 * tile; the gutter is each tile's own bottom padding instead, which is why
 * `tileUnits` asks for one gap more than the picture's height.
 *
 * The shapes themselves are decided a row at a time — see `planTiles`. A row of
 * pictures that agree on a shape is drawn at that shape; one that disagrees is
 * squared off. Either way every tile in a row is the same height, so the grid
 * never leaves a hole under a short tile.
 *
 * `shapes` is the ordered list of what is inside, placeholders included. It has
 * to be the same order as the children or the rows fall out of step with what
 * is on screen.
 */
const TilePlanContext = createContext<{ plans: TilePlan[]; cell: number }>({
  plans: [],
  cell: 0,
});

export function ThumbGrid({
  columns,
  shapes,
  uniform,
  children,
  className,
}: {
  columns: number;
  shapes: readonly TileShape[];
  /** The "everything square" setting, which the planner needs before it plans. */
  uniform?: boolean;
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [cell, setCell] = useState(0);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const measure = () => {
      const width = element.clientWidth;
      if (width > 0) setCell((width - GAP * (columns - 1)) / columns);
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [columns]);

  const plans = useMemo(
    () => planTiles(shapes, columns, { uniform: uniform === true }),
    [shapes, columns, uniform],
  );
  const value = useMemo(() => ({ plans, cell }), [plans, cell]);

  return (
    <TilePlanContext.Provider value={value}>
      <div
        ref={ref}
        className={className}
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
          // Until measured, let rows size themselves rather than collapsing.
          gridAutoRows: cell > 0 ? `${cell / ROW_UNITS}px` : 'auto',
          columnGap: GAP,
          rowGap: 0,
        }}
      >
        {children}
      </div>
    </TilePlanContext.Provider>
  );
}

/**
 * The style for the tile at this position in the grid.
 *
 * By position rather than by picture, because the shape is a property of the
 * row rather than of the picture in it — the same portrait is a 2:3 tile beside
 * other portraits and a square beside a landscape.
 */
export function useTileStyle(index: number): React.CSSProperties {
  const { plans, cell } = useContext(TilePlanContext);
  const plan = plans[index];

  if (!plan || cell <= 0) {
    // Before the first measurement, and for anything the planner did not see.
    return { gridColumn: 'span 1', paddingBottom: GAP };
  }

  return {
    gridColumn: `span ${plan.cols}`,
    gridRow: `span ${tileUnits(plan, cell, GAP)}`,
    // The gutter, since the rows themselves have none. `border-box` so the
    // padding comes out of the tile rather than being added to it.
    paddingBottom: GAP,
    boxSizing: 'border-box',
  };
}

/**
 * What the planner needs to know about one picture.
 *
 * Falling back to what this browser measured when the record has no size yet.
 * The server learns a picture's dimensions from whoever first loads it and the
 * gallery is not refetched for it, so the pictures you have only just made
 * would otherwise lay out as squares until something else caused a reload.
 */
export function shapeOf(
  image:
    | (Pick<TileShape, 'width' | 'height' | 'tileSpan'> &
        Partial<Pick<ComfyImageRef, 'type' | 'subfolder' | 'filename'>>)
    | null
    | undefined,
): TileShape {
  if (!image) return {};
  const measured =
    image.width && image.height
      ? null
      : measuredSize({
          type: image.type ?? 'output',
          subfolder: image.subfolder ?? '',
          filename: image.filename ?? '',
        });

  return {
    width: image.width ?? measured?.width ?? null,
    height: image.height ?? measured?.height ?? null,
    tileSpan: image.tileSpan ?? null,
  };
}

export type { GridSettings };
