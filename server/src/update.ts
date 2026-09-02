import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';

import type {
  UpdateAvailable,
  UpdateCheckout,
  UpdateLogLine,
  UpdateRun,
  UpdateStatus,
  UpdateStep,
  UpdateStepName,
  UpdateSupervisor,
} from '@latent/shared';

/**
 * Installing a new version of Latent from the machine Latent is running on.
 *
 * The obvious design — delete the directory, clone it again — is the one thing
 * this deliberately does not do, for two reasons. The process's own working
 * directory is that directory, so deleting it leaves the updater with nowhere
 * to stand and no way to clone back into it; and a clone that fails halfway
 * leaves a machine with no Latent on it at all, which is a poor thing to
 * discover from a phone. `git reset --hard` reaches the same commit, never
 * removes the directory it is standing in, and can be undone by resetting back
 * — so a failed update ends where it started rather than nowhere.
 *
 * What it costs: uncommitted work in the tree would be destroyed, so a dirty
 * checkout is refused rather than reset. That is the one case where "clone
 * fresh" would have been kinder, and it is also the case where somebody has
 * edits on the box that they probably want.
 *
 * Nothing here has to move data out of the way first: the database, the archive
 * and the settings files all live *outside* the project directory by default
 * (see `loadConfig`), which was decided for this exact reason long before there
 * was a button.
 */

/** How long a step may run before it is killed, in milliseconds. */
const GIT_TIMEOUT = 5 * 60 * 1000;
/** Installing can compile better-sqlite3 from source on a slow box. */
const NPM_TIMEOUT = 30 * 60 * 1000;

/**
 * How many log lines are kept.
 *
 * `npm install` on a cold tree is thousands of lines, and this is all in
 * memory. The oldest are dropped rather than the newest: a client that is
 * watching has already been sent them, and one that is not has no use for the
 * middle of an install it did not see the end of.
 */
const LOG_LIMIT = 5000;

/**
 * How long the git facts are trusted before being read again.
 *
 * Reading them is seven `git` invocations, and the settings screen polls this
 * endpoint the whole time it is open. A minute is long enough that idling on
 * that screen costs nothing, and short enough that committing something on the
 * box and then looking at the phone shows the truth. Anything that *moves* the
 * checkout clears the cache outright rather than waiting for it to lapse.
 */
const CHECKOUT_TTL = 60_000;

export interface CommandRequest {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  /** Called per line while it runs. Absent for the quick probing commands. */
  onLine?: (stream: 'out' | 'err', text: string) => void;
}

export interface CommandResult {
  /** Null when the command could not be started at all, or was killed. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** Set when the command did not start, or timed out. */
  failure: string | null;
}

export type RunCommand = (request: CommandRequest) => Promise<CommandResult>;

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/**
 * Run one command, streaming its output a line at a time.
 *
 * Never rejects. A missing binary, a non-zero exit and a timeout are all
 * ordinary outcomes of an update — each one is something to show somebody, not
 * an exception to unwind through the run.
 */
export const spawnCommand: RunCommand = (request) =>
  new Promise<CommandResult>((settle) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(request.command, request.args, {
        cwd: request.cwd,
        env: process.env,
        // No shell: the arguments are fixed strings and a branch name, and a
        // shell is the one thing that would let a branch name mean anything
        // other than a branch name.
        shell: false,
      });
    } catch (error) {
      settle({
        code: null,
        stdout: '',
        stderr: '',
        failure: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    let failure: string | null = null;
    let done = false;

    const timer = setTimeout(() => {
      failure = `\`${request.command}\` was still running after ${Math.round(
        request.timeoutMs / 60000,
      )} minutes and was stopped.`;
      child.kill('SIGKILL');
    }, request.timeoutMs);

    /*
     * A per-stream remainder, because a chunk boundary lands mid-line often
     * enough to matter — and `\r` counts as a break so that npm's progress
     * redraws become separate lines instead of accumulating into one enormous
     * one that no phone can render.
     */
    const feed = (stream: 'out' | 'err') => {
      let rest = '';
      return (chunk: Buffer) => {
        const text = rest + chunk.toString('utf8');
        const parts = text.split(/\r\n|\r|\n/);
        rest = parts.pop() ?? '';
        for (const part of parts) request.onLine?.(stream, part);
      };
    };

    const outFeed = feed('out');
    const errFeed = feed('err');

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      if (request.onLine) outFeed(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
      if (request.onLine) errFeed(chunk);
    });

    const finish = (result: CommandResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      settle(result);
    };

    child.on('error', (error) => {
      finish({ code: null, stdout, stderr, failure: error.message });
    });
    child.on('close', (code) => {
      finish({ code, stdout, stderr, failure });
    });
  });

