import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { customNodesDir, MANAGED_MARKER, syncComfyllama } from './comfyllamaSync.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'latent-sync-'));
  dirs.push(dir);
  return dir;
}

function put(root: string, files: Record<string, string>): string {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** A stand-in for Latent's comfyllama, with the parts that must not be copied. */
function source(): string {
  return put(join(temp(), 'comfyllama'), {
    '__init__.py': 'v1',
    'comfyllama/nodes/refpicker.py': 'picker v1',
    'web/js/comfyllama.js': 'js v1',
    'requirements.txt': 'av\n',
    'tests/test_nodes.py': 'not for ComfyUI',
    'comfyllama/__pycache__/x.cpython-312.pyc': 'cache',
  });
}

function comfy(): { root: string; nodes: string } {
  const root = temp();
  mkdirSync(join(root, 'custom_nodes'));
  return { root, nodes: join(root, 'custom_nodes') };
}

const read = (path: string) => readFileSync(path, 'utf8');

describe('finding custom_nodes', () => {
  it('uses the ComfyUI folder from Settings, else the service root, portable layout included', () => {
    const { root, nodes } = comfy();
    expect(customNodesDir(root, '/elsewhere')).toBe(nodes);
    const portable = temp();
    mkdirSync(join(portable, 'ComfyUI', 'custom_nodes'), { recursive: true });
    expect(customNodesDir(null, portable)).toBe(join(portable, 'ComfyUI', 'custom_nodes'));
    expect(customNodesDir(null, root)).toBe(nodes);
    expect(customNodesDir(null, temp())).toBeNull();
  });
});

describe('keeping ComfyUI’s comfyllama the same as Latent’s', () => {
  it('installs it, without the tests or the caches', () => {
    const from = source();
    const { nodes } = comfy();
    const result = syncComfyllama(from, nodes);
    const target = join(nodes, 'comfyllama');
    expect(result.action).toBe('installed');
    expect(read(join(target, 'comfyllama/nodes/refpicker.py'))).toBe('picker v1');
    expect(read(join(target, 'web/js/comfyllama.js'))).toBe('js v1');
    expect(existsSync(join(target, 'tests'))).toBe(false);
    expect(existsSync(join(target, 'comfyllama/__pycache__'))).toBe(false);
    expect(existsSync(join(target, MANAGED_MARKER))).toBe(true);
  });

  it('changes only what changed, and removes what Latent no longer has', () => {
    const from = source();
    const { nodes } = comfy();
    syncComfyllama(from, nodes);
    expect(syncComfyllama(from, nodes)).toMatchObject({ action: 'unchanged', changed: [] });

    put(from, { 'comfyllama/nodes/refpicker.py': 'picker v2', 'comfyllama/nodes/new.py': 'new' });
    rmSync(join(from, 'web/js/comfyllama.js'));
    const result = syncComfyllama(from, nodes);
    const target = join(nodes, 'comfyllama');
    expect(result.action).toBe('updated');
    expect(read(join(target, 'comfyllama/nodes/refpicker.py'))).toBe('picker v2');
    expect(read(join(target, 'comfyllama/nodes/new.py'))).toBe('new');
    expect(existsSync(join(target, 'web/js/comfyllama.js'))).toBe(false);
    // An emptied folder goes with its last file.
    expect(existsSync(join(target, 'web/js'))).toBe(false);
    // Python's own caches are left to Python.
    put(target, { 'comfyllama/__pycache__/y.pyc': 'cache' });
    syncComfyllama(from, nodes);
    expect(existsSync(join(target, 'comfyllama/__pycache__/y.pyc'))).toBe(true);
  });

  it('says when the requirements changed, and how to install them', () => {
    const from = source();
    const { nodes } = comfy();
    syncComfyllama(from, nodes);
    put(from, { 'requirements.txt': 'av\npillow\n' });
    expect(syncComfyllama(from, nodes).message).toMatch(/pip install -r .*requirements\.txt/);
  });

  it('takes over a copy put there by hand without deleting anything the first time', () => {
    const from = source();
    const { nodes } = comfy();
    put(join(nodes, 'comfyllama'), { '__init__.py': 'old', 'my-notes.txt': 'mine' });
    expect(syncComfyllama(from, nodes).action).toBe('updated');
    expect(read(join(nodes, 'comfyllama/__init__.py'))).toBe('v1');
    expect(read(join(nodes, 'comfyllama/my-notes.txt'))).toBe('mine');
  });

  it('leaves a git checkout of its own alone, and says so', () => {
    const from = source();
    const { nodes } = comfy();
    put(join(nodes, 'comfyllama'), {
      '.git/HEAD': 'ref: refs/heads/main',
      '__init__.py': 'theirs',
    });
    const result = syncComfyllama(from, nodes);
    expect(result.action).toBe('skipped');
    expect(result.message).toContain('git');
    expect(read(join(nodes, 'comfyllama/__init__.py'))).toBe('theirs');
  });

  it('leaves a link to Latent’s own copy alone', () => {
    const from = source();
    const { nodes } = comfy();
    symlinkSync(from, join(nodes, 'comfyllama'), 'dir');
    expect(syncComfyllama(from, nodes)).toMatchObject({ action: 'skipped', changed: [] });
    expect(read(join(from, '__init__.py'))).toBe('v1');
  });

  it('does nothing without a custom_nodes folder, pointing at the setting', () => {
    const result = syncComfyllama(source(), null);
    expect(result.action).toBe('skipped');
    expect(result.message).toContain('ComfyUI folder');
  });
});
