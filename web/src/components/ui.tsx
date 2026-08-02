import { createPortal } from 'react-dom';
import {
  useEffect,
  useRef,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type ReactNode,
} from 'react';

export function cn(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

/* ------------------------------------------------------------------ */
/* Button                                                              */
/* ------------------------------------------------------------------ */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  /** `lg` is the one primary action at the bottom of a screen. */
  size?: 'sm' | 'md' | 'lg';
  busy?: boolean;
  /**
   * Stretch to the container. Defaults on for `lg`, which is nearly always the
   * full-width action — but not always, and `w-full` in the size class could not
   * be overridden reliably from outside, since which of two width utilities wins
   * depends on stylesheet order rather than on the order they are written in.
   */
  fullWidth?: boolean;
}

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-white active:bg-accent-hi disabled:bg-surface-3 disabled:text-muted',
  secondary: 'bg-surface-2 text-body active:bg-surface-3 disabled:text-muted',
  ghost: 'bg-transparent text-muted active:bg-surface-2',
  danger: 'bg-danger/15 text-danger active:bg-danger/25',
};

/*
 * Heights are the tap target, not decoration: 44px is Apple's minimum and 40 is
 * about the floor for a thumb, so `sm` and `md` sit there rather than being
 * padded out further. `lg` is the one full-width primary action per screen and
 * stays generous, since it is what you aim at without looking.
 */
const SIZES = {
  sm: 'h-8 px-2.5 text-sm rounded-lg',
  md: 'h-10 px-3.5 text-[15px] rounded-xl',
  lg: 'h-12 px-5 text-base rounded-xl',
};

export function Button({
  variant = 'secondary',
  size = 'md',
  busy = false,
  fullWidth,
  className,
  children,
  disabled,
  ...rest
}: ButtonProps) {
  const stretch = fullWidth ?? size === 'lg';
  return (
    <button
      {...rest}
      disabled={disabled || busy}
      className={cn(
        'inline-flex items-center justify-center gap-2 font-medium transition-colors select-none',
        'disabled:opacity-60',
        VARIANTS[variant],
        SIZES[size],
        stretch && 'w-full',
        className,
      )}
    >
      {busy && <Spinner className="size-4" />}
      {children}
    </button>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg className={cn('animate-spin', className)} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Bottom sheet                                                        */
/* ------------------------------------------------------------------ */

interface SheetProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  /** Fill the screen instead of hugging its content. */
  full?: boolean;
  /**
   * Label for the header's dismiss button.
   *
   * "Done" is right when closing the sheet keeps what you changed, which is how
   * nearly every sheet here works. A sheet that only commits on an explicit
   * action must say "Cancel" instead — otherwise the header button looks like
   * the way to accept the edit and silently throws it away.
   */
  closeLabel?: string;
}

/**
 * A bottom sheet, which is how every non-trivial control is edited here.
 *
 * Editing a number in a cramped inline field is the worst part of using a
 * desktop UI on a phone; raising a sheet puts the control under the thumb and
 * gives it room to be a real slider or a real list.
 */
export function Sheet({
  open,
  onClose,
  title,
  children,
  full = false,
  closeLabel = 'Done',
}: SheetProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    // Stop the page behind the sheet from scrolling with it.
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [open, onClose]);

  if (!open) return null;

  /*
   * Rendered into the body, not where it was declared.
   *
   * `position: sticky` establishes a stacking context, so a sheet opened from
   * the Generate screen's pinned footer was trapped inside it — and the tab
   * bar, which comes later in the document, painted straight over the bottom of
   * the panel. Everything down there, including "Dismiss", became untappable. A
   * modal has no business being confined by whichever element happens to own
   * the button that opened it.
   */
  return createPortal(
    /*
     * Above everything, including the image viewer and the terminal, which are
     * full-screen layers of their own. A sheet is only ever open because
     * something asked for it, so it is always the thing on top.
     */
    <div className="fixed inset-0 z-70 flex flex-col justify-end">
      <div
        className="animate-fade absolute inset-0 bg-black/60"
        onClick={onClose}
        role="presentation"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : 'Options'}
        className={cn(
          'animate-rise safe-b relative flex flex-col rounded-t-[var(--radius-sheet)]',
          'border-t border-line bg-surface',
          /*
           * `svh`, not `dvh`.
           *
           * The dynamic viewport unit measures the space available with the
           * browser's own UI hidden, which is not the space there is while it
           * is showing — so a sheet sized in `dvh` hangs off the bottom of the
           * screen, and its last row of buttons ends up under the tab bar where
           * nothing can reach it. The small viewport is the one that is always
           * true.
           */
          full ? 'h-[92svh]' : 'max-h-[85svh]',
        )}
      >
        <div className="flex shrink-0 items-center justify-between px-4 pt-2 pb-1">
          <div className="mx-auto h-1 w-10 rounded-full bg-surface-3" />
        </div>
        {title && (
          <div className="flex shrink-0 items-center justify-between gap-3 px-4 pb-2">
            <h2 className="text-base font-semibold">{title}</h2>
            {/*
              No aria-label here: it would override the visible text, so the
              button would read as "Close" to a screen reader while showing
              "Done" on screen — the mismatch WCAG's Label in Name forbids.
            */}
            <Button variant="ghost" size="sm" onClick={onClose}>
              {closeLabel}
            </Button>
          </div>
        )}
        {/*
          Scrolls up and down only. Without the horizontal clamp a single long
          value — a file path, a model's answer — makes the whole panel wider
          than the screen and the sheet can be dragged sideways off it, which
          reads as the app coming apart. `touch-pan-y` says the same thing to
          the browser's gesture handling, so the drag never starts.
        */}
        <div className="min-h-0 flex-1 touch-pan-y overflow-x-hidden overflow-y-auto overscroll-contain px-4 pb-4">
          {children}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/* ------------------------------------------------------------------ */
/* Misc                                                                */
/* ------------------------------------------------------------------ */

export function Card({
  children,
  className,
  ...rest
}: { children: ReactNode; className?: string } & HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...rest} className={cn('rounded-xl border border-line bg-surface p-3', className)}>
      {children}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  hint,
  action,
}: {
  icon?: ReactNode;
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-8 py-12 text-center">
      {icon && <div className="text-4xl opacity-40">{icon}</div>}
      <p className="text-base font-medium">{title}</p>
      {hint && <p className="max-w-xs text-sm text-muted">{hint}</p>}
      {action}
    </div>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p
      role="alert"
      className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-1.5 text-sm text-danger"
    >
      {children}
    </p>
  );
}

/** A labelled row used throughout Settings. */
export function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <div className="min-w-0">
        <p className="truncate text-[15px]">{label}</p>
        {hint && <p className="truncate text-xs text-muted">{hint}</p>}
      </div>
      {children}
    </div>
  );
}