/**
 * What would start Latent again if this process exited.
 *
 * Checked rather than assumed. The update only takes effect when the process is
 * replaced, and Latent cannot start itself — so on a machine where somebody
 * typed `npm start` into a shell, a restart button is a stop button, and the
 * phone that pressed it is the worst possible place to find that out.
 */
export function detectSupervisor(
  env: NodeJS.ProcessEnv = process.env,
  fileExists: (path: string) => boolean = existsSync,
): UpdateSupervisor {
  // pm2 first: inside a container it is still the thing that restarts the
  // process, and the container would only notice if pm2 itself died.
  if (env.pm_id !== undefined) {
    return {
      kind: 'pm2',
      restarts: true,
      note: 'pm2 is running this process and will start it again.',
    };
  }
  if (env.INVOCATION_ID !== undefined) {
    return {
      kind: 'systemd',
      restarts: true,
      note: 'systemd is running this process. It will come back if the unit sets Restart=.',
    };
  }
  if (fileExists('/.dockerenv')) {
    return {
      kind: 'docker',
      restarts: true,
      note:
        'This is a container. It will come back if it was started with a restart policy — ' +
        'the shipped docker-compose.yml sets one.',
    };
  }
  return {
    kind: 'unknown',
    restarts: false,
    note:
      'Nothing here looks like it would start Latent again. Restart it yourself once the ' +
      'update has installed, or run it under systemd, pm2 or Docker so it can restart itself.',
  };
}

function blankStep(name: UpdateStepName, command: string): UpdateStep {
  return { name, command, status: 'waiting', startedAt: null, endedAt: null, exitCode: null };
}

export interface UpdaterOptions {
  cwd: string;
  log?: { info(message: string): void; warn(message: string): void };
  /** Injected so the tests can script git and npm instead of running them. */
  run?: RunCommand;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  fileExists?: (path: string) => boolean;
}

export class Updater {
  private readonly cwd: string;
  private readonly run: RunCommand;
  private readonly now: () => number;
  private readonly log: { info(message: string): void; warn(message: string): void };
  private readonly supervisorInfo: UpdateSupervisor;

  private lines: UpdateLogLine[] = [];
  private seq = 0;
  private current: UpdateRun | null = null;
  private active: Promise<void> | null = null;

  private checkout: UpdateCheckout | null = null;
  private checkoutReadAt = 0;
  private available: UpdateAvailable = {
    checkedAt: null,
    behind: 0,
    ahead: 0,
    commit: null,
    commitShort: null,
    subject: null,
  };

  constructor(options: UpdaterOptions) {
    this.cwd = options.cwd;
    this.run = options.run ?? spawnCommand;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? { info: () => {}, warn: () => {} };
    this.supervisorInfo = detectSupervisor(options.env, options.fileExists);
  }

  get isRunning(): boolean {
    return this.current?.phase === 'running';
  }

  /**
   * Everything a client needs, and only what it asked for.
   *
   * `since` is a cursor over the log rather than a page number, so a phone that
   * slept through half an install asks once and is told the half it missed.
   */
  async status(since = 0): Promise<UpdateStatus> {
    const checkout = await this.readCheckout();
    return {
      checkout,
      available: this.available,
      run: this.current,
      log: this.lines.filter((line) => line.seq > since),
      cursor: this.seq,
      supervisor: this.supervisorInfo,
    };
  }

  /** Ask the remote what it has. The one part of a check that touches network. */
  async check(): Promise<UpdateStatus> {
    const checkout = await this.readCheckout(true);
    if (!checkout.updatable || !checkout.branch || !checkout.upstream) {
      return this.status();
    }

    const remote = await this.remoteFor(checkout.branch);
    const fetched = await this.capture('git', ['fetch', remote, checkout.branch], GIT_TIMEOUT);
    if (fetched.code !== 0) {
      // Not fatal, and not a state change: the counts below simply stay as
      // whatever the last successful fetch left behind.
      // `||`, not `??`: an empty stderr is a string, so `??` would keep it and
      // the note would be a blank line where the reason should be.
      this.note(null, fetched.failure || fetched.stderr.trim() || 'Could not reach the remote.');
      return this.status();
    }

    await this.readAvailable(checkout.upstream);
    return this.status();
  }

