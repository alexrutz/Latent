import { describe, expect, it } from 'vitest';

import { Updater, detectSupervisor, type CommandRequest, type CommandResult } from './update.js';

/**
 * The updater, with git and npm scripted rather than run.
 *
 * Everything interesting here is a failure path — a dirty tree, a build that
 * does not build, a rollback that also fails — and every one of them is a state
 * somebody would otherwise have to produce on a real machine to see once. A
 * scripted runner makes them ordinary test cases, which is the only way they
 * get looked at more than once.
 */

interface Scripted {
  /** Matched against `git rev-parse …` or `npm run build`, in order. */
  match: string;
  code?: number;
  stdout?: string;
  failure?: string;
  /** Lines the command "prints" while it runs. */
  lines?: string[];
  /**
   * Answer this way once, then fall through to whatever else matches.
   *
   * For the commands a run issues twice: `npm run build` fails, and the
   * rollback then builds the old commit, which succeeds. Without this the two
   * are the same string and there is no way to say they went differently.
   */
  once?: true;
}

const SEP = '\x1f';

/** The answers a healthy checkout gives to everything `inspect` asks. */
function healthyCheckout(commit = 'a'.repeat(40)): Scripted[] {
  return [
    { match: 'git --version', stdout: 'git version 2.43.0' },
    { match: 'git rev-parse --is-inside-work-tree', stdout: 'true' },
    { match: 'git log -1', stdout: [commit, commit.slice(0, 7), '1700000000', 'A commit'].join(SEP) },
    { match: 'git status --porcelain', stdout: '' },
    { match: 'git symbolic-ref', stdout: 'main' },
    { match: 'git rev-parse --abbrev-ref --symbolic-full-name', stdout: 'origin/main' },
    { match: 'git config --get', stdout: 'origin' },
  ];
}

/**
 * A runner that answers from a script and records what it was asked.
 *
 * Longest match wins, so a general answer for `git rev-parse` and a specific
 * one for `git rev-parse HEAD` can both be laid down without their order
 * mattering. Between two of the same length the *later* one wins, which is what
 * lets a test spread `...healthyCheckout()` and then override one line of it —
 * the whole reason that helper exists.
 */
function scriptedRunner(initial: Scripted[]) {
  const calls: string[] = [];
  const script = [...initial];

  const run = async (request: CommandRequest): Promise<CommandResult> => {
    const line = [request.command, ...request.args].join(' ');
    calls.push(line);

    const best = (pool: Scripted[]): Scripted | undefined => {
      let found: Scripted | undefined;
      for (const candidate of pool) {
        if (!line.startsWith(candidate.match)) continue;
        if (!found || candidate.match.length >= found.match.length) found = candidate;
      }
      return found;
    };

    // A one-shot answer outranks a standing one however they are ordered: it
    // exists precisely to say "this call goes differently from the others".
    const entry = best(script.filter((candidate) => candidate.once)) ?? best(script);
    if (entry?.once) script.splice(script.indexOf(entry), 1);
    for (const text of entry?.lines ?? []) request.onLine?.('out', text);

    return {
      code: entry?.failure ? null : (entry?.code ?? 0),
      stdout: entry?.stdout ?? '',
      stderr: '',
      failure: entry?.failure ?? null,
    };
  };

  return { run, calls };
}

function updater(script: Scripted[]) {
  const runner = scriptedRunner(script);
  return {
    ...runner,
    updater: new Updater({ cwd: '/project', run: runner.run, now: () => 1_700_000_000_000 }),
  };
}

