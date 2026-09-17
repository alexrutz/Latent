import { useEffect } from 'react';

let container: HTMLElement | null = null;

/**
 * The app's one scrolling element, registered by the shell.
 *
 * Screens do not own their scrollbar — `<main>` does — so "take me back to the
 * top", which every phone app does when you tap the tab you are already on, has
 * to reach past whichever screen happens to be mounted.
 */
export function registerScrollContainer(element: HTMLElement | null): void {
  container = element;
}

export function scrollToTop(smooth = true): void {
  container?.scrollTo({ top: 0, behavior: smooth ? 'smooth' : 'auto' });
}

/**
 * Put the page back on the top edge after the on-screen keyboard has gone.
 *
 * The shell is one viewport tall and hides its own overflow, so the document
 * has nowhere to scroll to and never should: `<main>` is the scroller, and the
 * tab bar is in the flow below it, on the bottom edge because that is where the
 * viewport ends.
 *
 * A phone keyboard breaks that. Focus an input near the bottom of a form and
 * the browser scrolls the *document* to reveal it — not the element we handed
 * it, the document itself, `overflow: hidden` notwithstanding, because a
 * keyboard shrinks the visual viewport rather than the layout one. Dismiss the
 * keyboard, by saving the form or otherwise, and the browser has no obligation
 * to undo that. It usually doesn't. What is left is a page shifted up by the
 * height of a keyboard that is no longer there, with the tab bar somewhere in
 * the middle of the screen and no way to scroll it back — the document has
 * hidden overflow, so a finger on it does nothing.
 *
 * Hence the invariant, enforced here rather than remembered in every form: the
 * document's scroll offset is always zero. Any other value is keyboard
 * leftovers, and gets put back — but only once the keyboard has actually gone,
 * since zeroing it while the keyboard is up would fight the browser for the
 * input the person is typing into and win, hiding it behind the keys.
 */
export function useDocumentScrollAnchor(): void {
  useEffect(() => {
    const settle = () => {
      // The scroll is the browser's to own while it is holding an input above a
      // keyboard. `visualViewport` is how we tell: it is shorter than the
      // window exactly while something is covering part of the page.
      const viewport = window.visualViewport;
      if (viewport && viewport.height < window.innerHeight - 1) return;
      if (window.scrollY !== 0 || window.scrollX !== 0) window.scrollTo(0, 0);
    };

    /*
     * Two events, because neither alone covers it. `focusout` fires when the
     * input is released — the common case, a Save button taking the focus — but
     * on a browser that animates the keyboard away the page is still shifted at
     * that moment, so the viewport resize that follows is what actually finds
     * it. On a desktop browser there is no keyboard, no resize, and nothing to
     * correct; the handlers cost a comparison and do nothing.
     */
    const viewport = window.visualViewport;
    window.addEventListener('focusout', settle);
    viewport?.addEventListener('resize', settle);
    return () => {
      window.removeEventListener('focusout', settle);
      viewport?.removeEventListener('resize', settle);
    };
  }, []);
}
