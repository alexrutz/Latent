import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { blankConfig, definitionFor, type ServiceConfig } from '@latent/shared';

import { Store } from './db.js';
import { isUp, Supervisor } from './supervisor.js';

/**
 * The manager, driven against a real process.
 *
 * Deliberately not a mock of `child_process`. Almost everything this module
 * gets wrong is in its dealings with an actual process — output arriving in
 * chunks that cut lines in half, an exit that races a stop, a program that
 * cannot be executed at all — and a fake that returns whatever the test says
 * would agree with the code about every one of them.
 *
 * ComfyUI's `system` launcher is `python3 main.py`, so a folder with a
 * `main.py` in it is a service this can genuinely start. What that script does
 * is the only thing standing in for ComfyUI.
 */

const comfy = definitionFor('comfyui')!;

const dirs: string[] = [];

/** A root with a `main.py` in it that does whatever the test needs. */
function root(script: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'latent-svc-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'main.py'), script);
  return dir;
}

function store(): Store {
  const dir = mkdtempSync(join(tmpdir(), 'latent-svc-db-'));
  dirs.push(dir);
  return new Store(join(dir, 'test.db'));
}

const quiet = { info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {} };

function service(over: Partial<ServiceConfig> = {}): ServiceConfig {
  return {
    ...blankConfig(comfy, 'svc', Date.now()),
    // Chosen by hand: `python3` is on the PATH rather than under the root, and
    // the automatic search is about files that are.
    launcher: 'system',
    ...over,
  };
}

/** Wait for a condition, or give up. Processes do not settle synchronously. */
async function until(predicate: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((done) => setTimeout(done, 25));
  }
  throw new Error('Timed out waiting for the process to settle');
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('starting and stopping', () => {
  it('runs the command, reports a pid, and keeps its output', async () => {
    const db = store();
    const config = service({
      root: root('import time\nprint("ready", flush=True)\ntime.sleep(30)\n'),
    });
    db.insertService(config);
    const subject = new Supervisor(db, quiet as never);

    expect(subject.start(config)).toBeNull();
    expect(subject.statusOf(config).state).toBe('running');
    expect(subject.statusOf(config).pid).toBeGreaterThan(0);

    await until(() =>
      subject.logSince(config.id, 0).lines.some((line) => line.text.includes('ready')),
    );

    const captured = subject.logSince(config.id, 0).lines;
    expect(captured[0]?.stream).toBe('latent');
    expect(captured[0]?.text).toContain('main.py');
    expect(captured.some((line) => line.stream === 'stdout' && line.text === 'ready')).toBe(true);

    subject.stop(config.id);
    await until(() => !isUp(subject.statusOf(config).state));
    expect(subject.statusOf(config).state).toBe('stopped');
    expect(subject.statusOf(config).pid).toBeNull();
  });

  it('does nothing when asked to start something already up', async () => {
    const db = store();
    const config = service({ root: root('import time\ntime.sleep(30)\n') });
    db.insertService(config);
    const subject = new Supervisor(db, quiet as never);

    subject.start(config);
    const first = subject.statusOf(config).pid;
    expect(subject.start(config)).toBeNull();
    expect(subject.statusOf(config).pid).toBe(first);

    subject.stop(config.id);
    await until(() => !isUp(subject.statusOf(config).state));
  });

  it('hands back only what the caller has not seen', async () => {
    const db = store();
    const config = service({
      root: root('import time\nprint("one", flush=True)\ntime.sleep(30)\n'),
    });
    db.insertService(config);
    const subject = new Supervisor(db, quiet as never);
    subject.start(config);

    await until(() =>
      subject.logSince(config.id, 0).lines.some((line) => line.text === 'one'),
    );
    const { seq } = subject.logSince(config.id, 0);
    expect(subject.logSince(config.id, seq).lines).toEqual([]);

    subject.stop(config.id);
    await until(() => !isUp(subject.statusOf(config).state));
  });
});