describe('reading the checkout', () => {
  it('describes a healthy one', async () => {
    const { updater: subject } = updater(healthyCheckout());
    const { checkout } = await subject.status();

    expect(checkout.updatable).toBe(true);
    expect(checkout.reason).toBeNull();
    expect(checkout.branch).toBe('main');
    expect(checkout.upstream).toBe('origin/main');
    expect(checkout.commitShort).toBe('aaaaaaa');
    expect(checkout.subject).toBe('A commit');
    expect(checkout.dirty).toBe(false);
  });

  it('refuses a tree that is not a checkout, and says how to update it instead', async () => {
    const { updater: subject } = updater([
      { match: 'git --version', stdout: 'git version 2.43.0' },
      { match: 'git rev-parse --is-inside-work-tree', code: 128 },
    ]);
    const { checkout } = await subject.status();

    expect(checkout.updatable).toBe(false);
    expect(checkout.reason).toContain('docker compose pull');
  });

  it('says the same thing when git itself is missing', async () => {
    // Which is how the Docker image arrives here: built from a checkout,
    // shipped without one, and without git in the runtime layer either. "git
    // is missing" would be true and useless.
    const { updater: subject } = updater([{ match: 'git --version', code: 127 }]);
    const { checkout } = await subject.status();

    expect(checkout.updatable).toBe(false);
    expect(checkout.reason).toContain('docker compose pull');
  });

  it('refuses a detached HEAD, because there is nothing to update towards', async () => {
    const { updater: subject } = updater([
      ...healthyCheckout(),
      { match: 'git symbolic-ref', code: 1, stdout: '' },
    ]);
    const { checkout } = await subject.status();

    expect(checkout.updatable).toBe(false);
    expect(checkout.reason).toContain('detached HEAD');
    // Still says what is checked out. Knowing the commit is useful even when
    // nothing can be done about it from here.
    expect(checkout.commitShort).toBe('aaaaaaa');
  });

  it('refuses a branch that tracks nothing', async () => {
    const { updater: subject } = updater([
      ...healthyCheckout(),
      { match: 'git rev-parse --abbrev-ref --symbolic-full-name', code: 128, stdout: '' },
    ]);
    const { checkout } = await subject.status();

    expect(checkout.updatable).toBe(false);
    expect(checkout.reason).toContain('does not track a remote branch');
    expect(checkout.branch).toBe('main');
  });

  it('notices uncommitted changes without calling them a blocker on the install', async () => {
    const { updater: subject } = updater([
      ...healthyCheckout(),
      { match: 'git status --porcelain', stdout: ' M server/src/app.ts\n' },
    ]);
    const { checkout } = await subject.status();

    // The install is what gets refused; the checkout itself is fine.
    expect(checkout.updatable).toBe(true);
    expect(checkout.dirty).toBe(true);
  });
});

describe('what is waiting', () => {
  it('counts both directions, so local commits can be warned about', async () => {
    const { updater: subject } = updater([
      ...healthyCheckout(),
      { match: 'git fetch', stdout: '' },
      { match: 'git rev-list', stdout: '2\t5' },
      {
        match: 'git log -1 --format=%H%x1f%h%x1f%s origin/main',
        stdout: ['b'.repeat(40), 'bbbbbbb', 'Newer things'].join(SEP),
      },
    ]);

    const { available } = await subject.check();
    expect(available.ahead).toBe(2);
    expect(available.behind).toBe(5);
    expect(available.subject).toBe('Newer things');
    expect(available.checkedAt).not.toBeNull();
  });

  it('says so in a sentence when the remote answers with nothing at all', async () => {
    // No `failure`, no stderr — just a non-zero exit. The note has to say
    // something rather than being a blank line where the reason belongs.
    const { updater: subject } = updater([
      ...healthyCheckout(),
      { match: 'git fetch', code: 128 },
    ]);

    const status = await subject.check();
    expect(status.log.map((line) => line.text)).toContain('Could not reach the remote.');
  });

  it('survives a remote it cannot reach', async () => {
    const { updater: subject } = updater([
      ...healthyCheckout(),
      { match: 'git fetch', code: 128, failure: 'Could not resolve host: github.com' },
    ]);

    const status = await subject.check();
    expect(status.checkout.updatable).toBe(true);
    expect(status.available.checkedAt).toBeNull();
    expect(status.log.map((line) => line.text).join(' ')).toContain('Could not resolve host');
  });
});

