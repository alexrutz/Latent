import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

import { GRAPH_METRICS, graphView, slotColor, slotY } from '@latent/shared';
import type { ApiWorkflow, GraphNode, ObjectInfo } from '@latent/shared';

import { cn } from './ui';

/**
 * The workflow, drawn as ComfyUI's editor draws it, with nodes to bypass.
 *
 * Bypassing used to be a switch per node in Advanced, one among dozens of
 * settings, found by reading headings. Here the node is where it is in the
 * graph: tap it, and bypass it. It turns purple, as in the editor, and is
 * left out of the run.
 *
 * Laid out from the API graph by `graphView`, since the API export keeps no
 * positions. Moves under one finger, zooms under two or the wheel; a tap that
 * did not move picks a node, and a tap on nothing puts it down again.
 */

/** The editor's dark palette (ComfyUI_frontend `palettes/dark.json`). */
const PALETTE = {
  background: '#141414',
  grid: '#262626',
  node: '#353535',
  title: '#333333',
  titleText: '#999999',
  titleSelected: '#FFFFFF',
  text: '#AAAAAA',
  box: '#666666',
  widget: '#222222',
  widgetOutline: '#666666',
  widgetText: '#DDDDDD',
  widgetLabel: '#999999',
  bypass: '#FF00FF',
};

interface View {
  x: number;
  y: number;
  k: number;
}

const MIN_ZOOM = 0.12;
const MAX_ZOOM = 2.5;
const clampZoom = (k: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));
/** The smallest zoom the view opens at, where node text can still be read. */
const READABLE = 0.6;
/** How far a finger may drift and still be a tap. */
const TAP_SLOP = 6;

type Gesture =
  | {
      kind: 'pan';
      start: { x: number; y: number };
      from: View;
      moved: boolean;
      node: string | null;
    }
  | { kind: 'pinch'; distance: number; middle: { x: number; y: number }; from: View };

