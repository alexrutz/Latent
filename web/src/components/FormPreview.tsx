import { planFormRuns, usesPointLine } from '@latent/shared';
import type { ParamField } from '@latent/shared';

import { cn } from './ui';

/**
 * What this form will look like on the phone, while you are arranging it.
 *
 * The editor is a list of rows with handles and switches — good for changing
 * things, useless for judging them. The question somebody is actually asking
 * while they drag is "does this read well on the screen I use", and until now
 * the only way to answer it was to pick the phone up.
 *
 * It draws the arrangement, not working controls: order, which fields share a
 * row, which take the whole width, what is on the main screen and what is
 * behind Advanced. Those are exactly the things the editor decides, and a
 * preview that stopped there is honest about being a preview — a column of live
 * controls would invite typing into it, and the values are not this screen's
 * business.
 *
 * The arrangement itself comes from `planFormRuns`, the same function the
 * generate screen lays itself out with, so the two cannot disagree about the
 * one thing this exists to show.
 */

/** Roughly a phone, so the two-column rhythm is the one you will really get. */
const PHONE_WIDTH = 300;

export function FormPreview({ fields }: { fields: ParamField[] }) {
  const visible = fields.filter((field) => !field.hidden);
  const main = visible.filter((field) => field.group === 'main');
  const advanced = visible.filter((field) => field.group === 'advanced');

  return (
    <div
      className="mx-auto overflow-hidden rounded-[2rem] border-4 border-line bg-surface p-3"
      style={{ width: PHONE_WIDTH }}
      aria-label="Preview of the form on a phone"
    >
      <div className="space-y-2">
        {main.length === 0 && advanced.length === 0 ? (
          <p className="py-8 text-center text-xs text-muted">
            Every field is hidden. The form would be empty.
          </p>
        ) : (
          <>
            {planFormRuns(main).map((run, index) =>
              run.kind === 'chips' ? (
                <div key={index} className="grid grid-cols-2 gap-1.5">
                  {run.fields.map((field) => (
                    <PreviewCell key={field.id} field={field} />
                  ))}
                </div>
              ) : (
                <PreviewCell key={index} field={run.fields[0]!} tall />
              ),
            )}

            {advanced.length > 0 && (
              <div className="space-y-1.5 pt-1">
                {/* Drawn shut, because that is how it opens on the phone. */}
                <p className="text-[10px] tracking-wide text-muted uppercase">▸ Advanced</p>
                <div className="grid grid-cols-2 gap-1.5 opacity-50">
                  {advanced.map((field) => (
                    <PreviewCell key={field.id} field={field} />
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * One field, at the size and shape it will really be.
 *
 * Shows its label and a hint of what kind of control it is. Not the control
 * itself: a real text area here would be a place to type that throws the typing
 * away.
 */
function PreviewCell({ field, tall = false }: { field: ParamField; tall?: boolean }) {
  const half = field.width !== 'full' && !tall;
  return (
    <div
      className={cn(
        'rounded-lg border border-line bg-surface-2 px-2 py-1.5',
        !half && 'col-span-2',
        tall && (field.control === 'textarea' ? 'h-16' : 'h-12'),
      )}
    >
      <p className="truncate text-[10px] text-muted uppercase">{field.label}</p>
      {tall ? null : <p className="truncate text-[11px]">{describeControl(field)}</p>}
    </div>
  );
}

function describeControl(field: ParamField): string {
  if (usesPointLine(field)) return '• • • • •';
  switch (field.control) {
    case 'boolean':
      return 'on / off';
    case 'combo':
      return field.options?.[0] ?? 'choice';
    case 'int':
    case 'float':
      return String(field.defaultValue ?? 0);
    default:
      return String(field.defaultValue ?? '');
  }
}
