/**
 * The way out of a batch, at the foot of both picture pickers.
 *
 * Shown once something is ticked, or while the slot already has a list — the
 * second because unticking the last picture of a list is a change too, and
 * hiding the bar at that moment left nothing to confirm it with: the slot
 * went on running through the list you had just emptied.
 *
 * Clear takes effect at once rather than waiting for a confirmation. It is
 * the one button here whose meaning cannot be misread, and it used to only
 * untick the boxes — which hid the bar, so the list it was meant to clear
 * stayed exactly as it was.
 *
 * Sticky to the bottom of the sheet's own scroll, because ticking the twelfth
 * picture happens a long way down a folder.
 */
export function BatchBar({
  checked,
  batch,
  onChange,
  onClose,
}: {
  /** What is ticked right now, in order. */
  checked: string[];
  /** The list the slot is already working through. */
  batch: string[];
  /** Hand the list back to the slot. An empty one ends the batch. */
  onChange: (list: string[]) => void;
  onClose: () => void;
}) {
  if (checked.length === 0 && batch.length === 0) return null;

  return (
    <div className="sticky bottom-0 -mx-1 flex items-center gap-2 border-t border-line bg-surface/95 px-1 py-2 backdrop-blur">
      <span className="min-w-0 flex-1 text-xs text-muted">
        {checked.length > 0
          ? `${checked.length} ticked — one per run, then back to the first.`
          : 'Nothing ticked.'}
      </span>
      {checked.length > 0 && (
        <button
          type="button"
          onClick={() => onChange([])}
          className="shrink-0 px-2 py-1.5 text-xs text-muted"
        >
          Clear
        </button>
      )}
      <button
        type="button"
        onClick={() => {
          onChange(checked);
          onClose();
        }}
        className="shrink-0 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white"
      >
        {checked.length > 0 ? `Use ${checked.length}` : 'End the batch'}
      </button>
    </div>
  );
}
