import { useEffect, useState } from 'react';

/**
 * A clock that re-renders once a second while `active`.
 *
 * The server measures the ETA and pushes it with each sampler step. On a slow
 * model that is every few seconds, and an ETA that only moves when a step lands
 * looks stuck — which is the one thing an ETA must never look. This lets the
 * display count down between updates.
 *
 * Stops entirely when inactive, so an idle app is not repainting on a timer.
 */
export function useTicker(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [active, intervalMs]);

  return active ? now : 0;
}
