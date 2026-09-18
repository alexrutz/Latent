import { useEffect, useMemo, useRef, useState } from 'react';

import {
  portOf,
  type ServiceArg,
  type ServiceConfig,
  type ServiceDefinition,
  type ServiceLogLine,
  type ServiceState,
  type ServiceView,
} from '@latent/shared';

import { api } from '../api/client';
import {
  useAddService,
  useDeleteService,
  useServiceAction,
  useServiceDefinitions,
  useServices,
  useUpdateService,
} from '../api/queries';
import { Toggle } from '../components/ParamControl';
import { Button, Card, cn, EmptyState, ErrorNote, Sheet, Spinner } from '../components/ui';

/**
 * Latent as the process that keeps the others running.
 *
 * ComfyUI and llama-server are both perfectly capable programs that happen to
 * fall over — a model one gigabyte too large, a custom node that throws on
 * import, a driver that went away mid-render. Latent does not: it reads a
 * database and proxies HTTP, and it stays up for weeks. That asymmetry is the
 * whole argument for this screen. The stable thing gets the button that starts
 * the unstable ones, and the switch that starts them again by itself.
 *
 * Three ideas, and the screen is arranged around them in that order:
 *
 * 1. **What is running**, at a glance, without reading anything. A row per
 *    service, a dot, and the two buttons.
 * 2. **Why it is not**, when it is not. The log is one tap away and the
 *    command that was actually run is the first line of it, because nine times
 *    out of ten the answer is in one of those two places.
 * 3. **What it will be run with.** A form built from the service's own
 *    arguments, with the resulting command line shown underneath it — a
 *    manager that hides the command it produces is a manager you cannot debug.
 */