describe('refusing to start', () => {
  it('will not reset over uncommitted work', async () => {
    const { updater: subject, calls } = updater([
      ...healthyCheckout(),
      { match: 'git status --porcelain', stdout: '?? notes.txt\n' },
    ]);

    const started = await subject.start();
    expect(started.ok).toBe(false);
    expect(started.ok === false && started.error).toContain('uncommitted changes');
    // And nothing was touched on the way to saying so.
    expect(calls.some((call) => call.startsWith('git reset'))).toBe(false);
  });

  it('will not start a second run on top of the first', async () => {
    const { updater: subject } = updater([
      ...healthyCheckout(),
      { match: 'git fetch', stdout: '' },
      { match: 'git reset', stdout: '' },
      { match: 'npm install', stdout: '' },
      { match: 'npm run build', stdout: '' },
      { match: 'git rev-parse HEAD', stdout: 'b'.repeat(40) },
      { match: 'git rev-list', stdout: '0\t0' },
    ]);

    expect((await subject.start()).ok).toBe(true);
    const second = await subject.start();
    expect(second.ok).toBe(false);
    expect(second.ok === false && second.error).toContain('already running');

    await subject.settled();
  });

  it('passes on the reason a checkout cannot be updated at all', async () => {
    const { updater: subject } = updater([
      { match: 'git --version', stdout: 'git version 2.43.0' },
      { match: 'git rev-parse --is-inside-work-tree', code: 128 },
    ]);

    const started = await subject.start();
    expect(started.ok).toBe(false);
    expect(started.ok === false && started.error).toContain('not a git checkout');
  });
});

describe('a run that works', () => {
  const script: Scripted[] = [
    ...healthyCheckout(),
    { match: 'git fetch', stdout: '', lines: ['From github.com:alexrutz/Latent'] },
    { match: 'git reset', stdout: '', lines: ['HEAD is now at bbbbbbb Newer things'] },
    { match: 'npm install', stdout: '', lines: ['added 3 packages'] },
    { match: 'npm run build', stdout: '', lines: ['built in 12s'] },
    { match: 'git rev-parse HEAD', stdout: 'b'.repeat(40) },
    { match: 'git rev-list', stdout: '0\t0' },
  ];

  it('runs the four steps in order and asks for a restart', async () => {
    const { updater: subject, calls } = updater(script);
    await subject.start();
    await subject.settled();

    const { run } = await subject.status();
    expect(run?.phase).toBe('succeeded');
    expect(run?.steps.map((step) => step.name)).toEqual(['fetch', 'reset', 'install', 'build']);
    expect(run?.steps.every((step) => step.status === 'done')).toBe(true);
    expect(run?.restartRequired).toBe(true);
    expect(run?.from).not.toBe(run?.to);

    // Dev dependencies explicitly: a production deployment sets
    // NODE_ENV=production, under which a bare install skips the TypeScript and
    // Vite that the build then needs.
    expect(calls.find((call) => call.startsWith('npm install'))).toContain('--include=dev');
  });

  it('says nothing needs restarting when the commit did not move', async () => {
    const { updater: subject } = updater([
      ...script,
      { match: 'git rev-parse HEAD', stdout: 'a'.repeat(40) },
    ]);
    await subject.start();
    await subject.settled();

    const { run } = await subject.status();
    expect(run?.phase).toBe('succeeded');
    expect(run?.restartRequired).toBe(false);
  });

  it('streams what the commands printed, in order, with a cursor to poll on', async () => {
    const { updater: subject } = updater(script);
    await subject.start();
    await subject.settled();

    const full = await subject.status();
    expect(full.log.map((line) => line.text)).toContain('added 3 packages');
    expect(full.cursor).toBe(full.log[full.log.length - 1]?.seq);

    // Asking again from the end returns nothing, which is what makes polling
    // once a second through a ten-minute install reasonable.
    const nothingNew = await subject.status(full.cursor);
    expect(nothingNew.log).toEqual([]);
  });
});

