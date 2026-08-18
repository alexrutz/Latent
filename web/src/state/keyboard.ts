import { useEffect, useState } from 'react';

/**
 * Whether the on-screen keyboard is up.
 *
 * There is no event for this. What there is is `visualViewport`: the part of
 * the page you can actually see, which the keyboard shrinks. Comparing it to
 * the layout viewport is the only reliable signal on both iOS and Android, and
 * it is the one every app that cares about this uses.
 *
 * The threshold exists because the visual viewport also shrinks a little for
 * things that are not the keyboard — a collapsing browser toolbar, most often.
 * A quarter of the screen is far more than any of those and far less than any
 * keyboard.
 */
const KEYBOARD_FRACTION = 0.25;

export function useKeyboardOpen(): boolean {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;

    const measure = () => {
      const hidden = window.innerHeight - viewport.height - viewport.offsetTop;
      setOpen(hidden > window.innerHeight * KEYBOARD_FRACTION);
    };

    measure();
    viewport.addEventListener('resize', measure);
    // The keyboard on iOS scrolls the visual viewport rather than resizing it
    // in some configurations, so both events matter.
    viewport.addEventListener('scroll', measure);
    return () => {
      viewport.removeEventListener('resize', measure);
      viewport.removeEventListener('scroll', measure);
    };
  }, []);

  return open;
}
