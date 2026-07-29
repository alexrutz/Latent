import { useEffect, useRef, useState } from 'react';

import { cn } from './ui';

/**
 * Parse a number the way a phone keyboard produces it.
 *
 * German (and most non-English) layouts put a **comma** on the decimal key and
 * offer no period at all, so `<input type="number">` — which only accepts the
 * locale the browser guesses — silently refuses the keystroke. A CFG of 7,5
 * simply cannot be typed. Treating both separators as equivalent is the only
 * thing that makes these fields usable.
 */
export function parseDecimal(raw: string): number | null {
  const cleaned = raw.replace(/\s/g, '').replace(',', '.');
  if (cleaned === '' || cleaned === '-' || cleaned === '.' || cleaned === '-.') return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

/** True while the user is mid-way through typing something not yet parseable. */
export function isPartialNumber(raw: string): boolean {
  return /^-?\d*[.,]?\d*$/.test(raw.trim());
}

interface NumericInputProps {
  value: number;
  onChange: (value: number) => void;
  /** Integers get the numeric keypad; floats get the one with a separator key. */
  integer?: boolean;
  min?: number;
  max?: number;
  step?: number;
  className?: string;
  'aria-label'?: string;
}

/**
 * A number field backed by a text input.
 *
 * Deliberately not `type="number"`: besides the comma problem, it also lets a
 * half-typed value like `7,` survive a re-render instead of being normalised
 * out from under the cursor.
 */
export function NumericInput({
  value,
  onChange,
  integer = false,
  min,
  max,
  step,
  className,
  'aria-label': ariaLabel,
}: NumericInputProps) {
  const [draft, setDraft] = useState(() => String(value));
  const focused = useRef(false);

  // Track external changes (a slider moving, a preset applied) — but never
  // while the field has focus, or typing would fight the parent.
  useEffect(() => {
    if (focused.current) return;
    setDraft(String(value));
  }, [value]);

  const commit = (raw: string) => {
    const parsed = parseDecimal(raw);
    if (parsed === null) {
      setDraft(String(value));
      return;
    }
    let next = integer ? Math.round(parsed) : parsed;
    if (min !== undefined) next = Math.max(min, next);
    if (max !== undefined) next = Math.min(max, next);
    setDraft(String(next));
    onChange(next);
  };

  return (
    <input
      type="text"
      // `decimal` shows a keypad with the locale's separator; `numeric` omits it.
      inputMode={integer ? 'numeric' : 'decimal'}
      // Hints iOS/Android to offer digits first even in the text keyboard.
      pattern={integer ? '[0-9]*' : '[0-9.,]*'}
      autoComplete="off"
      autoCorrect="off"
      spellCheck={false}
      value={draft}
      step={step}
      aria-label={ariaLabel}
      onFocus={() => {
        focused.current = true;
      }}
      onChange={(event) => {
        const raw = event.target.value;
        // Let anything number-shaped through as you type; validate on commit.
        if (raw === '' || isPartialNumber(raw)) {
          setDraft(raw);
          const parsed = parseDecimal(raw);
          if (parsed !== null) {
            const clamped =
              max !== undefined && parsed > max
                ? max
                : min !== undefined && parsed < min
                  ? parsed // don't fight someone typing "1" on the way to "12"
                  : parsed;
            onChange(integer ? Math.round(clamped) : clamped);
          }
        }
      }}
      onBlur={(event) => {
        focused.current = false;
        commit(event.target.value);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
      }}
      className={cn(
        'rounded-xl border border-line bg-surface px-4 py-3 tabular-nums',
        'focus:border-accent focus:outline-none',
        className,
      )}
    />
  );
}
