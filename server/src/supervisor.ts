import { spawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';

import {
  buildCommand,
  commandLine,
  definitionFor,
  type ServiceCommand,
  type ServiceConfig,
  type ServiceLogLine,
  type ServiceState,
  type ServiceStatus,
} from '@latent/shared';

import type { Store } from './db.js';

/**
 * Starting, watching and restarting the processes Latent hosts.
 *
 * The premise is that Latent stays up. It is a small server that reads a
 * database and proxies HTTP, and it runs for weeks; ComfyUI and llama-server
 * are large programs holding a GPU, and they do not. So the stable process
 * gets the job of noticing that an unstable one has died and starting it again
 * — which is the whole feature, and everything else here exists to make that
 * safe to do unattended.
 *
 * What "safe" means, concretely, is the restart policy below: a program that
 * dies *immediately*, every time, must not be restarted forever. A
 * misconfigured command line fails in under a second, and a supervisor without
 * a backoff would then run it a hundred times a minute for as long as nobody
 * was looking. So restarts back off, and a run of them that never stays up
 * gives up and says why.
 *
 * Nothing here knows what a service *is*. Which program, which flags, where the
 * binary lives: all of that is the catalogue in `shared/src/supervisor.ts`, and
 * this module only knows how to turn the command it is handed into a process
 * and how to react when that process ends.
 */

/** How many lines of output are kept per service. */
const LOG_LINES = 800;

/** How long a `SIGTERM` is given before the process is killed outright. */
const STOP_GRACE_MS = 8_000;

/** The first restart delay, doubled each time until the ceiling. */
const RESTART_BASE_MS = 2_000;
const RESTART_MAX_MS = 60_000;

/**
 * How long a process must stay up to have "started successfully".
 *
 * Below this it is a failure to launch — a missing model file, a port already
 * taken, a Python that cannot import something — and those repeat identically
 * however many times they are tried. Above it, whatever went wrong happened
 * during real work, and trying again is a reasonable thing to do.
 */
const HEALTHY_AFTER_MS = 30_000;

/** How many failures to launch in a row before it stops trying. */
const MAX_RAPID_RESTARTS = 5;

interface Running {
  child: ChildProcess;
  startedAt: number;
  /** True once someone asked for it to stop, so the exit is not a crash. */
  deliberate: boolean;
  killTimer?: NodeJS.Timeout;
}

interface Tracked {
  status: ServiceStatus;
  running: Running | null;
  log: ServiceLogLine[];
  /** Grows forever within a process, so a client can ask for what is new. */
  seq: number;
  /** Consecutive launches that did not survive `HEALTHY_AFTER_MS`. */
  rapidFailures: number;
  restartTimer?: NodeJS.Timeout;
  /** Half a line held back until its newline arrives. See `absorb`. */
  partial: { stdout: string; stderr: string };
}

export class Supervisor {
  private readonly tracked = new Map<string, Tracked>();

  constructor(
    private readonly store: Store,
    private readonly log: FastifyBaseLogger,
  ) {}

  /* ---------------------------------------------------------------- */
  /* Reading                                                           */
  /* ---------------------------------------------------------------- */

  /**
   * What a service is doing, for a service that may never have been started.
   *
   * Everything is derived rather than stored, including the command — which is
   * rebuilt from the configuration on every read so that editing an argument
   * changes what the screen says it will run, immediately, without having to
   * start anything to find out.
   */
  statusOf(config: ServiceConfig): ServiceStatus {
    const tracked = this.tracked.get(config.id);
    const command = this.commandFor(config);

    const base: ServiceStatus = {
      id: config.id,
      state: 'stopped',
      pid: null,
      startedAt: null,
      stoppedAt: null,
      exitCode: null,
      exitSignal: null,
      restarts: 0,
      error: config.root.trim() === '' ? 'No root directory set.' : command ? null : notFound(config),
      command: commandLine(command),
      restartAt: null,
    };

    if (!tracked) return base;
    return { ...tracked.status, command: base.command, error: tracked.status.error ?? base.error };
  }

  /**
   * The output since a given line, newest last.
   *
   * By sequence rather than by time, so a client that polls can ask for
   * precisely what it has not seen without worrying about two lines landing in
   * the same millisecond.
   */
  logSince(id: string, since: number): { lines: ServiceLogLine[]; seq: number } {
    const tracked = this.tracked.get(id);
    if (!tracked) return { lines: [], seq: 0 };
    return {
      lines: tracked.log.filter((line) => line.seq > since),
      seq: tracked.seq,
    };
  }

  /* ---------------------------------------------------------------- */
  /* Running                                                           */
  /* ---------------------------------------------------------------- */

  /**
   * Start a service, unless it is already up.
   *
   * Returns the reason it could not, rather than throwing: every way this fails
   * is a thing the person configuring it needs to read — no root, no binary
   * where the root says — and none of them is exceptional.
   */
  start(config: ServiceConfig): string | null {
    const tracked = this.track(config.id);
    this.cancelRestart(tracked);

    if (tracked.running) return null;

    if (config.root.trim() === '') return 'Set the root directory first.';

    const command = this.commandFor(config);
    if (!command) return notFound(config);

    const cwd = resolve(config.root);
    /*
     * A launcher file with no path separator is a program on the PATH, not a
     * file under the root. `python3` is the case this exists for: it is how a
     * system install is started, and resolving it against the root would look
     * for `/opt/ComfyUI/python3` and not find it.
     */
    const file = command.file.includes('/') || command.file.includes('\\')
      ? resolve(cwd, command.file)
      : command.file;

    tracked.status = {
      ...tracked.status,
      state: 'starting',
      error: null,
      exitCode: null,
      exitSignal: null,
      restartAt: null,
    };
    this.note(tracked, 'latent', `Starting: ${commandLine(command)}`);

    let child: ChildProcess;
    try {
      child = spawn(file, command.args, {
        cwd,
        /*
         * No shell. The arguments are an array and reach the program as one,
         * which means a path with a space in it works and a semicolon in a
         * field is a character in an argument rather than a second command.
         */
        shell: false,
        windowsHide: true,
        env: { ...process.env, ...config.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      tracked.status = { ...tracked.status, state: 'failed', error: message };
      this.note(tracked, 'latent', `Could not start: ${message}`);
      return message;
    }

    const startedAt = Date.now();
    tracked.running = { child, startedAt, deliberate: false };
    tracked.status = {
      ...tracked.status,
      state: 'running',
      pid: child.pid ?? null,
      startedAt,
      stoppedAt: null,
    };

    child.stdout?.on('data', (chunk: Buffer) => this.absorb(tracked, 'stdout', chunk));
    child.stderr?.on('data', (chunk: Buffer) => this.absorb(tracked, 'stderr', chunk));

    /*
     * `error` fires instead of `exit` when the program could not be run at all
     * — the commonest case being a path that is right about the folder and
     * wrong about the file. Recorded as the status's error rather than only
     * logged, because it is the answer to "why is it not starting".
     */
    child.on('error', (error) => {
      const message = error instanceof Error ? error.message : String(error);
      tracked.status = { ...tracked.status, error: message };
      this.note(tracked, 'latent', `Process error: ${message}`);
    });

    child.on('exit', (code, signal) => this.onExit(config.id, tracked, code, signal));

    return null;
  }

  /**
   * Ask a service to stop, and insist if it does not.
   *
   * `SIGTERM` first, because both of these write things on the way down —
   * ComfyUI finishes the file it is saving — and `SIGKILL` after the grace
   * period, because a process that ignores a term signal is a process that
   * would otherwise hold the port forever and stop the restart working.
   *
   * On Windows there is no signal to send: `kill()` terminates outright, which
   * is the platform's own answer and not something this can improve on.
   */
  stop(id: string): void {
    const tracked = this.tracked.get(id);
    if (!tracked) return;
    this.cancelRestart(tracked);

    const running = tracked.running;
    if (!running) {
      tracked.status = { ...tracked.status, state: 'stopped', restartAt: null };
      return;
    }

    running.deliberate = true;
    tracked.status = { ...tracked.status, state: 'stopping' };
    this.note(tracked, 'latent', 'Stopping.');
    running.child.kill('SIGTERM');

    running.killTimer = setTimeout(() => {
      if (tracked.running !== running) return;
      this.note(tracked, 'latent', 'It did not stop, so it is being killed.');
      running.child.kill('SIGKILL');
    }, STOP_GRACE_MS);
    running.killTimer.unref?.();
  }

  /**
   * Stop it and start it again once it is actually down.
   *
   * Waits for the exit rather than starting straight away: the new process
   * would bind the same port as the old one and fail immediately, which is the
   * single most confusing way for a restart button to behave.
   */
  restart(config: ServiceConfig): void {
    const tracked = this.track(config.id);
    if (!tracked.running) {
      this.start(config);
      return;
    }

    const running = tracked.running;
    running.child.once('exit', () => {
      // Only if nobody has started it in the meantime, and only for the service
      // as it is configured *now* — a restart after an edit runs the edit.
      const latest = this.store.getService(config.id);
      if (latest && !this.tracked.get(config.id)?.running) this.start(latest);
    });
    this.stop(config.id);
  }

  /** Start everything that asked to be started with Latent. */
  startAutomatic(): void {
    for (const config of this.store.listServices()) {
      if (!config.autoStart) continue;
      const failure = this.start(config);
      if (failure) this.log.warn({ service: config.name }, `Could not auto-start: ${failure}`);
    }
  }

  /**
   * Stop everything, for a Latent that is shutting down.
   *
   * Deliberately synchronous in effect: the signals go out now, and the
   * processes die on their own schedule. A supervisor that left its children
   * running would leave a GPU held by something with no parent to stop it.
   */
  stopAll(): void {
    for (const id of [...this.tracked.keys()]) this.stop(id);
  }

  /* ---------------------------------------------------------------- */
  /* Internals                                                         */
  /* ---------------------------------------------------------------- */

  private track(id: string): Tracked {
    const existing = this.tracked.get(id);
    if (existing) return existing;

    const fresh: Tracked = {
      status: {
        id,
        state: 'stopped',
        pid: null,
        startedAt: null,
        stoppedAt: null,
        exitCode: null,
        exitSignal: null,
        restarts: 0,
        error: null,
        command: '',
        restartAt: null,
      },
      running: null,
      log: [],
      seq: 0,
      rapidFailures: 0,
      partial: { stdout: '', stderr: '' },
    };
    this.tracked.set(id, fresh);
    return fresh;
  }

  /** The command a configuration produces, with existence checked on disk. */
  private commandFor(config: ServiceConfig): ServiceCommand | null {
    const definition = definitionFor(config.kind);
    if (!definition) return null;
    const root = config.root.trim();
    if (root === '') return null;

    return buildCommand(definition, config, (file) => {
      try {
        const path = isAbsolute(file) ? file : resolve(root, file);
        accessSync(path, constants.X_OK);
        return true;
      } catch {
        /*
         * Not executable, or not there. Either way this launcher is not the one
         * — a `python.exe` that cannot be executed is as useless as one that
         * does not exist, and saying so here is what makes the next launcher
         * get its turn.
         */
        return false;
      }
    });
  }

  /**
   * Turn a chunk of bytes into whole lines.
   *
   * A stream hands over whatever has arrived, which cuts lines in half — and a
   * log that shows half a progress line and then the other half as a second
   * entry is a log nobody can read. So the tail of a chunk is held until its
   * newline turns up in the next one.
   *
   * Carriage returns are line breaks here too: both of these programs draw
   * progress bars by rewriting one line, and treating `\r` as ordinary text
   * makes one entry that grows to a megabyte.
   */
  private absorb(tracked: Tracked, stream: 'stdout' | 'stderr', chunk: Buffer): void {
    const text = tracked.partial[stream] + chunk.toString('utf8');
    const parts = text.split(/\r\n|\r|\n/);
    tracked.partial[stream] = parts.pop() ?? '';

    for (const line of parts) {
      if (line.trim() === '') continue;
      this.note(tracked, stream, line);
    }

    /*
     * A "line" that never ends is still worth showing.
     *
     * A prompt waiting for input, or a progress bar that writes no terminator
     * at all, would otherwise sit in `partial` forever and the log would look
     * frozen at exactly the moment somebody is watching it to find out what is
     * happening. Past a sensible width it is flushed as it stands.
     */
    if (tracked.partial[stream].length > 4_000) {
      this.note(tracked, stream, tracked.partial[stream]);
      tracked.partial[stream] = '';
    }
  }

  private note(tracked: Tracked, stream: ServiceLogLine['stream'], text: string): void {
    tracked.seq += 1;
    tracked.log.push({ seq: tracked.seq, at: Date.now(), stream, text });
    if (tracked.log.length > LOG_LINES) tracked.log.splice(0, tracked.log.length - LOG_LINES);
  }

  private onExit(
    id: string,
    tracked: Tracked,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    const running = tracked.running;
    if (running?.killTimer) clearTimeout(running.killTimer);
    const deliberate = running?.deliberate ?? false;
    const lived = running ? Date.now() - running.startedAt : 0;
    tracked.running = null;

    tracked.status = {
      ...tracked.status,
      state: deliberate ? 'stopped' : 'exited',
      pid: null,
      stoppedAt: Date.now(),
      exitCode: code,
      exitSignal: signal,
    };

    this.note(
      tracked,
      'latent',
      deliberate
        ? 'Stopped.'
        : `Exited ${signal ? `on ${signal}` : `with code ${code ?? 'unknown'}`} after ${describe(lived)}.`,
    );

    if (deliberate) {
      tracked.rapidFailures = 0;
      return;
    }

    const config = this.store.getService(id);
    if (!config?.autoRestart) {
      tracked.status = { ...tracked.status, state: 'failed' };
      return;
    }

    /*
     * A process that stayed up and then died is a crash; one that died at once
     * is a command line that does not work. The first deserves an immediate
     * retry, the second deserves to be told about rather than retried a
     * thousand times — so the counter only advances on the short-lived ones,
     * and a healthy run clears it.
     */
    if (lived >= HEALTHY_AFTER_MS) tracked.rapidFailures = 0;
    else tracked.rapidFailures += 1;

    if (tracked.rapidFailures > MAX_RAPID_RESTARTS) {
      tracked.status = {
        ...tracked.status,
        state: 'failed',
        error:
          `It has failed to stay up ${tracked.rapidFailures} times in a row, so it will not be ` +
          'restarted again. The log above says why. Fix it and press Start.',
      };
      this.note(tracked, 'latent', 'Giving up on restarting it.');
      return;
    }

    const delay = Math.min(
      RESTART_BASE_MS * 2 ** Math.max(0, tracked.rapidFailures - 1),
      RESTART_MAX_MS,
    );
    const at = Date.now() + delay;
    tracked.status = { ...tracked.status, restarts: tracked.status.restarts + 1, restartAt: at };
    this.note(tracked, 'latent', `Restarting in ${Math.round(delay / 1000)}s.`);

    tracked.restartTimer = setTimeout(() => {
      tracked.restartTimer = undefined as unknown as NodeJS.Timeout;
      // Re-read, so a restart after an edit runs the edited command — and so a
      // service deleted while the timer was pending is simply not started.
      const latest = this.store.getService(id);
      if (!latest || !latest.autoRestart) return;
      const failure = this.start(latest);
      if (failure) this.note(tracked, 'latent', `Could not restart: ${failure}`);
    }, delay);
    tracked.restartTimer.unref?.();
  }

  private cancelRestart(tracked: Tracked): void {
    if (tracked.restartTimer) {
      clearTimeout(tracked.restartTimer);
      tracked.restartTimer = undefined as unknown as NodeJS.Timeout;
    }
    if (tracked.status.restartAt !== null) {
      tracked.status = { ...tracked.status, restartAt: null };
    }
  }

  /** Forget everything about a service that has been deleted. */
  forget(id: string): void {
    const tracked = this.tracked.get(id);
    if (!tracked) return;
    this.cancelRestart(tracked);
    this.tracked.delete(id);
  }
}

/** Whether a state means there is a process right now. */
export function isUp(state: ServiceState): boolean {
  return state === 'running' || state === 'starting' || state === 'stopping';
}

function notFound(config: ServiceConfig): string {
  const definition = definitionFor(config.kind);
  if (!definition) return `Latent does not know how to start a "${config.kind}".`;
  return (
    `Nothing to run in ${config.root}. Expected one of: ` +
    `${definition.launchers.map((launcher) => launcher.file).join(', ')}.`
  );
}

/** `4 minutes`, `12s` — how long it managed, in the units that make the point. */
function describe(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}