  /**
   * Begin an update, if one can begin.
   *
   * Returns immediately: installing takes minutes, and a request held open for
   * minutes is one a phone loses. Progress is read back through `status`.
   */
  async start(): Promise<{ ok: true; run: UpdateRun } | { ok: false; error: string }> {
    if (this.isRunning) return { ok: false, error: 'An update is already running.' };

    const checkout = await this.readCheckout(true);
    if (!checkout.updatable) {
      return { ok: false, error: checkout.reason ?? 'This install cannot be updated from here.' };
    }
    if (checkout.dirty) {
      return {
        ok: false,
        error:
          'There are uncommitted changes in the project directory. Installing an update would ' +
          'discard them, so it has not been started — commit or stash them first.',
      };
    }
    if (!checkout.commit || !checkout.branch || !checkout.upstream) {
      return { ok: false, error: 'This checkout has no commit to move from.' };
    }

    const started = this.now();
    this.lines = [];
    this.seq = 0;
    this.current = {
      id: randomUUID(),
      phase: 'running',
      startedAt: started,
      endedAt: null,
      from: checkout.commit,
      to: null,
      steps: [
        blankStep('fetch', `git fetch ${await this.remoteFor(checkout.branch)} ${checkout.branch}`),
        blankStep('reset', `git reset --hard ${checkout.upstream}`),
        blankStep('install', `${npmCommand} install --include=dev --no-audit --no-fund`),
        blankStep('build', `${npmCommand} run build`),
      ],
      error: null,
      restartRequired: false,
    };

    this.log.warn(`Update started from ${checkout.commit.slice(0, 8)} on ${checkout.branch}.`);
    this.active = this.execute(checkout).catch(async (error: unknown) => {
      // Nothing in `execute` throws by design, so reaching here means a bug —
      // which must still leave the run in a state a screen can render.
      await this.fail(error instanceof Error ? error.message : String(error), false);
    });
    return { ok: true, run: this.current };
  }

  /** Wait for the run in flight. For tests and for a clean shutdown. */
  async settled(): Promise<void> {
    await this.active;
  }

  /* ---------------------------------------------------------------- */
  /* The run                                                           */
  /* ---------------------------------------------------------------- */

  private async execute(checkout: UpdateCheckout): Promise<void> {
    const branch = checkout.branch as string;
    const upstream = checkout.upstream as string;
    const remote = await this.remoteFor(branch);

    if (!(await this.step('fetch', 'git', ['fetch', remote, branch], GIT_TIMEOUT))) {
      // Nothing was touched, so there is nothing to undo.
      await this.fail('Could not fetch from the remote.', false);
      return;
    }

    if (!(await this.step('reset', 'git', ['reset', '--hard', upstream], GIT_TIMEOUT))) {
      await this.fail('Could not move the checkout to the new commit.', false);
      return;
    }

    if (
      !(await this.step(
        'install',
        npmCommand,
        ['install', '--include=dev', '--no-audit', '--no-fund'],
        NPM_TIMEOUT,
      ))
    ) {
      // `--include=dev` and not a bare install: a production deployment has
      // NODE_ENV=production set, under which npm skips devDependencies — and
      // the build needs TypeScript and Vite, both of which are dev.
      await this.fail('Dependencies could not be installed.');
      return;
    }

    if (!(await this.step('build', npmCommand, ['run', 'build'], NPM_TIMEOUT))) {
      await this.fail('The new version did not build.');
      return;
    }

    const head = await this.capture('git', ['rev-parse', 'HEAD'], GIT_TIMEOUT);
    const run = this.current;
    if (run) {
      run.phase = 'succeeded';
      run.endedAt = this.now();
      run.to = head.stdout.trim() || null;
      run.restartRequired = run.to !== run.from;
      this.note(
        null,
        run.restartRequired
          ? 'Installed. Latent has to be restarted to run it.'
          : 'Already up to date — nothing changed.',
      );
    }
    // The tree has moved, so everything read before it moved is stale.
    this.checkout = null;
    const settled = await this.readCheckout(true);
    if (settled.upstream) await this.readAvailable(settled.upstream);
    this.log.warn('Update finished.');
  }

