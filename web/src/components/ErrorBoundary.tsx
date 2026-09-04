import { Component, type ErrorInfo, type ReactNode } from 'react';

import { Button } from './ui';

/**
 * What is on screen when a screen throws.
 *
 * React unmounts the whole tree when a render throws and nothing catches it,
 * which on a dark theme is a black rectangle with no text, no navigation and no
 * way back — the app has not crashed in any way the person can act on, it has
 * simply vanished. That happened here for real: a model note stored before a
 * field existed made the Models screen read `undefined.length`, and the entire
 * app went black on a tap.
 *
 * The underlying bug is worth fixing wherever it is, and every one of them will
 * be. This is the promise that the *next* one costs a screen rather than the
 * app: the tab bar is outside this boundary and keeps working, so the way out
 * is to tap somewhere else.
 */
interface Props {
  children: ReactNode;
  /** Reset when this changes — the route, so navigating away clears the wreck. */
  resetKey?: string;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidUpdate(previous: Props): void {
    // Leaving the broken screen is the commonest fix, and it has to actually
    // work: without this the boundary stays latched and every other screen
    // renders as the error too.
    if (previous.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // The stack is the only record of what happened — there is no server to
    // send it to, and a person who reports this deserves to be able to paste
    // something more useful than "it went black".
    console.error('A screen failed to render', error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="readable safe-t space-y-3 px-4 pt-6">
        <h1 className="text-lg font-semibold">This screen stopped</h1>
        <p className="text-sm text-muted">
          Something in it failed to draw. The rest of the app still works — the tabs below will take
          you elsewhere.
        </p>
        <p className="rounded-xl border border-line bg-surface px-3 py-2 font-mono text-xs break-words text-warn">
          {error.message}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => this.setState({ error: null })}>
            Try again
          </Button>
          <Button variant="ghost" onClick={() => window.location.reload()}>
            Reload the app
          </Button>
        </div>
      </div>
    );
  }
}
