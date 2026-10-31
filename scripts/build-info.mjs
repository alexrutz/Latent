/**
 * Record which commit this build was made from.
 *
 * The running server reads it back, so Settings → Software can tell a
 * checkout that has moved on from the build actually running: `git pull`
 * changes the files, but nothing runs them until `npm run build` and a
 * restart, and the version shown — read from git — said otherwise.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let commit = null;
try {
  commit =
    execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim() || null;
} catch {
  // Not a checkout, or no git: nothing to compare against, and nothing claimed.
}
const target = join(root, 'server', 'dist', 'build-info.json');
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, `${JSON.stringify({ commit, builtAt: Date.now() })}\n`);
console.log(`Build info: ${commit ?? 'no commit'} → ${target}`);
