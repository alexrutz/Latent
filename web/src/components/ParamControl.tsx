import { useEffect, useMemo, useRef, useState } from 'react';

import type { ParamField, WidgetValue } from '@latent/shared';

import { api, imageUrl } from '../api/client';
import { NumericInput } from './NumericInput';
import { Button, cn, ErrorNote, Sheet, Spinner } from './ui';

interface ControlProps {
  field: ParamField;
  value: WidgetValue;
  onChange: (value: WidgetValue) => void;
}

const MAX_SAFE_SEED = Number.MAX_SAFE_INTEGER;

/* ------------------------------------------------------------------ */
/* Prompt (multiline text)                                             */
/* ------------------------------------------------------------------ */

/** Grows with its content so a long prompt never hides behind a scrollbar. */
export function PromptField({ field, value, onChange, compact = false }: ControlProps & { compact?: boolean }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const text = typeof value === 'string' ? value : String(value ?? '');

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, compact ? 140 : 260)}px`;
  }, [text, compact]);

  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium tracking-wide text-muted uppercase">
        {field.label}
      </span>
      <textarea
        ref={ref}
        value={text}
        onChange={(event) => onChange(event.target.value)}
        rows={compact ? 2 : 3}
        placeholder={field.role === 'negative_prompt' ? 'What to avoid…' : 'Describe the image…'}
        className={cn(
          'w-full resize-none rounded-2xl border border-line bg-surface px-4 py-3',
          'leading-relaxed placeholder:text-muted/60',
          'focus:border-accent focus:outline-none',
        )}
      />
    </label>
  );
}

/* ------------------------------------------------------------------ */
/* Seed                                                                */
/* ------------------------------------------------------------------ */

export function SeedField({
  field,
  value,
  onChange,
  locked,
  onToggleLock,
}: ControlProps & { locked: boolean; onToggleLock: () => void }) {
  const seed = typeof value === 'number' ? value : Number(value ?? 0);

  return (
    <div className="flex items-center gap-2">
      <div className="flex min-w-0 flex-1 items-center gap-2 rounded-xl border border-line bg-surface px-3">
        <span className="shrink-0 text-xs text-muted">Seed</span>
        <NumericInput
          value={Number.isFinite(seed) ? seed : 0}
          onChange={onChange}
          integer
          min={0}
          max={field.max}
          aria-label="Seed"
          className="min-w-0 flex-1 border-0 bg-transparent px-0 text-right focus:border-0"
        />
      </div>
      <button
        type="button"
        onClick={() => onChange(Math.floor(Math.random() * Math.min(field.max ?? 2 ** 32, MAX_SAFE_SEED)))}
        aria-label="Roll a new seed"
        className="grid size-11 shrink-0 place-items-center rounded-xl bg-surface-2 text-lg active:bg-surface-3"
      >
        🎲
      </button>
      <button
        type="button"
        onClick={onToggleLock}
        aria-pressed={locked}
        aria-label={locked ? 'Unlock seed' : 'Lock seed'}
        title={locked ? 'Seed is fixed for every run' : 'A new seed is used each run'}
        className={cn(
          'grid size-11 shrink-0 place-items-center rounded-xl text-lg active:bg-surface-3',
          locked ? 'bg-accent/20 text-accent' : 'bg-surface-2',
        )}
      >
        {locked ? '🔒' : '🔓'}
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Image input                                                         */
/* ------------------------------------------------------------------ */

export function ImageField({ field, value, onChange }: ControlProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const filename = typeof value === 'string' ? value : '';

  const upload = async (file: File) => {
    setUploading(true);
    setError(null);
    try {
      const result = await api.upload(file);
      // ComfyUI addresses uploads in subfolders as "sub/name".
      onChange(result.subfolder ? `${result.subfolder}/${result.name}` : result.name);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="space-y-2">
      <span className="block text-xs font-medium tracking-wide text-muted uppercase">
        {field.label}
      </span>

      <div className="flex items-center gap-3">
        <div className="size-20 shrink-0 overflow-hidden rounded-xl border border-line bg-surface-2">
          {filename ? (
            <img
              src={imageUrl({ filename, subfolder: '', type: 'input' })}
              alt=""
              className="size-full object-cover"
              // A stale filename (input dir cleared) shouldn't show a broken icon.
              onError={(event) => {
                event.currentTarget.style.visibility = 'hidden';
              }}
            />
          ) : (
            <div className="grid size-full place-items-center text-2xl opacity-30">🖼</div>
          )}
        </div>

        <div className="min-w-0 flex-1 space-y-2">
          <p className="truncate text-sm text-muted">{filename || 'No image selected'}</p>
          <Button
            variant="secondary"
            size="sm"
            busy={uploading}
            onClick={() => inputRef.current?.click()}
          >
            {uploading ? 'Uploading…' : filename ? 'Replace' : 'Choose photo'}
          </Button>
        </div>
      </div>

      {/*
        No `capture` attribute: it forces the camera and hides the photo
        library, which is the wrong default when most img2img inputs are
        existing pictures. The OS sheet offers the camera anyway.
      */}
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void upload(file);
          event.target.value = '';
        }}
      />

      <ErrorNote>{error}</ErrorNote>
      {uploading && <Spinner className="size-4 text-muted" />}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Chip + sheet editor for numbers, combos and booleans                */
/* ------------------------------------------------------------------ */

export function formatValue(field: ParamField, value: WidgetValue): string {
  if (value === null || value === undefined || value === '') return '—';
  if (field.control === 'boolean') return value ? 'On' : 'Off';
  if (field.control === 'float') {
    const n = Number(value);
    return Number.isFinite(n) ? String(Number(n.toFixed(3))) : String(value);
  }
  const text = String(value);
  // Model filenames are long and the meaningful part is the end.
  if (field.role === 'model' || field.role === 'lora' || field.role === 'vae') {
    return text.replace(/\.(safetensors|ckpt|pth|gguf|pt)$/i, '').split(/[\\/]/).pop() ?? text;
  }
  return text.length > 18 ? `${text.slice(0, 17)}…` : text;
}

export function FieldChip({ field, value, onChange }: ControlProps) {
  const [open, setOpen] = useState(false);

  if (field.control === 'boolean') {
    return (
      <button
        type="button"
        onClick={() => onChange(!value)}
        aria-pressed={Boolean(value)}
        className={cn(
          'flex h-11 shrink-0 items-center gap-2 rounded-xl border px-3 whitespace-nowrap',
          value ? 'border-accent/50 bg-accent/15 text-accent' : 'border-line bg-surface text-muted',
        )}
      >
        <span className="text-xs">{field.label}</span>
        <span className="text-sm font-medium">{value ? 'On' : 'Off'}</span>
      </button>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex h-11 shrink-0 items-center gap-2 rounded-xl border border-line bg-surface px-3 whitespace-nowrap active:bg-surface-2"
      >
        <span className="text-xs text-muted">{field.label}</span>
        <span className="text-sm font-medium tabular-nums">{formatValue(field, value)}</span>
      </button>

      <Sheet open={open} onClose={() => setOpen(false)} title={field.label}>
        <FieldEditor field={field} value={value} onChange={onChange} />
      </Sheet>
    </>
  );
}

/** The full-size control shown inside a sheet. */
export function FieldEditor({ field, value, onChange }: ControlProps) {
  switch (field.control) {
    case 'combo':
      return <ComboEditor field={field} value={value} onChange={onChange} />;
    case 'int':
    case 'float':
      return <NumberEditor field={field} value={value} onChange={onChange} />;
    case 'boolean':
      return (
        <div className="flex items-center justify-between py-3">
          <span>{field.label}</span>
          <Toggle checked={Boolean(value)} onChange={onChange} />
        </div>
      );
    case 'textarea':
      return <PromptField field={field} value={value} onChange={onChange} />;
    case 'image':
      return <ImageField field={field} value={value} onChange={onChange} />;
    case 'text':
    default:
      return (
        <input
          type="text"
          value={typeof value === 'string' ? value : String(value ?? '')}
          onChange={(event) => onChange(event.target.value)}
          className="w-full rounded-xl border border-line bg-surface px-4 py-3 focus:border-accent focus:outline-none"
        />
      );
  }
}

function NumberEditor({ field, value, onChange }: ControlProps) {
  const numeric = Number(value ?? field.defaultValue ?? 0);
  const current = Number.isFinite(numeric) ? numeric : 0;
  const isInt = field.control === 'int';
  const step = field.step ?? (isInt ? 1 : 0.01);

  /*
   * Two ranges, and the difference is the whole point.
   *
   * `min`/`max` are what ComfyUI will tolerate — steps up to 10000. Spanning
   * that on a phone-width slider gives ~40 steps per pixel, so the control is
   * decorative. `softMin`/`softMax` are the range people actually work in; the
   * toggle below reaches the full one when it is genuinely needed, and the
   * number field always accepts anything within the hard limits.
   */
  const [fullRange, setFullRange] = useState(false);
  const hasSoftRange = field.softMin !== undefined && field.softMax !== undefined;

  const sliderMin = (fullRange || !hasSoftRange ? field.min : field.softMin) ?? field.min ?? 0;
  const sliderMax = (fullRange || !hasSoftRange ? field.max : field.softMax) ?? field.max ?? 0;
  const showSlider =
    Number.isFinite(sliderMin) && Number.isFinite(sliderMax) && sliderMax > sliderMin;

  // A value nudged past the soft range from elsewhere must still be visible on
  // the slider rather than pinned silently at one end.
  const outsideSoftRange = hasSoftRange && (current < sliderMin || current > sliderMax);

  return (
    <div className="space-y-5 py-2">
      <NumericInput
        value={current}
        onChange={onChange}
        integer={isInt}
        min={field.min}
        max={field.max}
        step={step}
        aria-label={field.label}
        className="w-full text-center text-2xl font-semibold"
      />

      {showSlider && (
        <input
          type="range"
          min={outsideSoftRange ? (field.min ?? sliderMin) : sliderMin}
          max={outsideSoftRange ? (field.max ?? sliderMax) : sliderMax}
          step={step}
          value={current}
          onChange={(event) => onChange(Number(event.target.value))}
          className="h-11 w-full accent-[var(--color-accent)]"
          aria-label={`${field.label} slider`}
        />
      )}

      <div className="flex items-center justify-between text-xs text-muted">
        <span className="tabular-nums">
          {showSlider ? `${trim(sliderMin)} – ${trim(sliderMax)}` : 'No limit'}
        </span>
        {hasSoftRange && (
          <button
            type="button"
            onClick={() => setFullRange((current) => !current)}
            className="rounded-lg px-2 py-1 text-accent active:bg-surface-2"
          >
            {fullRange ? 'Usual range' : `Full range (${trim(field.min ?? 0)}–${trim(field.max ?? 0)})`}
          </button>
        )}
      </div>

      {field.tooltip && <p className="text-sm text-muted">{field.tooltip}</p>}
    </div>
  );
}

/** Keep range labels short — `2048` not `2048.0000001`. */
function trim(value: number): string {
  return String(Number(value.toFixed(3)));
}

function ComboEditor({ field, value, onChange }: ControlProps) {
  const [filter, setFilter] = useState('');
  const options = field.options ?? [];

  const filtered = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return options;
    return options.filter((option) => option.toLowerCase().includes(needle));
  }, [filter, options]);

  return (
    <div className="space-y-3">
      {/* Model lists on a well-stocked server run to hundreds of entries. */}
      {options.length > 8 && (
        <input
          type="search"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filter…"
          className="w-full rounded-xl border border-line bg-surface px-4 py-3 focus:border-accent focus:outline-none"
        />
      )}

      <ul className="space-y-1">
        {filtered.map((option) => {
          const selected = option === value;
          return (
            <li key={option}>
              <button
                type="button"
                onClick={() => onChange(option)}
                className={cn(
                  'flex w-full items-center justify-between gap-3 rounded-xl px-4 py-3 text-left',
                  selected ? 'bg-accent/15 text-accent' : 'active:bg-surface-2',
                )}
              >
                <span className="min-w-0 truncate">{option}</span>
                {selected && <span aria-hidden>✓</span>}
              </button>
            </li>
          );
        })}
        {filtered.length === 0 && (
          <li className="px-4 py-6 text-center text-sm text-muted">Nothing matches “{filter}”.</li>
        )}
      </ul>
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative h-7 w-12 shrink-0 rounded-full transition-colors',
        checked ? 'bg-accent' : 'bg-surface-3',
      )}
    >
      <span
        className={cn(
          'absolute top-1 size-5 rounded-full bg-white transition-transform',
          checked ? 'translate-x-6' : 'translate-x-1',
        )}
      />
    </button>
  );
}
