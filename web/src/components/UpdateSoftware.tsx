import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';

import type { UpdateLogLine, UpdateStatus, UpdateStep } from '@latent/shared';

import { api, setUpdateTicket } from '../api/client';
import { Button, Card, ErrorNote, Sheet, Spinner, cn } from './ui';

/**
 * Installing a new version of Latent from inside Latent.
 *
 * Two things about this screen are unlike every other one in the app.
 *
 * It **polls** instead of subscribing. `npm run build` deletes `web/dist` and
 * writes it again, so for a minute in the middle of an update this page cannot
 * fetch anything from the bundle it was served from and must not reload. A
 * cursor over the server's log is the only thing that survives that — and it
 * also survives a phone locking its screen for the whole install and coming
 * back to be told exactly what it missed.
 *
 * And it **asks for the password again**, like the notes do. The session is
 * enough to look; replacing the running code is not something a tap on a phone
 * left on a table should be able to do.
 */

/** How often the log is asked for while something is running. */
const POLL_MS = 1000;
/** And when nothing is, so a run somebody else started still shows up. */
const IDLE_POLL_MS = 15_000;

function shortDate(at: number | null): string {
  if (!at) return '';
  return new Date(at).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const STEP_LABELS: Record<UpdateStep['name'], string> = {
  fetch: 'Fetching',
  reset: 'Moving to the new commit',
  install: 'Installing dependencies',
  build: 'Building',
  rollback: 'Putting it back',
};

/**
 * The state of one update, kept outside react-query on purpose.
 *
 * The log arrives in pieces keyed by a cursor, so each poll has to be *appended*
 * to what came before. A cache that replaces its value on every fetch is the
 * wrong shape for that, and working around it would mean keeping the real log
 * somewhere else anyway.
 */
function useUpdateStatus(active: boolean) {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [lines, setLines] = useState<UpdateLogLine[]>([]);
  const cursor = useRef(0);

  const absorb = useCallback((next: UpdateStatus) => {
    setStatus(next);
    if (next.cursor < cursor.current) {
      // The server started a new run and reset its numbering. Ours would
      // otherwise silently swallow every line of it.
      setLines(next.log);
    } else if (next.log.length > 0) {
      setLines((previous) => [...previous, ...next.log]);
    }
    cursor.current = next.cursor;
  }, []);

  const refresh = useCallback(async () => {
    try {
      absorb(await api.updateStatus(cursor.current));
    } catch {
      /*
       * A failed poll is not worth reporting.
       *
       * The one moment this reliably fails is the middle of an update, when the
       * server is restarting or the network dropped a request — and an error
       * banner appearing there would say "the update broke" about the one
       * minute where nothing being visible is normal. The next poll a second
       * later says what is actually true.
       */
    }
  }, [absorb]);

  const running = status?.run?.phase === 'running';

  useEffect(() => {
    if (!active) return;
    void refresh();
    const timer = setInterval(() => void refresh(), running ? POLL_MS : IDLE_POLL_MS);
    return () => clearInterval(timer);
  }, [active, running, refresh]);

  return { status, lines, refresh, absorb, running };
}

/* ------------------------------------------------------------------ */
/* The section in Settings                                             */
/* ------------------------------------------------------------------ */

export function UpdateSection() {
  const [open, setOpen] = useState(false);
  const { status, running, refresh, absorb } = useUpdateStatus(!open);
  const [checking, setChecking] = useState(false);

  const checkout = status?.checkout;
  const available = status?.available;
  const behind = available?.behind ?? 0;

  return (
    <section className="space-y-2">
      <h2 className="text-xs font-medium tracking-wide text-muted uppercase">Software</h2>
      <Card className="space-y-3">
        {checkout?.commit ? (
          <div className="space-y-1">
            <p className="text-sm">
              <span className="font-mono">{checkout.commitShort}</span>
              {checkout.branch && <span className="text-muted"> on {checkout.branch}</span>}
            </p>
            {checkout.subject && <p className="text-xs text-muted">{checkout.subject}</p>}
            {checkout.committedAt && (
              <p className="text-xs text-muted">Committed {shortDate(checkout.committedAt)}</p>
            )}
          </div>
        ) : (
          <p className="text-sm text-muted">Reading the installation…</p>
        )}

        {/*
          The reason it cannot be updated is shown rather than the section being
          hidden: "this is a Docker image, update it with docker compose pull"
          is the useful answer to "how do I update", and hiding the section
          leaves somebody looking for a button that was never going to be there.
        */}
        {checkout && !checkout.updatable && checkout.reason && (
          <p className="text-xs text-warn">{checkout.reason}</p>
        )}

        {checkout?.updatable && (
          <>
            {behind > 0 ? (
              <p className="text-sm text-accent">
                {behind === 1 ? '1 commit' : `${behind} commits`} waiting
                {available?.subject ? `: ${available.subject}` : '.'}
              </p>
            ) : available?.checkedAt ? (
              <p className="text-xs text-muted">
                Up to date as of {shortDate(available.checkedAt)}.
              </p>
            ) : (
              <p className="text-xs text-muted">Not checked since this server started.</p>
            )}

            {available && available.ahead > 0 && (
              <p className="text-xs text-warn">
                This checkout has{' '}
                {available.ahead === 1 ? '1 commit' : `${available.ahead} commits`} the remote does
                not. Installing an update would make {available.ahead === 1 ? 'it' : 'them'}{' '}
                unreachable.
              </p>
            )}

            {checkout.dirty && (
              <p className="text-xs text-warn">
                There are uncommitted changes in the project directory. An update would discard
                them, so it will be refused until they are committed or stashed.
              </p>
            )}

            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                size="sm"
                busy={checking}
                onClick={async () => {
                  setChecking(true);
                  try {
                    absorb(await api.checkForUpdate());
                  } finally {
                    setChecking(false);
                  }
                }}
              >
                Check for updates
              </Button>
              <Button
                variant={behind > 0 ? 'primary' : 'secondary'}
                size="sm"
                onClick={() => setOpen(true)}
              >
                {running ? 'Installing…' : behind > 0 ? 'Install update' : 'Install anyway'}
              </Button>
            </div>
          </>
        )}
      </Card>

      <UpdateSheet
        open={open}
        onClose={() => {
          setOpen(false);
          void refresh();
        }}
      />
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* The sheet that does it                                              */
/* ------------------------------------------------------------------ */

function UpdateSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [unlocked, setUnlocked] = useState(false);
  const { status, lines, running, refresh, absorb } = useUpdateStatus(open);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const close = useCallback(() => {
    // The pass goes back with the screen. An update already running does not
    // stop — it is on the server — and reopening this buys a new pass.
    void api.lockUpdate().catch(() => {});
    setUpdateTicket(null);
    setUnlocked(false);
    setError(null);
    onClose();
  }, [onClose]);

  const run = status?.run;
  const done = run?.phase === 'succeeded';
  const failed = run?.phase === 'failed';

  return (
    <Sheet open={open} onClose={close} title="Update Latent" closeLabel="Close" full>
      <div className="space-y-4">
        {/*
          Progress first, whether or not this screen is the one that started it.
          A run belongs to the server, so opening this during one — or reopening
          it after the phone locked — has to show what is happening rather than
          a password box in front of it.
        */}
        {run && <UpdateProgress status={status} lines={lines} />}

        {/*
          And the door stays until it is answered. Watching is not the guarded
          part; installing and restarting are, and both of those live below it.
        */}
        {!unlocked ? (
          <UpdatePasswordForm
            onUnlocked={(next) => {
              absorb(next);
              setUnlocked(true);
            }}
            watching={running}
          />
        ) : (
          <>
            {status?.checkout.updatable && !run && (
              <>
                <p className="text-sm text-muted">
                  This fetches from {status.checkout.upstream}, moves the checkout to it, installs
                  dependencies and builds. Your gallery, ratings, archive and settings are stored
                  outside the project directory and are not touched.
                </p>
                <p className="text-xs text-warn">
                  Leave this screen open while it runs. The build replaces the app's own files
                  part-way through, so reloading the page mid-update will show an error until it
                  finishes.
                </p>
                <Button
                  variant="primary"
                  size="lg"
                  busy={busy}
                  onClick={async () => {
                    setBusy(true);
                    setError(null);
                    try {
                      absorb((await api.runUpdate()).status);
                    } catch (cause) {
                      setError(
                        cause instanceof Error ? cause.message : 'Could not start the update',
                      );
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Install now
                </Button>
              </>
            )}

            <ErrorNote>{error ?? (failed ? run?.error : null)}</ErrorNote>

            {done && run?.restartRequired && status && (
              <RestartCard
                note={status.supervisor.note}
                restarts={status.supervisor.restarts}
                onError={setError}
              />
            )}

            {done && !run?.restartRequired && (
              <p className="text-sm text-muted">
                Nothing changed — this was already the newest commit.
              </p>
            )}

            {failed && (
              <Button variant="secondary" onClick={() => void refresh()}>
                Refresh
              </Button>
            )}
          </>
        )}
      </div>
    </Sheet>
  );
}

function UpdatePasswordForm({
  onUnlocked,
  watching = false,
}: {
  onUnlocked: (status: UpdateStatus) => void;
  /** An update is already in flight and this screen is only looking on. */
  watching?: boolean;
}) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { ticket, status } = await api.unlockUpdate(password);
      setUpdateTicket(ticket);
      setPassword('');
      onUnlocked(status);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That did not work');
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <p className="text-sm text-muted">
        {watching
          ? 'This update was started elsewhere and is running on the server. Enter the password ' +
            'to be able to restart into it when it finishes.'
          : 'Installing an update replaces the code this server is running. Being signed in is ' +
            'not enough for that — it is the same password you signed in with.'}
      </p>
      <input
        type="password"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        placeholder="Password"
        autoComplete="current-password"
        aria-label="Password"
        autoFocus
        className="w-full rounded-2xl border border-line bg-surface px-4 py-3.5 text-center focus:border-accent focus:outline-none"
      />
      <ErrorNote>{error}</ErrorNote>
      <Button type="submit" variant="primary" size="lg" busy={busy} disabled={!password}>
        Continue
      </Button>
    </form>
  );
}

function RestartCard({
  note,
  restarts,
  onError,
}: {
  note: string;
  restarts: boolean;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  if (sent) {
    return (
      <Card className="space-y-2">
        <p className="text-sm">Restarting. This page will work again once it is back.</p>
        <p className="text-xs text-muted">
          Nothing here can tell you when that is — the server it would ask is the one restarting.
          Reload in a few seconds.
        </p>
      </Card>
    );
  }

  return (
    <Card className="space-y-3">
      <p className="text-sm">Installed. Latent has to be restarted to run the new version.</p>
      <p className={cn('text-xs', restarts ? 'text-muted' : 'text-warn')}>{note}</p>
      <Button
        variant={restarts ? 'primary' : 'secondary'}
        busy={busy}
        onClick={async () => {
          setBusy(true);
          try {
            // `!restarts` is the case where the server itself would refuse:
            // saying so once in the note above and then sending the override is
            // more honest than a second dialog asking the same question again.
            await api.restartForUpdate(!restarts);
            setSent(true);
          } catch (cause) {
            onError(cause instanceof Error ? cause.message : 'Could not restart');
          } finally {
            setBusy(false);
          }
        }}
      >
        {restarts ? 'Restart now' : 'Stop Latent anyway'}
      </Button>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Progress                                                            */
/* ------------------------------------------------------------------ */

function UpdateProgress({
  status,
  lines,
}: {
  status: UpdateStatus | null;
  lines: UpdateLogLine[];
}) {
  const run = status?.run;
  const bottom = useRef<HTMLDivElement>(null);
  const [showLog, setShowLog] = useState(false);

  useEffect(() => {
    if (showLog) bottom.current?.scrollIntoView({ block: 'end' });
  }, [lines.length, showLog]);

  if (!run) return null;

  return (
    <div className="space-y-3">
      <ol className="space-y-1">
        {run.steps.map((step) => (
          <li key={step.name} className="flex items-center gap-2 text-sm">
            <StepMark status={step.status} />
            <span className={cn(step.status === 'skipped' && 'text-muted')}>
              {STEP_LABELS[step.name]}
            </span>
            {step.status === 'failed' && step.exitCode !== null && (
              <span className="text-xs text-warn">exit {step.exitCode}</span>
            )}
          </li>
        ))}
      </ol>

      {/*
        The failed command, spelled out.
        The moment somebody reads this is the moment they are deciding whether
        to SSH in and finish it by hand, and the thing they need then is the
        command, not a description of it.
      */}
      {run.steps
        .filter((step) => step.status === 'failed')
        .map((step) => (
          <p key={step.name} className="overflow-x-auto font-mono text-xs text-muted">
            {step.command}
          </p>
        ))}

      <button
        type="button"
        onClick={() => setShowLog((value) => !value)}
        className="text-xs text-muted underline"
      >
        {showLog ? 'Hide output' : `Show output (${lines.length} lines)`}
      </button>

      {showLog && (
        <div className="max-h-72 overflow-auto rounded-xl border border-line bg-surface-2 p-2">
          {lines.map((line) => (
            <p
              key={line.seq}
              className={cn(
                'font-mono text-[11px] leading-snug break-all whitespace-pre-wrap',
                line.stream === 'err' && 'text-warn',
                line.stream === 'note' && 'text-accent',
              )}
            >
              {line.text}
            </p>
          ))}
          <div ref={bottom} />
        </div>
      )}
    </div>
  );
}

function StepMark({ status }: { status: UpdateStep['status'] }) {
  if (status === 'running') return <Spinner className="size-4 text-accent" />;
  const mark =
    status === 'done' ? '✓' : status === 'failed' ? '✕' : status === 'skipped' ? '–' : '○';
  return (
    <span
      aria-hidden
      className={cn(
        'inline-block w-4 text-center text-xs',
        status === 'done' && 'text-accent',
        status === 'failed' && 'text-warn',
        status !== 'done' && status !== 'failed' && 'text-muted',
      )}
    >
      {mark}
    </span>
  );
}
