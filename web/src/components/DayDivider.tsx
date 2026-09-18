import { cn } from './ui';

/**
 * The line between two days, which is also the control that folds one away.
 *
 * A separate chevron would be a second thing to aim at on a phone; the line
 * between two days is already the boundary you are thinking about, so tapping
 * it is what folds the day away. The whole row is the target, which on a phone
 * is the difference between a control and a decoration.
 *
 * Shared by the gallery and the favourites because a day is a day: two screens
 * that fold on the same rule and disagreed about what a fold looks like would
 * be two screens you have to learn separately.
 */
export function DayDivider({
  label,
  count,
  shown,
  noun,
  open,
  onToggle,
  className,
}: {
  label: string;
  /** Everything in the day, which is what the count means. */
  count: number;
  /** How much of it is drawn. Equal to `count` unless the day is folded. */
  shown: number;
  /**
   * What the things in this list are called, singular and plural.
   *
   * The count is only read aloud, and "3 items" is what a screen reader says
   * about a list it does not understand. The two screens do know — one holds
   * pictures and the other favourites — so they say so.
   */
  noun: [string, string];
  open: boolean;
  onToggle: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      data-testid="day-divider"
      onClick={onToggle}
      aria-expanded={open}
      aria-label={`${label}, ${count} ${count === 1 ? noun[0] : noun[1]}`}
      className={cn('mt-2 mb-2 flex w-full items-center gap-2 text-left', className)}
    >
      <span aria-hidden className="text-[10px] text-muted">
        {open ? '▾' : '▸'}
      </span>
      <span className="shrink-0 text-xs font-medium">{label}</span>
      <span className="shrink-0 text-[11px] text-muted tabular-nums">{count}</span>
      <span className="h-px min-w-0 flex-1 bg-line" />
      {/*
        What a folded day is showing you, said in the heading.

        Without it the strip underneath looks like the whole day and the count
        beside the date looks wrong — which is the one way folding could
        actively mislead rather than merely hide.
      */}
      {!open && shown < count && (
        <span className="shrink-0 text-[11px] text-muted">{shown} shown</span>
      )}
    </button>
  );
}
