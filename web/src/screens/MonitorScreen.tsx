import { useEffect, useMemo, useRef, useState } from 'react';

import type { MonitorEvent, MonitorEventKind, MonitorSnapshot, ResourceSample } from '@latent/shared';

import { api } from '../api/client';
import { cn, Spinner } from '../components/ui';

const POLL_MS = 2_000;
/** Matches the server's own ceiling, so a long session cannot grow unbounded. */
const MAX_SAMPLES = 600;
const MAX_EVENTS = 400;

const RANGES = [
  { label: '5 min', ms: 5 * 60_000 },
  { label: '30 min', ms: 30 * 60_000 },
  { label: 'All', ms: Number.POSITIVE_INFINITY },
] as const;

/**
 * What the machine was doing, and what it was doing it for.
 *
 * The two halves are the point. A VRAM curve on its own tells you the number
 * went up; the same curve with "loaded the checkpoint", "started sampling" and
 * "finished" marked on it tells you where the twenty seconds went. So the
 * readings and the queue's events share one time axis, and the ticks on the
 * charts are the events in the list below.
 */
export function MonitorScreen() {
  const snapshot = useHistory();
  // Five minutes by default: with a reading every couple of seconds that is a
  // chart with shape in it, where half an hour of an idle box is a flat line.
  const [range, setRange] = useState<number>(RANGES[0]!.ms);

  const now = Date.now();
  const from = Number.isFinite(range) ? now - range : (snapshot?.samples[0]?.at ?? now - 60_000);

  const samples = useMemo(
    () => (snapshot?.samples ?? []).filter((sample) => sample.at >= from),
    [snapshot, from],
  );
  const events = useMemo(
    () => (snapshot?.events ?? []).filter((event) => event.at >= from),
    [snapshot, from],
  );

  if (!snapshot) {
    return (
      <div className="grid h-full place-items-center">
        <Spinner className="size-6 text-muted" />
      </div>
    );
  }

  const window = { from, to: now };
  const latest = samples[samples.length - 1];

  return (
    <div className="safe-t px-4 pt-3 pb-6">
      <div className="mb-1 flex items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Monitor</h1>
        <div className="flex gap-1 rounded-full bg-surface p-1">
          {RANGES.map((option) => (
            <button
              key={option.label}
              type="button"
              onClick={() => setRange(option.ms)}
              className={cn(
                'rounded-full px-2.5 py-1 text-xs',
                range === option.ms ? 'bg-accent text-white' : 'text-muted',
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <p className="mb-3 truncate text-xs text-muted">
        {snapshot.deviceName ?? 'No device reported'}
        {snapshot.utilisationSource && ` · load via ${snapshot.utilisationSource}`}
      </p>

      {samples.length === 0 ? (
        <p className="text-sm text-muted">
          Nothing recorded in this window yet. Readings are taken every couple of seconds while
          something is running, and every twenty when the box is idle.
        </p>
      ) : (
        <div className="space-y-3" data-testid="monitor-charts">
          {/* The axis every chart below shares, said once. */}
          <div className="flex justify-between text-[10px] tabular-nums text-muted">
            <span>{clock(from)}</span>
            <span>now</span>
          </div>

          <Trace
            label="VRAM"
            samples={samples}
            events={events}
            window={window}
            valueOf={(sample) =>
              sample.vramUsed !== null && sample.vramTotal
                ? (sample.vramUsed / sample.vramTotal) * 100
                : null
            }
            format={() =>
              latest?.vramUsed != null && latest.vramTotal
                ? `${gib(latest.vramUsed)} / ${gib(latest.vramTotal)} GB`
                : '—'
            }
            missing={!snapshot.sources.vram}
          />

          <Trace
            label="GPU"
            samples={samples}
            events={events}
            window={window}
            valueOf={(sample) => sample.gpuPercent}
            format={() => (latest?.gpuPercent != null ? `${Math.round(latest.gpuPercent)}%` : '—')}
            missing={!snapshot.sources.gpu}
            /* Said plainly rather than drawn as a flat zero: ComfyUI core does
               not report utilisation, and pretending otherwise would look like
               an idle GPU mid-render. */
            missingHint="Install a monitoring extension (Crystools) on the ComfyUI box for this."
          />

          <Trace
            label="CPU"
            samples={samples}
            events={events}
            window={window}
            valueOf={(sample) => sample.cpuPercent}
            format={() => (latest?.cpuPercent != null ? `${Math.round(latest.cpuPercent)}%` : '—')}
            missing={!snapshot.sources.cpu}
            missingHint="Install a monitoring extension (Crystools) on the ComfyUI box for this."
          />

          <Trace
            label="System RAM"
            samples={samples}
            events={events}
            window={window}
            valueOf={(sample) =>
              sample.ramUsed !== null && sample.ramTotal
                ? (sample.ramUsed / sample.ramTotal) * 100
                : null
            }
            format={() =>
              latest?.ramUsed != null && latest.ramTotal
                ? `${gib(latest.ramUsed)} / ${gib(latest.ramTotal)} GB`
                : '—'
            }
            missing={!snapshot.sources.ram}
          />

          <Trace
            label="Sampler"
            samples={samples}
            events={events}
            window={window}
            valueOf={(sample) => sample.stepsPerSecond}
            format={() =>
              latest?.stepsPerSecond != null ? `${latest.stepsPerSecond.toFixed(2)} steps/s` : 'idle'
            }
            /* Not a percentage: scaled to the fastest reading in the window. */
            scale="auto"
          />

          <Trace
            label="Queue"
            samples={samples}
            events={events}
            window={window}
            valueOf={(sample) => sample.queueRemaining}
            format={() => `${latest?.queueRemaining ?? 0} waiting`}
            scale="auto"
          />
        </div>
      )}

      <h2 className="mt-5 mb-2 text-xs font-medium tracking-wide text-muted uppercase">
        Events
      </h2>
      {events.length === 0 ? (
        <p className="text-xs text-muted">Nothing happened in this window.</p>
      ) : (
        <ul className="space-y-1" data-testid="monitor-events">
          {[...events].reverse().map((event, index) => (
            <li
              key={`${event.at}-${index}`}
              className="flex items-start gap-2 rounded-lg border border-line bg-surface px-2 py-1.5"
            >
              <span className="w-11 shrink-0 pt-px text-[10px] tabular-nums text-muted">
                {clock(event.at)}
              </span>
              <span aria-hidden className={cn('shrink-0 text-xs', KIND_COLOUR[event.kind])}>
                {KIND_MARK[event.kind]}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs">{event.label}</p>
                {event.detail && (
                  <p
                    className={cn(
                      'text-[11px] break-words',
                      // Text output is the reason this list exists for
                      // diagnosis, so it is not truncated like a subtitle.
                      event.kind === 'text' ? 'text-body' : 'truncate text-muted',
                    )}
                  >
                    {event.detail}
                  </p>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const KIND_MARK: Record<MonitorEventKind, string> = {
  queued: '+',
  started: '▸',
  node: '·',
  text: '“',
  completed: '✓',
  failed: '!',
  cancelled: '×',
  online: '●',
  offline: '○',
};

const KIND_COLOUR: Record<MonitorEventKind, string> = {
  queued: 'text-muted',
  started: 'text-accent',
  node: 'text-muted',
  text: 'text-accent',
  completed: 'text-success',
  failed: 'text-danger',
  cancelled: 'text-warn',
  online: 'text-success',
  offline: 'text-danger',
};

/** Events worth drawing on a chart — the ones that explain a change in shape. */
const MARKED: MonitorEventKind[] = ['started', 'completed', 'failed', 'cancelled', 'offline'];

function Trace({
  label,
  samples,
  events,
  window: bounds,
  valueOf,
  format,
  missing,
  missingHint,
  scale = 'percent',
}: {
  label: string;
  samples: ResourceSample[];
  events: MonitorEvent[];
  window: { from: number; to: number };
  valueOf: (sample: ResourceSample) => number | null;
  format: () => string;
  missing?: boolean;
  missingHint?: string;
  scale?: 'percent' | 'auto';
}) {
  const points = samples
    .map((sample) => ({ at: sample.at, value: valueOf(sample) }))
    .filter((point): point is { at: number; value: number } => point.value !== null);

  const span = Math.max(1, bounds.to - bounds.from);
  const peak = scale === 'percent' ? 100 : Math.max(1, ...points.map((point) => point.value));

  const x = (at: number) => ((at - bounds.from) / span) * 100;
  const y = (value: number) => 100 - Math.min(100, (value / peak) * 100);

  const line = points.map((point) => `${x(point.at).toFixed(2)},${y(point.value).toFixed(2)}`);

  return (
    <div className="rounded-xl border border-line bg-surface px-2.5 py-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] tracking-wide text-muted uppercase">{label}</span>
        <span className="text-xs tabular-nums">{format()}</span>
      </div>

      {missing && points.length === 0 ? (
        <p className="pt-1 text-[11px] text-muted">Not reported. {missingHint}</p>
      ) : (
        <svg
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          className="mt-1 h-12 w-full"
          role="img"
          aria-label={`${label} over time`}
        >
          {/* Event ticks first, so the trace draws over them. */}
          {events
            .filter((event) => MARKED.includes(event.kind))
            .map((event, index) => (
              <line
                key={`${event.at}-${index}`}
                x1={x(event.at)}
                x2={x(event.at)}
                y1={0}
                y2={100}
                stroke="currentColor"
                strokeWidth={0.4}
                className={cn('opacity-60', KIND_COLOUR[event.kind])}
                vectorEffect="non-scaling-stroke"
              />
            ))}

          {line.length > 1 && (
            <>
              <polygon
                points={`${line[0]!.split(',')[0]},100 ${line.join(' ')} ${line[line.length - 1]!.split(',')[0]},100`}
                className="fill-accent/20"
              />
              <polyline
                points={line.join(' ')}
                fill="none"
                stroke="currentColor"
                strokeWidth={1.5}
                className="text-accent"
                vectorEffect="non-scaling-stroke"
              />
            </>
          )}
          {line.length === 1 && (
            <circle cx={line[0]!.split(',')[0]} cy={line[0]!.split(',')[1]} r={1.5} className="fill-accent" />
          )}
        </svg>
      )}
    </div>
  );
}

/**
 * Accumulates the history instead of refetching it.
 *
 * The server keeps up to ten minutes of readings; pulling all of them every two
 * seconds would be tens of kilobytes a second on a phone connection. Asking only
 * for what happened since the last answer makes each poll a few hundred bytes.
 */
function useHistory(): MonitorSnapshot | null {
  const [snapshot, setSnapshot] = useState<MonitorSnapshot | null>(null);
  const since = useRef(0);

  useEffect(() => {
    let cancelled = false;

    const tick = async () => {
      try {
        const next = await api.monitor(since.current || undefined);
        if (cancelled) return;

        const newest = Math.max(
          since.current,
          ...next.samples.map((sample) => sample.at),
          ...next.events.map((event) => event.at),
        );
        since.current = Number.isFinite(newest) ? newest : since.current;

        setSnapshot((current) => ({
          ...next,
          samples: trim([...(current?.samples ?? []), ...next.samples], MAX_SAMPLES),
          events: trim([...(current?.events ?? []), ...next.events], MAX_EVENTS),
        }));
      } catch {
        // A dropped poll is not worth reporting; the next one is two seconds away.
      }
    };

    void tick();
    const timer = window.setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  return snapshot;
}

function trim<T>(list: T[], max: number): T[] {
  return list.length > max ? list.slice(list.length - max) : list;
}

function gib(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(1);
}

function clock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