export function SupervisorScreen() {
  const definitions = useServiceDefinitions();
  const services = useServices();
  const add = useAddService();

  const [adding, setAdding] = useState(false);
  const [configuring, setConfiguring] = useState<string | null>(null);
  const [watching, setWatching] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const known = definitions.data?.definitions ?? [];
  const rows = services.data?.services ?? [];

  const definitionOf = (kind: string): ServiceDefinition | undefined =>
    known.find((entry) => entry.kind === kind);

  const open = configuring ? rows.find((row) => row.config.id === configuring) : undefined;
  const logging = watching ? rows.find((row) => row.config.id === watching) : undefined;

  if (definitions.isLoading || services.isLoading) {
    return (
      <div className="grid h-full place-items-center">
        <Spinner className="size-6 text-muted" />
      </div>
    );
  }

  return (
    <div className="safe-t space-y-3 px-4 pt-3 pb-6">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Supervisor</h1>
        <Button size="sm" onClick={() => setAdding(true)}>
          Add a service
        </Button>
      </div>

      <p className="text-xs text-muted">
        The other processes on this machine, started and watched from here. Latent rarely falls
        over; these do — so the one that stays up is where the button to bring them back belongs.
      </p>

      <ErrorNote>{error}</ErrorNote>

      {rows.length === 0 ? (
        <EmptyState
          icon="⎔"
          title="Nothing under Latent yet"
          hint="Add ComfyUI or llama-server, point it at the folder its binaries are in, and Latent can start it, watch it and bring it back when it crashes."
          action={
            <Button size="sm" onClick={() => setAdding(true)}>
              Add a service
            </Button>
          }
        />
      ) : (
        <ul className="space-y-2">
          {rows.map((row) => (
            <li key={row.config.id}>
              <ServiceCard
                view={row}
                definition={definitionOf(row.config.kind)}
                onConfigure={() => setConfiguring(row.config.id)}
                onWatch={() => setWatching(row.config.id)}
                onError={setError}
              />
            </li>
          ))}
        </ul>
      )}

      {/* Adding one is choosing which of the known kinds it is, and nothing else.
          The root and the arguments are the next screen's business — a dialog
          that asked for everything at once would be the settings form twice. */}
      <Sheet open={adding} onClose={() => setAdding(false)} title="Add a service">
        <div className="space-y-2">
          {known.map((definition) => (
            <button
              key={definition.kind}
              type="button"
              onClick={async () => {
                setError(null);
                try {
                  const created = await add.mutateAsync({ kind: definition.kind });
                  setAdding(false);
                  // Straight into its settings: a service with no root cannot
                  // start, so the next thing to do is always the same thing.
                  setConfiguring(created.config.id);
                } catch (cause) {
                  setError(cause instanceof Error ? cause.message : 'Could not add that');
                }
              }}
              className="flex w-full flex-col items-start gap-0.5 rounded-xl bg-surface-2 px-3 py-2.5 text-left active:bg-surface-3"
            >
              <span className="text-sm">{definition.label}</span>
              <span className="text-[11px] text-muted">{definition.blurb}</span>
            </button>
          ))}
        </div>
      </Sheet>

      {open && (
        <ServiceSettings
          view={open}
          definition={definitionOf(open.config.kind)}
          onClose={() => setConfiguring(null)}
        />
      )}

      {logging && (
        <ServiceLog
          view={logging}
          onClose={() => setWatching(null)}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* One service                                                         */
/* ------------------------------------------------------------------ */

/** What each state looks like and is called, in one place so the two agree. */
const STATES: Record<ServiceState, { label: string; dot: string; text: string }> = {
  running: { label: 'Running', dot: 'bg-success', text: 'text-success' },
  starting: { label: 'Starting', dot: 'bg-warn animate-pulse', text: 'text-warn' },
  stopping: { label: 'Stopping', dot: 'bg-warn animate-pulse', text: 'text-warn' },
  stopped: { label: 'Stopped', dot: 'bg-muted/50', text: 'text-muted' },
  exited: { label: 'Exited', dot: 'bg-warn', text: 'text-warn' },
  failed: { label: 'Failed', dot: 'bg-danger', text: 'text-danger' },
};

function ServiceCard({
  view,
  definition,
  onConfigure,
  onWatch,
  onError,
}: {
  view: ServiceView;
  definition: ServiceDefinition | undefined;
  onConfigure: () => void;
  onWatch: () => void;
  onError: (message: string | null) => void;
}) {
  const action = useServiceAction();
  const { config, status } = view;
  const look = STATES[status.state];
  const up = status.state === 'running' || status.state === 'starting';

  const run = async (which: 'start' | 'stop' | 'restart') => {
    onError(null);
    try {
      await action.mutateAsync({ id: config.id, action: which });
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : `Could not ${which} it`);
    }
  };

  return (
    <Card className="space-y-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span aria-hidden className={cn('size-2 shrink-0 rounded-full', look.dot)} />
            <span className="min-w-0 truncate text-sm font-medium">{config.name}</span>
          </div>
          <p className={cn('mt-0.5 text-[11px]', look.text)}>
            {look.label}
            {status.pid !== null && ` · pid ${status.pid}`}
            {status.startedAt !== null && up && ` · up ${since(status.startedAt)}`}
            {definition && ` · port ${portOf(definition, config)}`}
          </p>
        </div>

        <div className="flex shrink-0 gap-1.5">
          {up ? (
            <>
              <Button size="sm" variant="ghost" onClick={() => void run('restart')}>
                Restart
              </Button>
              <Button size="sm" variant="secondary" onClick={() => void run('stop')}>
                Stop
              </Button>
            </>
          ) : (
            <Button size="sm" onClick={() => void run('start')}>
              Start
            </Button>
          )}
        </div>
      </div>

      {/*
        Everything that went wrong, said where it happened.

        Not in a toast and not only in the log: the two failures people hit are
        "the root is wrong" and "it crashed", and both are properties of this
        service that should still be readable ten minutes later.
      */}
      {status.error && (
        <p className="rounded-lg bg-danger/10 px-2.5 py-1.5 text-[11px] text-danger">
          {status.error}
        </p>
      )}

      {status.restartAt !== null && (
        <p className="text-[11px] text-warn">
          Restarting automatically in {Math.max(0, Math.round((status.restartAt - Date.now()) / 1000))}s
          {status.restarts > 0 && ` · ${status.restarts} so far`}
        </p>
      )}

      {!up && status.exitCode !== null && !status.error && (
        <p className="text-[11px] text-muted">
          Last exit: code {status.exitCode}
          {status.exitSignal && ` (${status.exitSignal})`}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        <Button size="sm" variant="ghost" onClick={onWatch}>
          Log
        </Button>
        <Button size="sm" variant="ghost" onClick={onConfigure}>
          Settings
        </Button>
        {config.autoRestart && (
          <span className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[10px] text-muted">
            restarts itself
          </span>
        )}
        {config.autoStart && (
          <span className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[10px] text-muted">
            starts with Latent
          </span>
        )}
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

/**
 * One service's root, arguments and behaviour.
 *
 * Built entirely from the definition: the groups, the controls, the help and
 * the defaults all come from the catalogue the server sent, so a service added
 * to it appears here in full with nothing written for it. That is what makes
 * this modular in the way that matters — the next utility process is a
 * definition, not a screen.
 */
function ServiceSettings({
  view,
  definition,
  onClose,
}: {
  view: ServiceView;
  definition: ServiceDefinition | undefined;
  onClose: () => void;
}) {
  const update = useUpdateService();
  const remove = useDeleteService();
  const { config, status } = view;

  const [showAll, setShowAll] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const patch = (change: Partial<ServiceConfig>) => {
    setError(null);
    update.mutate(
      { id: config.id, patch: change },
      {
        onError: (cause) =>
          setError(cause instanceof Error ? cause.message : 'Could not save that'),
      },
    );
  };

  const setValue = (flag: string, value: ServiceConfig['values'][string] | undefined) => {
    const values = { ...config.values };
    if (value === undefined || value === '' || value === false) delete values[flag];
    else values[flag] = value;
    patch({ values });
  };

  /** The arguments, grouped the way the definition groups them. */
  const groups = useMemo(() => {
    if (!definition) return [];
    const out: { name: string; args: ServiceArg[] }[] = [];
    for (const arg of definition.args) {
      if (!showAll && !arg.common && config.values[arg.flag] === undefined) continue;
      const last = out[out.length - 1];
      if (last?.name === arg.group) last.args.push(arg);
      else out.push({ name: arg.group, args: [arg] });
    }
    return out;
  }, [definition, showAll, config.values]);

  const set = Object.keys(config.values).length;

  return (
    <Sheet open onClose={onClose} title={config.name} full>
      <div className="space-y-4">
        <ErrorNote>{error}</ErrorNote>

        <section className="space-y-2">
          <Field label="Name" hint="What you call it. Two ComfyUIs on two cards want telling apart.">
            <TextInput value={config.name} onCommit={(name) => patch({ name })} />
          </Field>

          <Field label="Root directory" hint={definition?.rootHint ?? ''}>
            <TextInput
              value={config.root}
              placeholder="/opt/ComfyUI_windows_portable"
              onCommit={(root) => patch({ root })}
            />
          </Field>

          {definition && definition.launchers.length > 1 && (
            <Field
              label="How to start it"
              hint="Automatic takes the first one whose file is actually in the folder above, which is right unless you have two."
            >
              <select
                value={config.launcher ?? ''}
                onChange={(event) => patch({ launcher: event.target.value || null })}
                className="w-full rounded-xl border border-line bg-surface px-3 py-2 text-sm"
              >
                <option value="">Automatic</option>
                {definition.launchers.map((launcher) => (
                  <option key={launcher.id} value={launcher.id}>
                    {launcher.label} — {launcher.file}
                  </option>
                ))}
              </select>
            </Field>
          )}
        </section>

        {/*
          What will actually be run.

          The whole reason to build a command out of a form rather than typing
          one is that the form cannot get the spelling wrong. The reason to
          *show* the result is that the form can still be wrong about what you
          meant, and this is the only place that difference is visible.
        */}
        <section className="space-y-1.5">
          <p className="text-xs tracking-wide text-muted uppercase">The command</p>
          <pre
            data-testid="service-command"
            className="overflow-x-auto rounded-xl border border-line bg-ink px-3 py-2.5 text-[11px] leading-relaxed whitespace-pre-wrap break-all text-body/90"
          >
            {status.command || 'Set a root directory, and the command appears here.'}
          </pre>
          {status.command ? (
            <p className="text-[11px] text-muted">Run inside {config.root}.</p>
          ) : (
            /*
              Why there is nothing to show, where the nothing is.

              A root that is set but holds none of the expected binaries left
              this box saying "set a root directory" — which is advice for a
              problem you have already dealt with, and no help at all with the
              one you actually have. The card behind says it too; this says it
              at the moment you are typing the path it is about.
            */
            config.root.trim() !== '' &&
            status.error && <p className="text-[11px] text-warn">{status.error}</p>
          )}
        </section>

        <section className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs tracking-wide text-muted uppercase">Arguments</p>
            <button
              type="button"
              onClick={() => setShowAll((current) => !current)}
              className="text-[11px] text-accent"
            >
              {showAll ? 'Only the common ones' : `Show all${set > 0 ? '' : ''}`}
            </button>
          </div>
          {!showAll && (
            <p className="text-[11px] text-muted">
              The handful anybody sets, plus whatever you have already set. Everything else is
              behind “show all”.
            </p>
          )}

          {groups.map((group) => (
            <div key={group.name} className="space-y-2">
              <p className="pt-1 text-[11px] font-medium text-muted">{group.name}</p>
              {group.args.map((arg) => (
                <ArgControl
                  key={arg.flag}
                  arg={arg}
                  value={config.values[arg.flag]}
                  onChange={(value) => setValue(arg.flag, value)}
                />
              ))}
            </div>
          ))}
        </section>

        <section className="space-y-1.5">
          <p className="text-xs tracking-wide text-muted uppercase">Anything else</p>
          <TextInput
            value={config.extraArgs}
            label="Anything else"
            placeholder="--some-new-flag value"
            onCommit={(extraArgs) => patch({ extraArgs })}
          />
          <p className="text-[11px] text-muted">
            Added to the end of the command exactly as typed. Quotes group, so a path with a space
            in it works. This is where a flag added to ComfyUI last week goes.
          </p>
        </section>

        <section className="space-y-2">
          <p className="text-xs tracking-wide text-muted uppercase">Behaviour</p>
          <Card className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm">Restart it when it crashes</p>
                <p className="text-xs text-muted">
                  With a growing pause between attempts, and it gives up after five launches that
                  never stayed up — a command line that does not work would otherwise be retried
                  forever.
                </p>
              </div>
              <Toggle
                checked={config.autoRestart}
                onChange={(autoRestart) => patch({ autoRestart })}
                label="Restart it when it crashes"
              />
            </div>
            <div className="flex items-center justify-between gap-3 border-t border-line pt-3">
              <div className="min-w-0">
                <p className="text-sm">Start it with Latent</p>
                <p className="text-xs text-muted">
                  Off by default: a supervisor that launched processes because it happened to be
                  installed would be a surprise. Turn it on once you trust the command above.
                </p>
              </div>
              <Toggle
                checked={config.autoStart}
                onChange={(autoStart) => patch({ autoStart })}
                label="Start it with Latent"
              />
            </div>
          </Card>
        </section>

        <section className="space-y-1.5 border-t border-line pt-3">
          <Button
            variant="ghost"
            size="sm"
            className="text-danger"
            busy={remove.isPending}
            onClick={() => {
              if (!confirmDelete) {
                setConfirmDelete(true);
                return;
              }
              remove.mutate(config.id, { onSuccess: onClose });
            }}
          >
            {confirmDelete ? 'Really remove it?' : 'Remove this service'}
          </Button>
          <p className="text-[11px] text-muted">
            It is stopped first. Nothing it produced is touched — this only forgets how to start
            it.
          </p>
        </section>
      </div>
    </Sheet>
  );
}

/**
 * A labelled control, with the label actually attached to it.
 *
 * A `<label>` wrapping both, rather than a `<span>` above a box: the two look
 * identical and only one of them means anything to a screen reader, or to a tap
 * on the words rather than on the field. There is one input per field here, so
 * the implicit association is unambiguous.
 */
function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1">
      <span className="text-sm">{label}</span>
      {children}
      {hint && <span className="block text-[11px] text-muted">{hint}</span>}
    </label>
  );
}

/**
 * A text field that saves when you have finished with it, not per keystroke.
 *
 * Every save is a request and a refetch of the list, and a path typed into a
 * field that wrote on every character would be forty of each — with the value
 * being replaced under the cursor by whichever answer arrived last.
 */
function TextInput({
  value,
  placeholder,
  label,
  onCommit,
}: {
  value: string;
  placeholder?: string;
  /**
   * An accessible name, where the surrounding markup does not supply one.
   *
   * The two fields at the top sit inside a `<label>` and need nothing; an
   * argument's box is one of thirty in a list and has to say which.
   */
  label?: string;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  // Follow the stored value when it changes from elsewhere, but never while
  // this is the field being typed into.
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(value);
  }, [value]);

  return (
    <input
      type="text"
      value={draft}
      placeholder={placeholder}
      aria-label={label}
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
      onFocus={() => {
        focused.current = true;
      }}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        focused.current = false;
        if (draft !== value) onCommit(draft);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
      }}
      className="w-full rounded-xl border border-line bg-surface px-3 py-2 text-sm focus:border-accent focus:outline-none"
    />
  );
}

/**
 * One argument, drawn as whatever its type deserves.
 *
 * The fallback is shown beside the control rather than filled into it, which is
 * the whole reason the command line stays readable: nothing is passed unless it
 * is set, so a command that says `--lowvram --port 8189` says exactly the two
 * things that were decided, not those two buried in thirty defaults.
 */
function ArgControl({
  arg,
  value,
  onChange,
}: {
  arg: ServiceArg;
  value: ServiceConfig['values'][string] | undefined;
  onChange: (value: ServiceConfig['values'][string] | undefined) => void;
}) {
  const set = value !== undefined;

  if (arg.type === 'flag') {
    return (
      <div className="flex items-center justify-between gap-3 rounded-xl border border-line bg-surface px-3 py-2">
        <div className="min-w-0">
          <p className="text-sm">{arg.label}</p>
          <p className="text-[11px] text-muted">{arg.help}</p>
          <code className="text-[10px] text-muted/70">{arg.flag}</code>
        </div>
        <Toggle
          checked={value === true}
          onChange={(on) => onChange(on ? true : undefined)}
          label={arg.label}
        />
      </div>
    );
  }

  return (
    <div className="space-y-1 rounded-xl border border-line bg-surface px-3 py-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm">{arg.label}</span>
        <span className="shrink-0 text-[10px] text-muted/70">
          <code>{arg.flag}</code>
          {!set && arg.fallback && ` · ${arg.fallback}`}
        </span>
      </div>

      {arg.type === 'choice' ? (
        <select
          value={typeof value === 'string' ? value : ''}
          aria-label={arg.label}
          onChange={(event) => onChange(event.target.value || undefined)}
          className="w-full rounded-lg border border-line bg-surface-2 px-2.5 py-1.5 text-sm"
        >
          <option value="">{arg.fallback ? `Default (${arg.fallback})` : 'Not set'}</option>
          {(arg.choices ?? []).map((choice) => (
            <option key={choice} value={choice}>
              {choice}
            </option>
          ))}
        </select>
      ) : (
        <div className="flex items-center gap-1.5">
          <TextInput
            value={value === undefined ? '' : String(value)}
            label={arg.label}
            placeholder={arg.fallback ? `Default: ${arg.fallback}` : 'Not set'}
            onCommit={(text) => {
              const trimmed = text.trim();
              if (trimmed === '') {
                onChange(undefined);
                return;
              }
              if (arg.type === 'int' || arg.type === 'float') {
                const number = Number(trimmed);
                /*
                 * Kept as text when it is not a number.
                 *
                 * Silently dropping it would look like the field refusing to
                 * accept what was typed; passing it through means the service
                 * itself says what is wrong with it, which is a better error
                 * than anything this form could invent.
                 */
                onChange(Number.isFinite(number) ? number : trimmed);
                return;
              }
              onChange(trimmed);
            }}
          />
          {set && (
            <button
              type="button"
              onClick={() => onChange(undefined)}
              aria-label={`Unset ${arg.label}`}
              className="shrink-0 px-1.5 text-xs text-muted"
            >
              ×
            </button>
          )}
        </div>
      )}

      <p className="text-[11px] text-muted">{arg.help}</p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Log                                                                 */
/* ------------------------------------------------------------------ */

/**
 * What the process has been saying, as it says it.
 *
 * Polled by sequence rather than streamed: a service that has crashed is
 * exactly the case where a stream would have gone away, and a poll that asks
 * "what is new since line 412" costs nothing while a service is quiet and
 * catches up in one request when it is not.
 *
 * It follows the bottom, and stops following the moment you scroll up — reading
 * the line that explains a crash while the view keeps jumping past it is the
 * one thing a log viewer must not do.
 */
function ServiceLog({ view, onClose }: { view: ServiceView; onClose: () => void }) {
  const [lines, setLines] = useState<ServiceLogLine[]>([]);
  const seq = useRef(0);
  const box = useRef<HTMLDivElement>(null);
  const follow = useRef(true);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const tail = await api.serviceLog(view.config.id, seq.current);
        if (!alive) return;
        if (tail.lines.length > 0) {
          seq.current = tail.seq;
          // Bounded, so a service that writes a progress bar for an hour does
          // not turn into a browser tab holding a hundred megabytes of strings.
          setLines((current) => [...current, ...tail.lines].slice(-1500));
        }
      } catch {
        // A poll that fails is not worth saying anything about: the next one is
        // a second away, and the card behind this already reports the state.
      }
    };

    void poll();
    const timer = setInterval(() => void poll(), 1_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [view.config.id]);

  useEffect(() => {
    if (!follow.current) return;
    const element = box.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [lines]);

  return (
    <Sheet open onClose={onClose} title={`${view.config.name} — log`} full>
      <div className="space-y-2">
        <div
          ref={box}
          onScroll={(event) => {
            const element = event.currentTarget;
            follow.current =
              element.scrollHeight - element.scrollTop - element.clientHeight < 40;
          }}
          className="h-[60vh] overflow-y-auto rounded-xl border border-line bg-ink p-2.5 font-mono text-[11px] leading-relaxed"
        >
          {lines.length === 0 ? (
            <p className="p-4 text-center font-sans text-sm text-muted">
              Nothing yet. Output appears here as soon as it is started.
            </p>
          ) : (
            lines.map((line) => (
              <div
                key={line.seq}
                className={cn(
                  'break-all whitespace-pre-wrap',
                  line.stream === 'stderr'
                    ? 'text-warn'
                    : line.stream === 'latent'
                      ? 'text-accent'
                      : 'text-body/80',
                )}
              >
                {line.text}
              </div>
            ))
          )}
        </div>

        <p className="text-[11px] text-muted">
          The last {LOG_HINT} lines. Purple lines are Latent's own — what it ran, and what
          happened to it. Scroll up to stop it following.
        </p>
      </div>
    </Sheet>
  );
}

/** Matches the server's ring buffer; said here so the note is not a guess. */
const LOG_HINT = 800;

/** `3m`, `2h` — how long it has been up, in one glance. */
function since(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}
