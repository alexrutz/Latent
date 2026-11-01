import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { afterExit, RESTART_EXIT_CODE } from './launcher.mjs';

describe('what the launcher does when Latent exits', () => {
  it('starts it again at once when it asks to be', () => {
    expect(
      afterExit({ code: RESTART_EXIT_CODE, stopping: false, ranMs: 5, crashes: 3 }),
    ).toMatchObject({
      action: 'restart',
      delayMs: 0,
      crashes: 0,
    });
  });

  it('stops with it when it stopped on purpose, or was asked to', () => {
    expect(afterExit({ code: 0, stopping: false, ranMs: 5, crashes: 0 }).action).toBe('stop');
    expect(afterExit({ code: 1, stopping: true, ranMs: 5, crashes: 0 }).action).toBe('stop');
  });

  it('restarts after a crash, waiting longer each time it crashes again at once', () => {
    let crashes = 0;
    const delays = [];
    for (let i = 0; i < 7; i += 1) {
      const next = afterExit({ code: 1, stopping: false, ranMs: 500, crashes });
      expect(next.action).toBe('restart');
      delays.push(next.delayMs);
      crashes = next.crashes;
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    // A run that lasted a while starts the count again.
    expect(afterExit({ code: 1, stopping: false, ranMs: 120_000, crashes: 6 }).delayMs).toBe(1000);
    // Killed outright counts as a crash.
    expect(afterExit({ code: null, stopping: false, ranMs: 500, crashes: 0 }).action).toBe(
      'restart',
    );
  });
});

describe('the launcher, running', () => {
  it('starts Latent again when it exits asking for a restart, and stops when it stops', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'latent-launcher-'));
    try {
      // A stand-in for Latent: asks to be restarted the first time, stops the second.
      const counter = join(dir, 'runs');
      const fake = join(dir, 'fake-latent.mjs');
      writeFileSync(
        fake,
        `import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const file = ${JSON.stringify(counter)};
const runs = existsSync(file) ? Number(readFileSync(file, 'utf8')) + 1 : 1;
writeFileSync(file, String(runs));
console.log('run ' + runs + ' launcher=' + process.env.LATENT_LAUNCHER);
process.exit(runs === 1 ? ${RESTART_EXIT_CODE} : 0);
`,
      );
      const launcher = fileURLToPath(new URL('./launcher.mjs', import.meta.url));
      const output = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [launcher], {
          env: { ...process.env, LATENT_LAUNCHER_ENTRY: fake },
        });
        let text = '';
        child.stdout.on('data', (chunk) => (text += chunk));
        child.stderr.on('data', (chunk) => (text += chunk));
        child.on('error', reject);
        child.on('exit', (code) => resolve({ code, text }));
      });
      expect(output.code).toBe(0);
      expect(output.text).toContain('run 1 launcher=1');
      expect(output.text).toContain('asked to be restarted');
      expect(output.text).toContain('run 2 launcher=1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