  /**
   * One command, recorded as a step.
   *
   * Returns whether it succeeded rather than throwing: every caller's next move
   * is to stop and roll back, and an exception would have to be caught at each
   * one anyway to do that.
   */
  private async step(
    name: UpdateStepName,
    command: string,
    args: string[],
    timeoutMs: number,
  ): Promise<boolean> {
    const step = this.current?.steps.find((entry) => entry.name === name);
    if (step) {
      step.status = 'running';
      step.startedAt = this.now();
    }

    const result = await this.run({
      command,
      args,
      cwd: this.cwd,
      timeoutMs,
      onLine: (stream, text) => this.push(name, stream, text),
    });

    if (result.failure) this.push(name, 'err', result.failure);
    if (step) {
      step.exitCode = result.code;
      step.endedAt = this.now();
      step.status = result.code === 0 ? 'done' : 'failed';
    }
    return result.code === 0;
  }

  /**
   * Give up, and put the checkout back where it was.
   *
   * The rollback is one step running three commands, and its `command` string
   * says so verbatim — because the moment somebody reads it is the moment they
   * are deciding whether to SSH in and finish it by hand.
   */
  private async fail(error: string, rollback = true): Promise<void> {
    const run = this.current;
    if (!run) return;

    for (const step of run.steps) {
      if (step.status === 'waiting') step.status = 'skipped';
    }

    if (rollback) await this.rollBack(run, error);
    else this.note(null, error);

    run.phase = 'failed';
    run.endedAt = this.now();
    run.error = error;
    /*
     * Nothing to restart for, either way.
     *
     * A rollback that worked leaves exactly the code that is already running.
     * One that failed leaves a tree nobody should restart *into* — and saying
     * "restart to finish installing" there would be the single worst thing this
     * screen could offer. The failed step says what happened instead.
     */
    run.restartRequired = false;
    this.log.warn(`Update failed: ${error}`);
    this.checkout = null;
  }

  private async rollBack(run: UpdateRun, error: string): Promise<void> {
    this.note(null, `${error} Putting the checkout back at ${run.from.slice(0, 8)}.`);
    const step = blankStep(
      'rollback',
      `git reset --hard ${run.from} && ${npmCommand} install --include=dev && ${npmCommand} run build`,
    );
    step.status = 'running';
    step.startedAt = this.now();
    run.steps.push(step);

    const commands: [string, string[], number][] = [
      ['git', ['reset', '--hard', run.from], GIT_TIMEOUT],
      [npmCommand, ['install', '--include=dev', '--no-audit', '--no-fund'], NPM_TIMEOUT],
      [npmCommand, ['run', 'build'], NPM_TIMEOUT],
    ];

    let code: number | null = 0;
    for (const [command, args, timeoutMs] of commands) {
      const result = await this.run({
        command,
        args,
        cwd: this.cwd,
        timeoutMs,
        onLine: (stream, text) => this.push('rollback', stream, text),
      });
      if (result.failure) this.push('rollback', 'err', result.failure);
      code = result.code;
      if (code !== 0) break;
    }

    step.exitCode = code;
    step.endedAt = this.now();
    step.status = code === 0 ? 'done' : 'failed';
    run.to = run.from;
    if (code !== 0) {
      this.note(
        null,
        'The rollback did not finish either. The checkout may be part-way between two ' +
          'versions — the commands above are the ones to run by hand.',
      );
    }
  }

  /* ---------------------------------------------------------------- */
  /* Reading the checkout                                              */
  /* ---------------------------------------------------------------- */

  private async readCheckout(force = false): Promise<UpdateCheckout> {
    const fresh = this.now() - this.checkoutReadAt < CHECKOUT_TTL;
    if (this.checkout && fresh && !force) return this.checkout;
    // Mid-run the tree is being rewritten under us, and every answer would be
    // a snapshot of something in motion. The one taken at the start is the
    // one that describes the run.
    if (this.checkout && this.isRunning) return this.checkout;

    const checkout = await this.inspect();
    this.checkout = checkout;
    this.checkoutReadAt = this.now();
    return checkout;
  }

  private blocked(reason: string, partial: Partial<UpdateCheckout> = {}): UpdateCheckout {
    return {
      updatable: false,
      reason,
      branch: null,
      upstream: null,
      commit: null,
      commitShort: null,
      committedAt: null,
      subject: null,
      dirty: false,
      ...partial,
    };
  }