export function WorkflowGraph({
  workflow,
  definitions,
  bypassed,
  onToggleBypass,
  onClearBypass,
  problem,
}: {
  workflow: ApiWorkflow;
  definitions: ObjectInfo;
  /** Node ids switched off for this run. */
  bypassed: ReadonlySet<string>;
  onToggleBypass: (nodeId: string) => void;
  onClearBypass: () => void;
  /** Why the current bypasses would be refused, if they would. */
  problem?: string;
}) {
  const layout = useMemo(() => graphView(workflow, definitions), [workflow, definitions]);
  const byId = useMemo(() => new Map(layout.nodes.map((node) => [node.id, node])), [layout]);

  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [view, setViewState] = useState<View>({ x: 0, y: 0, k: 1 });
  const viewRef = useRef(view);
  const setView = useCallback((next: View) => {
    viewRef.current = next;
    setViewState(next);
  }, []);
  const [selected, setSelected] = useState<string | null>(null);

  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<Gesture | null>(null);

  /** The whole graph in view, centred. */
  /**
   * The whole graph in view, centred — or, to open with, as much of it as
   * can be read.
   *
   * A graph is far wider than a phone is, and the whole of it fitted in is
   * nodes the size of a fingernail with text nobody can read. So the first
   * view is never smaller than `READABLE`: it starts at the left, where the
   * loaders are, and the rest is a swipe away. Fit shows everything.
   */
  const fit = useCallback(
    (readable = false) => {
      const area = box.current?.getBoundingClientRect();
      if (!area || area.width === 0 || layout.nodes.length === 0) return;
      const margin = 24;
      const across = (area.width - margin * 2) / Math.max(1, layout.width);
      const down = (area.height - margin * 2) / Math.max(1, layout.height);
      const whole = clampZoom(Math.min(across, down, 1));
      const k = readable ? clampZoom(Math.max(whole, Math.min(READABLE, down))) : whole;
      setView({
        k,
        x: layout.width * k <= area.width - margin * 2 ? (area.width - layout.width * k) / 2 : margin,
        y: Math.max(margin, (area.height - layout.height * k) / 2),
      });
    },
    [layout, setView],
  );

  // Measured, and fitted the first time there is something to fit into.
  const fitted = useRef(false);
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!size || fitted.current || layout.nodes.length === 0) return;
    fitted.current = true;
    fit(true);
  }, [size, fit, layout.nodes.length]);

  const local = (event: { clientX: number; clientY: number }) => {
    const area = box.current!.getBoundingClientRect();
    return { x: event.clientX - area.left, y: event.clientY - area.top };
  };

  /** Zoom by `factor` keeping the graph point under `at` where it is. */
  const zoomAt = useCallback(
    (at: { x: number; y: number }, k: number, from: View = viewRef.current) => {
      const next = clampZoom(k);
      const gx = (at.x - from.x) / from.k;
      const gy = (at.y - from.y) / from.k;
      setView({ k: next, x: at.x - gx * next, y: at.y - gy * next });
    },
    [setView],
  );

  // The wheel needs a listener that may prevent the page scrolling.
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const at = local(event);
      zoomAt(at, viewRef.current.k * Math.exp(-event.deltaY * 0.0015));
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [zoomAt]);

  // Ctrl+B, as in the editor.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!selected || event.key.toLowerCase() !== 'b' || !(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      onToggleBypass(selected);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [selected, onToggleBypass]);

  const pair = () => {
    const [a, b] = [...pointers.current.values()];
    return {
      distance: Math.hypot(a!.x - b!.x, a!.y - b!.y),
      middle: { x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2 },
    };
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    // Buttons over the graph handle their own taps.
    if ((event.target as Element).closest('[data-overlay]')) return;
    box.current?.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, local(event));
    if (pointers.current.size === 1) {
      const node =
        (event.target as Element).closest('[data-node]')?.getAttribute('data-node') ?? null;
      gesture.current = {
        kind: 'pan',
        start: local(event),
        from: viewRef.current,
        moved: false,
        node,
      };
    } else if (pointers.current.size === 2) {
      gesture.current = { kind: 'pinch', ...pair(), from: viewRef.current };
    }
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, local(event));
    const current = gesture.current;
    if (!current) return;
    if (current.kind === 'pan') {
      const at = local(event);
      const dx = at.x - current.start.x;
      const dy = at.y - current.start.y;
      if (!current.moved && Math.hypot(dx, dy) < TAP_SLOP) return;
      current.moved = true;
      setView({ ...current.from, x: current.from.x + dx, y: current.from.y + dy });
    } else if (pointers.current.size >= 2) {
      const { distance, middle } = pair();
      const k = clampZoom((current.from.k * distance) / Math.max(1, current.distance));
      // The point that was under the fingers stays under them, wherever they go.
      const gx = (current.middle.x - current.from.x) / current.from.k;
      const gy = (current.middle.y - current.from.y) / current.from.k;
      setView({ k, x: middle.x - gx * k, y: middle.y - gy * k });
    }
  };

  const onPointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.delete(event.pointerId);
    const current = gesture.current;
    if (current?.kind === 'pan' && !current.moved && event.type === 'pointerup') {
      setSelected(current.node);
    }
    if (pointers.current.size === 1) {
      // One finger left after a pinch carries on as a pan, without a jump.
      const [rest] = [...pointers.current.values()];
      gesture.current = {
        kind: 'pan',
        start: rest!,
        from: viewRef.current,
        moved: true,
        node: null,
      };
    } else if (pointers.current.size === 0) {
      gesture.current = null;
    }
  };

  const chosen = selected ? byId.get(selected) : undefined;
  const count = bypassed.size;

  return (
    <div
      ref={box}
      className="relative h-full min-h-[320px] w-full touch-none overflow-hidden rounded-xl select-none"
      style={{
        backgroundColor: PALETTE.background,
        backgroundImage: `radial-gradient(${PALETTE.grid} 1px, transparent 1px)`,
        backgroundSize: `${20 * view.k}px ${20 * view.k}px`,
        backgroundPosition: `${view.x}px ${view.y}px`,
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      data-testid="workflow-graph"
    >
      <svg className="absolute inset-0 h-full w-full" role="group" aria-label="Workflow graph">
        <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
          {layout.links.map((link) => {
            const from = byId.get(link.from);
            const to = byId.get(link.to);
            if (!from || !to) return null;
            const x1 = from.x + from.width;
            const y1 = slotY(from, link.fromSlot);
            const x2 = to.x;
            const y2 = slotY(to, link.toSlot);
            const dx = Math.max(40, Math.abs(x2 - x1) * 0.5);
            const dim = bypassed.has(link.from) || bypassed.has(link.to);
            return (
              <path
                key={`${link.from}:${link.fromSlot}>${link.to}:${link.toSlot}`}
                d={`M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`}
                fill="none"
                stroke={slotColor(link.type)}
                strokeWidth={2.5}
                opacity={dim ? 0.3 : 0.85}
              />
            );
          })}
          {layout.nodes.map((node) => (
            <NodeShape
              key={node.id}
              node={node}
              bypassed={bypassed.has(node.id)}
              selected={node.id === selected}
              onSelect={setSelected}
            />
          ))}
        </g>
      </svg>

      {/* What is switched off, and the way back from all of it at once. */}
      <div className="pointer-events-none absolute inset-x-2 top-2 flex items-start justify-between gap-2">
        <div className="pointer-events-auto flex items-center gap-2" data-overlay>
          {count > 0 ? (
            <>
              <span className="rounded-lg bg-fuchsia-600/90 px-2 py-1 text-xs text-white">
                {count} bypassed
              </span>
              <button
                type="button"
                onClick={onClearBypass}
                className="rounded-lg bg-surface/90 px-2 py-1 text-xs text-muted"
              >
                Clear
              </button>
            </>
          ) : (
            <span className="rounded-lg bg-surface/80 px-2 py-1 text-xs text-muted">
              Tap a node to bypass it
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => fit()}
          data-overlay
          className="pointer-events-auto rounded-lg bg-surface/90 px-2 py-1 text-xs text-muted"
        >
          Fit
        </button>
      </div>

      {(chosen || problem) && (
        <div className="absolute inset-x-2 bottom-2 space-y-1.5" data-overlay>
          {problem && (
            <p className="rounded-lg bg-surface/95 px-3 py-2 text-xs text-warn" role="status">
              {problem}
            </p>
          )}
          {chosen && (
            <div className="flex items-center gap-2 rounded-xl border border-line bg-surface/95 p-2 backdrop-blur">
              <div className="min-w-0 flex-1 px-1">
                <p className="truncate text-sm">{chosen.title}</p>
                <p className="truncate text-[11px] text-muted">
                  {chosen.classType} · #{chosen.id}
                  {!chosen.known && ' · not described by ComfyUI'}
                </p>
              </div>
              <button
                type="button"
                aria-pressed={bypassed.has(chosen.id)}
                onClick={() => onToggleBypass(chosen.id)}
                className={cn(
                  'shrink-0 rounded-lg px-3 py-2 text-sm font-medium',
                  bypassed.has(chosen.id) ? 'bg-fuchsia-600 text-white' : 'bg-surface-2 text-body',
                )}
              >
                {bypassed.has(chosen.id) ? 'Bypassed' : 'Bypass'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** One node, as the editor draws it. */
const NodeShape = memo(function NodeShape({
  node,
  bypassed,
  selected,
  onSelect,
}: {
  node: GraphNode;
  bypassed: boolean;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const { width: w, height: h } = node;
  const { title: titleHeight, slot, widget } = GRAPH_METRICS;
  const rows = Math.max(node.inputs.length, node.outputs.length);
  const widgetTop = titleHeight + rows * slot + 2;
  const r = 8;

  return (
    <g
      transform={`translate(${node.x} ${node.y})`}
      data-node={node.id}
      role="button"
      tabIndex={0}
      aria-label={`${node.title} node${bypassed ? ', bypassed' : ''}`}
      aria-pressed={selected}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect(node.id);
        }
      }}
      style={{ cursor: 'pointer', outline: 'none' }}
    >
      <rect width={w} height={h} rx={r} fill={PALETTE.node} />
      <path
        d={`M0,${r} a${r},${r} 0 0 1 ${r},-${r} h${w - 2 * r} a${r},${r} 0 0 1 ${r},${r} v${titleHeight - r} h-${w} z`}
        fill={PALETTE.title}
      />
      {/* Purple over the whole node, as the editor marks a bypass. */}
      {bypassed && <rect width={w} height={h} rx={r} fill={PALETTE.bypass} opacity={0.35} />}
      <rect
        width={w}
        height={h}
        rx={r}
        fill="none"
        stroke={selected ? '#FFFFFF' : node.known ? '#000000' : '#888888'}
        strokeOpacity={selected ? 1 : 0.6}
        strokeWidth={selected ? 2 : 1}
        strokeDasharray={node.known || selected ? undefined : '5 4'}
      />
      <circle cx={13} cy={titleHeight / 2} r={5} fill={bypassed ? PALETTE.bypass : PALETTE.box} />
      <text
        x={26}
        y={titleHeight / 2 + 4.5}
        fontSize={13}
        fill={selected ? PALETTE.titleSelected : PALETTE.titleText}
        textDecoration={bypassed ? 'line-through' : undefined}
      >
        {node.title}
      </text>

      {node.inputs.map((input, index) => {
        const cy = titleHeight + index * slot + slot / 2;
        const color = slotColor(input.type);
        return (
          <g key={`in-${input.name}`}>
            <circle
              cx={0}
              cy={cy}
              r={4.5}
              fill={input.link ? color : PALETTE.node}
              stroke={color}
              strokeWidth={1.5}
            />
            <text x={12} y={cy + 4} fontSize={11} fill={PALETTE.text}>
              {input.name}
            </text>
          </g>
        );
      })}
      {node.outputs.map((output, index) => {
        const cy = titleHeight + index * slot + slot / 2;
        return (
          <g key={`out-${index}`}>
            <circle cx={w} cy={cy} r={4.5} fill={slotColor(output.type)} />
            <text x={w - 12} y={cy + 4} fontSize={11} fill={PALETTE.text} textAnchor="end">
              {output.name}
            </text>
          </g>
        );
      })}
      {node.widgets.map((entry, index) => {
        const top = widgetTop + index * widget;
        return (
          <g key={`w-${entry.name}`}>
            <rect
              x={10}
              y={top + 2}
              width={w - 20}
              height={widget - 4}
              rx={(widget - 4) / 2}
              fill={PALETTE.widget}
              stroke={PALETTE.widgetOutline}
              strokeWidth={0.8}
            />
            <text x={22} y={top + widget / 2 + 4} fontSize={11} fill={PALETTE.widgetLabel}>
              {entry.name}
            </text>
            <text
              x={w - 22}
              y={top + widget / 2 + 4}
              fontSize={11}
              fill={PALETTE.widgetText}
              textAnchor="end"
            >
              {entry.value}
            </text>
          </g>
        );
      })}
    </g>
  );
});
