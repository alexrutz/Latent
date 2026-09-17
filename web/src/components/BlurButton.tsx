import { useBlur } from '../state/blur';
import { cn, CONTROL_FACE, CONTROL_FACE_ON } from './ui';

/**
 * The privacy blur, in the same corner on every screen that has a top row.
 *
 * Shared rather than written twice: it is the one control here that gets
 * reached for without looking — somebody has just sat down beside you — and a
 * button that is third from the right on one screen and last on another is a
 * button you have to find first. Last, always, is the rule.
 */
export function BlurButton() {
  const blurred = useBlur((state) => state.blurred);
  const toggle = useBlur((state) => state.toggle);

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label="Blur every image"
      aria-pressed={blurred}
      className={cn(
        'grid size-9 shrink-0 place-items-center rounded-full text-base',
        blurred ? CONTROL_FACE_ON : CONTROL_FACE,
      )}
    >
      ◍
    </button>
  );
}