describe('when it will not start', () => {
  it('says so rather than throwing, when there is no root', () => {
    const db = store();
    const config = service({ root: '' });
    db.insertService(config);
    const subject = new Supervisor(db, quiet as never);

    expect(subject.start(config)).toMatch(/root directory/i);
    expect(subject.statusOf(config).state).toBe('stopped');
  });

  it('names what it looked for when the root holds none of it', () => {
    const db = store();
    const dir = mkdtempSync(join(tmpdir(), 'latent-empty-'));
    dirs.push(dir);
    const config = service({ root: dir, launcher: null });
    db.insertService(config);
    const subject = new Supervisor(db, quiet as never);

    const failure = subject.start(config);
    expect(failure).toContain('python_embeded/python.exe');
    expect(subject.statusOf(config).error).toContain('python_embeded/python.exe');
  });

  it('shows the command it would run before anything has been started', () => {
    const db = store();
    const config = service({
      root: root('pass\n'),
      values: { '--listen': '0.0.0.0', '--port': 8189 },
    });
    db.insertService(config);
    const subject = new Supervisor(db, quiet as never);

    expect(subject.statusOf(config).command).toBe(
      'python3 main.py --listen 0.0.0.0 --port 8189',
    );
    expect(subject.statusOf(config).state).toBe('stopped');
  });
});

describe('when it exits by itself', () => {
  it('records the exit, and gives up when it was told not to restart', async () => {
    const db = store();
    const config = service({
      root: root('import sys\nprint("bad flag", file=sys.stderr, flush=True)\nsys.exit(3)\n'),
      autoRestart: false,
    });
    db.insertService(config);
    const subject = new Supervisor(db, quiet as never);

    subject.start(config);
    await until(() => subject.statusOf(config).state === 'failed');

    const status = subject.statusOf(config);
    expect(status.exitCode).toBe(3);
    expect(status.restarts).toBe(0);
    expect(status.stoppedAt).toBeGreaterThan(0);

    const lines = subject.logSince(config.id, 0).lines;
    expect(lines.some((line) => line.stream === 'stderr' && line.text === 'bad flag')).toBe(true);
    expect(lines.some((line) => line.text.includes('Exited with code 3'))).toBe(true);
  });

  it('schedules a restart when it was told to, and counts it', async () => {
    const db = store();
    const config = service({ root: root('import sys\nsys.exit(1)\n'), autoRestart: true });
    db.insertService(config);
    const subject = new Supervisor(db, quiet as never);

    subject.start(config);
    await until(() => subject.statusOf(config).restarts > 0);

    const status = subject.statusOf(config);
    expect(status.restartAt).toBeGreaterThan(Date.now());
    expect(
      subject.logSince(config.id, 0).lines.some((line) => line.text.includes('Restarting in')),
    ).toBe(true);

    // Stopping must cancel the pending restart, or a service put away by hand
    // comes back a few seconds later on its own.
    subject.stop(config.id);
    expect(subject.statusOf(config).restartAt).toBeNull();
  });

  it('does not treat a deliberate stop as a crash', async () => {
    const db = store();
    const config = service({ root: root('import time\ntime.sleep(30)\n'), autoRestart: true });
    db.insertService(config);
    const subject = new Supervisor(db, quiet as never);

    subject.start(config);
    subject.stop(config.id);
    await until(() => !isUp(subject.statusOf(config).state));

    expect(subject.statusOf(config).state).toBe('stopped');
    expect(subject.statusOf(config).restarts).toBe(0);
    expect(subject.statusOf(config).restartAt).toBeNull();
  });
});

describe('forgetting', () => {
  it('drops everything it knew, so a reused id starts clean', async () => {
    const db = store();
    const config = service({ root: root('import time\ntime.sleep(30)\n') });
    db.insertService(config);
    const subject = new Supervisor(db, quiet as never);

    subject.start(config);
    subject.stop(config.id);
    await until(() => !isUp(subject.statusOf(config).state));

    subject.forget(config.id);
    expect(subject.logSince(config.id, 0).lines).toEqual([]);
    expect(subject.statusOf(config).state).toBe('stopped');
  });
});