describe('a run that fails', () => {
  const upToInstall: Scripted[] = [
    ...healthyCheckout(),
    { match: 'git fetch', stdout: '' },
    { match: 'git reset', stdout: '' },
  ];

  it('puts the checkout back when the build fails', async () => {
    const { updater: subject, calls } = updater([
      ...upToInstall,
      { match: 'npm install', stdout: '' },
      // Once: the rollback builds the old commit afterwards, and that works.
      { match: 'npm run build', code: 1, once: true, lines: ['error TS2339: it does not compile'] },
      { match: 'npm run build', stdout: '' },
      { match: 'git rev-list', stdout: '0\t0' },
    ]);

    await subject.start();
    await subject.settled();

    const { run } = await subject.status();
    expect(run?.phase).toBe('failed');
    expect(run?.error).toContain('did not build');
    expect(run?.steps.find((step) => step.name === 'build')?.status).toBe('failed');

    const rollback = run?.steps.find((step) => step.name === 'rollback');
    expect(rollback?.status).toBe('done');
    // Back to exactly the commit it started from.
    expect(run?.to).toBe(run?.from);
    expect(calls).toContain(`git reset --hard ${run?.from}`);

    /*
     * And nothing to restart into.
     *
     * The rollback leaves precisely the code that is already running, so
     * offering "restart to finish installing" here would restart into nothing
     * new at best — and after a rollback that itself failed, into a tree
     * halfway between two versions.
     */
    expect(run?.restartRequired).toBe(false);
  });

  it('does not roll back when nothing was moved yet', async () => {
    const { updater: subject, calls } = updater([
      ...healthyCheckout(),
      { match: 'git fetch', code: 128, failure: 'Could not resolve host: github.com' },
    ]);

    await subject.start();
    await subject.settled();

    const { run } = await subject.status();
    expect(run?.phase).toBe('failed');
    expect(run?.steps.find((step) => step.name === 'rollback')).toBeUndefined();
    expect(calls.some((call) => call.startsWith('git reset'))).toBe(false);
    // The steps that never ran say so rather than sitting at "waiting" forever.
    expect(run?.steps.find((step) => step.name === 'build')?.status).toBe('skipped');
  });

  it('admits it when the rollback fails too, rather than reporting a tidy failure', async () => {
    const { updater: subject } = updater([
      ...upToInstall,
      { match: 'npm install', code: 1 },
      { match: 'git reset --hard a', code: 128 },
      { match: 'git rev-list', stdout: '0\t0' },
    ]);

    await subject.start();
    await subject.settled();

    const { run, log } = await subject.status();
    expect(run?.phase).toBe('failed');
    expect(run?.steps.find((step) => step.name === 'rollback')?.status).toBe('failed');
    expect(log.map((line) => line.text).join(' ')).toContain('part-way between two versions');
    expect(run?.restartRequired).toBe(false);
  });

  it('shows the command that failed, spelled out for running by hand', async () => {
    const { updater: subject } = updater([
      ...upToInstall,
      { match: 'npm install', code: 1 },
      { match: 'git rev-list', stdout: '0\t0' },
    ]);

    await subject.start();
    await subject.settled();

    const { run } = await subject.status();
    const install = run?.steps.find((step) => step.name === 'install');
    expect(install?.command).toContain('install --include=dev');
    expect(install?.exitCode).toBe(1);
  });
});

describe('what would start it again', () => {
  it('recognises the three supervisors, in the order they take precedence', () => {
    // pm2 first: inside a container it is still what restarts the process.
    expect(detectSupervisor({ pm_id: '0', INVOCATION_ID: 'x' }, () => true).kind).toBe('pm2');
    expect(detectSupervisor({ INVOCATION_ID: 'x' }, () => true).kind).toBe('systemd');
    expect(detectSupervisor({}, () => true).kind).toBe('docker');
  });

  it('refuses to promise a restart it cannot see a reason to expect', () => {
    const bare = detectSupervisor({}, () => false);
    expect(bare.kind).toBe('unknown');
    expect(bare.restarts).toBe(false);
    // Said plainly, because this is the case where the button stops Latent.
    expect(bare.note).toContain('Restart it yourself');
  });
});
