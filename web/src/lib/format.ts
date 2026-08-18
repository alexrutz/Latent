/**
 * Durations, written the way someone watching a progress bar reads them.
 *
 * Two rules throughout: never show more precision than the number deserves, and
 * never show a unit the value cannot fill. "0.8s/step" is useful; "800ms/step"
 * makes you do arithmetic, and "1m 0s" for 60 seconds is noise.
 */

/** `12s`, `1:23`, `1:02:03`. For elapsed time and countdowns. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  if (minutes > 0) return `${minutes}:${String(seconds).padStart(2, '0')}`;
  return `${seconds}s`;
}

/**
 * `0.42s`, `3.1s`, `1:05` — a single interval, with precision that scales.
 *
 * Sub-second steps are what a fast SDXL pass looks like on a good GPU, and
 * rounding those to "0s" would throw away the only interesting digit.
 */
export function formatSeconds(ms: number): string {
  if (ms < 1000) return `${(ms / 1000).toFixed(2)}s`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  return formatClock(ms);
}

/**
 * Per-step rate, flipped to steps/s once a step is faster than a second.
 *
 * This is the convention every other sampler UI uses, and it keeps the number
 * above 1 where it is easiest to compare at a glance.
 */
export function formatStepRate(msPerStep: number): string {
  if (msPerStep <= 0) return '—';
  if (msPerStep < 1000) return `${(1000 / msPerStep).toFixed(2)} steps/s`;
  return `${(msPerStep / 1000).toFixed(2)}s/step`;
}
