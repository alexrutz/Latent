import { useEffect, useRef, useState, type ReactNode } from 'react';

import type { GenerationImage, GridSettings } from '@latent/shared';

import { tileSpanFor, tileStyle } from '../state/grid';

/**
 * The thumbnail grid.
 *
 * Rows are given an explicit pixel height measured from the container, because
 * a tile that spans two rows only means something if rows have a known size.
 * That is what lets a portrait image occupy a tall tile and a landscape one a
 * wide tile, so each picture is shown at its own shape instead of being
 * cropped square.
 */
export function ThumbGrid({
  columns,
  children,
  className,
}: {
  columns: number;
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [cell, setCell] = useState(0);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const measure = () => {
      const gap = 8; // matches gap-2
      const width = element.clientWidth;
      if (width > 0) setCell((width - gap * (columns - 1)) / columns);
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [columns]);

  return (
    <div
      ref={ref}
      className={className}
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
        // Until measured, let rows size themselves rather than collapsing.
        gridAutoRows: cell > 0 ? `${cell}px` : 'auto',
        gap: 8,
      }}
    >
      {children}
    </div>
  );
}

/** Compute the style for one tile, given the image and the current settings. */
export function useTileStyle(
  image: Pick<GenerationImage, 'width' | 'height' | 'tileSpan'>,
  settings: GridSettings,
): React.CSSProperties {
  return tileStyle(tileSpanFor(image, settings), settings.columns);
}
