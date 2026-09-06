import { GO_KEYS, KEYS } from '../state/hotkeys';
import { Sheet } from './ui';

/**
 * What the keyboard does, on the key that asks.
 *
 * The list has to exist somewhere or the shortcuts are folklore, and a settings
 * page is the wrong somewhere — you want it at the moment you are wondering,
 * which is while your hands are on the keys. `?` is the key every program that
 * has ever had a shortcut list has used for it.
 *
 * Generated from the same arrays the handler reads, so a binding cannot be
 * added without appearing here or documented without existing.
 */
export function KeyMap({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Sheet open={open} onClose={onClose} title="Keyboard" closeLabel="Close">
      <div className="space-y-4">
        <dl className="space-y-1">
          {KEYS.map((entry) => (
            <Row key={entry.keys} keys={entry.keys} does={entry.does} />
          ))}
        </dl>

        <div>
          <p className="mb-1.5 text-xs tracking-wide text-muted uppercase">Go to</p>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
            {GO_KEYS.map((entry) => (
              <Row key={entry.to} keys={`g ${entry.key}`} does={entry.label} />
            ))}
          </dl>
        </div>

        <p className="text-xs text-muted">
          None of these are the only way to do the thing they do — every one of them is a button
          somewhere. They stop working while you are typing, so a prompt with the word “gallery” in
          it stays a prompt.
        </p>
      </div>
    </Sheet>
  );
}

function Row({ keys, does }: { keys: string; does: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-line/50 pb-1">
      <dt className="shrink-0">
        <kbd className="rounded-md bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-body">
          {keys}
        </kbd>
      </dt>
      <dd className="min-w-0 truncate text-right text-sm text-muted">{does}</dd>
    </div>
  );
}