  private async inspect(): Promise<UpdateCheckout> {
    const version = await this.capture('git', ['--version'], GIT_TIMEOUT);
    if (version.code !== 0) {
      /*
       * The Docker image is the ordinary way to land here: it is built from a
       * checkout and shipped without one, and `git` is not in the runtime layer
       * either. So this says the same thing the not-a-checkout branch below
       * does, rather than a true but useless "git is missing".
       */
      return this.blocked(
        'git is not installed here, so this copy cannot update itself. Update it the way it ' +
          'was installed (for Docker: docker compose pull, then up -d).',
      );
    }

    const inside = await this.capture('git', ['rev-parse', '--is-inside-work-tree'], GIT_TIMEOUT);
    if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
      return this.blocked(
        'This copy of Latent is not a git checkout — it was unpacked, or built into an image. ' +
          'Update it the way it was installed (for Docker: docker compose pull, then up -d).',
      );
    }

    const commitInfo = await this.capture(
      'git',
      ['log', '-1', '--format=%H%x1f%h%x1f%ct%x1f%s'],
      GIT_TIMEOUT,
    );
    const [commit = null, commitShort = null, committed = '', subject = null] = commitInfo.stdout
      .trim()
      .split('\x1f');
    const committedAt = Number(committed);
    const identity = {
      commit,
      commitShort,
      committedAt: Number.isFinite(committedAt) && committedAt > 0 ? committedAt * 1000 : null,
      subject,
    };

    const dirtyResult = await this.capture('git', ['status', '--porcelain'], GIT_TIMEOUT);
    const dirty = dirtyResult.code === 0 && dirtyResult.stdout.trim() !== '';

    const branchResult = await this.capture(
      'git',
      ['symbolic-ref', '--quiet', '--short', 'HEAD'],
      GIT_TIMEOUT,
    );
    const branch = branchResult.code === 0 ? branchResult.stdout.trim() : '';
    if (!branch) {
      return this.blocked(
        'This checkout is not on a branch (a detached HEAD), so there is nothing to update ' +
          'towards. Check out a branch first.',
        { ...identity, dirty },
      );
    }

    const upstreamResult = await this.capture(
      'git',
      ['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${branch}@{upstream}`],
      GIT_TIMEOUT,
    );
    const upstream = upstreamResult.code === 0 ? upstreamResult.stdout.trim() : '';
    if (!upstream) {
      return this.blocked(
        `The branch '${branch}' does not track a remote branch, so there is nowhere to update ` +
          'from. Set one with git branch --set-upstream-to.',
        { ...identity, branch, dirty },
      );
    }

    return { updatable: true, reason: null, ...identity, branch, upstream, dirty };
  }

  /** How far behind the upstream is, from what was last fetched. */
  private async readAvailable(upstream: string): Promise<void> {
    const counts = await this.capture(
      'git',
      ['rev-list', '--left-right', '--count', `HEAD...${upstream}`],
      GIT_TIMEOUT,
    );
    const [aheadText = '0', behindText = '0'] = counts.stdout.trim().split(/\s+/);
    const ahead = Number(aheadText);
    const behind = Number(behindText);

    const head = await this.capture(
      'git',
      ['log', '-1', '--format=%H%x1f%h%x1f%s', upstream],
      GIT_TIMEOUT,
    );
    const [commit = null, commitShort = null, subject = null] = head.stdout.trim().split('\x1f');

    this.available = {
      checkedAt: this.now(),
      ahead: Number.isFinite(ahead) ? ahead : 0,
      behind: Number.isFinite(behind) ? behind : 0,
      commit,
      commitShort,
      subject,
    };
  }

  /**
   * Which remote a branch pulls from.
   *
   * Read from the branch's own config rather than split off the front of
   * `origin/main`, because a remote may itself contain a slash and the split
   * would then name a remote that does not exist.
   */
  private async remoteFor(branch: string): Promise<string> {
    const result = await this.capture(
      'git',
      ['config', '--get', `branch.${branch}.remote`],
      GIT_TIMEOUT,
    );
    return result.stdout.trim() || 'origin';
  }

  private capture(command: string, args: string[], timeoutMs: number): Promise<CommandResult> {
    return this.run({ command, args, cwd: this.cwd, timeoutMs });
  }

  /* ---------------------------------------------------------------- */
  /* The log                                                           */
  /* ---------------------------------------------------------------- */

  private note(step: UpdateStepName | null, text: string): void {
    this.push(step, 'note', text);
  }

  private push(step: UpdateStepName | null, stream: 'out' | 'err' | 'note', text: string): void {
    if (stream !== 'note' && text.trim() === '') return;
    this.seq += 1;
    this.lines.push({ seq: this.seq, step, stream, text });
    if (this.lines.length > LOG_LIMIT) this.lines.splice(0, this.lines.length - LOG_LIMIT);
  }
}
