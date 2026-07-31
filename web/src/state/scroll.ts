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
