/**
 * Runs Latent, and starts it again when it asks to be.
 *
 * Latent cannot restart itself: a process that exits is gone, and its Restart
 * button after an update was a Stop button anywhere nothing brought it back —
 * which is every machine where it was simply started from a shell or a
 * shortcut, Windows included. pm2, systemd and Docker restart it; this does the
 * same job for everyone else, with nothing to install.
 *
 * Latent runs as a child process. What happens when it ends depends on how:
 *
 * - **Exit 75** (`RESTART_EXIT_CODE`) is Latent asking to be restarted — the
 *   Restart button after an update. Started again at once.
 * - **Exit 0** is a deliberate stop. The launcher stops too.
 * - **Anything else** is a crash. Started again after a pause that doubles with
 *   each crash in a row (1 s up to 30 s), so a fault on start-up — a port in
 *   use, a broken build — does not spin; a run that lasted a minute resets it.
 * - **Ctrl+C, closing the window, `kill`**: passed on to Latent so it can close
 *   its database cleanly, and the launcher exits with it.
 *
 * `npm start` runs this. `npm run start:direct` runs Latent without it.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** The exit code Latent uses to ask for a restart. EX_TEMPFAIL: "try again". */
export const RESTART_EXIT_CODE = 75;

const FIRST_PAUSE_MS = 1_000;
const LONGEST_PAUSE_MS = 30_000;
/** A run this long was not a start-up fault, whatever ended it. */
const STEADY_MS = 60_000;
/** How long Latent gets to close its database once asked to stop. */
const STOP_GRACE_MS = 10_000;

/**
 * What to do once Latent has exited.
 *
 * @param {{ code: number | null, stopping: boolean, ranMs: number, crashes: number }} ended
 * @returns {{ action: 'stop' | 'restart', delayMs: number, crashes: number, reason: string }}
 */
export function afterExit({ code, stopping, ranMs, crashes }) {
  if (stopping) return { action: 'stop', delayMs: 0, crashes, reason: 'asked to stop' };
  if (code === RESTART_EXIT_CODE) {
    return { action: 'restart', delayMs: 0, crashes: 0, reason: 'Latent asked to be restarted' };
  }
  if (code === 0) return { action: 'stop', delayMs: 0, crashes, reason: 'Latent stopped' };

  const inARow = ranMs >= STEADY_MS ? 1 : crashes + 1;
  const delayMs = Math.min(LONGEST_PAUSE_MS, FIRST_PAUSE_MS * 2 ** (inARow - 1));
  return {
    action: 'restart',
    delayMs,
    crashes: inARow,
    reason: `Latent exited unexpectedly (${code === null ? 'killed' : `code ${code}`})`,
  };
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  // Overridable so a test can stand a small script in for Latent.
  const entry = process.env.LATENT_LAUNCHER_ENTRY ?? join(root, 'server', 'dist', 'index.js');
  const log = (message) => console.log(`[launcher] ${message}`);

  if (!existsSync(entry)) {
    log(`There is no built server at ${entry}. Run "npm install" and "npm run build" first.`);
    process.exit(1);
  }

  let child = null;
  let startedAt = 0;
  let crashes = 0;
  let stopping = false;
  let pending = null;

  const start = () => {
    pending = null;
    startedAt = Date.now();
    child = spawn(process.execPath, [entry, ...process.argv.slice(2)], {
      cwd: join(root, 'server'),
      stdio: 'inherit',
      // How Latent knows a restart will bring it back. See `detectSupervisor`.
      env: { ...process.env, LATENT_LAUNCHER: '1' },
    });
    child.on('error', (error) => log(`Could not start Latent: ${error.message}`));
    child.on('exit', (code, signal) => {
      child = null;
      const next = afterExit({
        code: signal ? null : code,
        stopping,
        ranMs: Date.now() - startedAt,
        crashes,
      });
      crashes = next.crashes;
      if (next.action === 'stop') {
        process.exit(stopping ? 0 : (code ?? 0));
      }
      log(
        next.delayMs > 0
          ? `${next.reason}; starting it again in ${Math.round(next.delayMs / 1000)} s.`
          : `${next.reason}; starting it again.`,
      );
      pending = setTimeout(start, next.delayMs);
    });
  };

  const stop = (signal) => {
    if (stopping) return;
    stopping = true;
    if (pending) clearTimeout(pending);
    if (!child) process.exit(0);
    // Ctrl+C reaches Latent by itself in a console; a `kill` of this process
    // does not, so it is passed on either way — a second one is harmless.
    child.kill(signal);
    setTimeout(() => {
      if (child) {
        log('Latent did not stop in time; ending it.');
        child.kill('SIGKILL');
      }
    }, STOP_GRACE_MS).unref();
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => stop(signal));

  log('Starting Latent. It will be started again whenever it asks to be.');
  start();
}

// Run when started, not when imported by the tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
