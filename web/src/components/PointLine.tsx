import { fieldPointValues, nearestPoint } from '@latent/shared';
import type { ParamField, WidgetValue } from '@latent/shared';

import { cn } from './ui';

/**
 * A row of pre-set values, chosen by tapping one.
 *
 * The alternative — the chip that opens a sheet with a slider and a keyboard —
 * is the right control for a value that could be anything. It is the wrong one
 * for steps or CFG, where in practice you cycle between the same handful of
 * numbers: three taps and a keyboard to get from 20 to 30 is three taps too
 * many.
 *
 * Which fields work this way is a per-field setting, because a seed is never one
 * of a short list and a prompt is not a number at all.
 */
export function PointLine({
  field,
  value,
  onChange,
}: {
  field: ParamField;
  value: WidgetValue;
  onChange: (value: WidgetValue) => void;
}) {
  const points = fieldPointValues(field);
  const current = Number(value ?? field.defaultValue ?? 0);
  /*
   * Highlight the nearest point rather than only an exact match. The value can
   * arrive from a preset, a reused result or a random draw and land between two
   * points; showing nothing selected then would suggest the control is broken.
   */
  const selected = Number.isFinite(current) ? nearestPoint(points, current) : null;
  const exact = selected !== null && Math.abs(selected - current) < 1e-9;

  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 truncate text-[11px] text-muted">{field.label}</span>
        <span className="shrink-0 text-sm font-medium tabular-nums">
          {formatPoint(current)}
          {/* Says the value is not on the line, rather than quietly rounding it. */}
          {!exact && <span className="ml-1 text-[10px] text-muted">off the line</span>}
        </span>
      </div>

      {/*
        The line is the row itself: a track behind the points, and the points on
        top of it. Scrolls sideways only when it genuinely cannot fit, which for
        the intended handful of values it will not.
      */}
      <div
        role="group"
        aria-label={field.label}
        className="no-scrollbar relative isolate flex items-center gap-0.5 overflow-x-auto py-1"
      >
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-1 top-1/2 -z-10 h-px -translate-y-1/2 bg-line"
        />
        {points.map((point) => {
          const active = selected === point;
          return (
            <button
              key={point}
              type="button"
              onClick={() => onChange(point)}
              aria-pressed={active}
              aria-label={`${field.label} ${formatPoint(point)}`}
              className={cn(
                // Boxes, not pills — a row of them reads as one scale rather
                // than a scatter of beads. `isolate` on the row keeps this
                // above the track without stacking above the whole page, which
                // is how these ended up painting over the Generate button.
                'relative h-8 min-w-9 shrink-0 rounded-md px-1.5 text-[11px] tabular-nums transition-colors',
                active
                  ? 'bg-accent font-medium text-white'
                  : 'bg-surface-2 text-muted active:bg-surface-3',
              )}
            >
              {formatPoint(point)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Trim the float noise a fractional step can leave behind. */
function formatPoint(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)));
}
