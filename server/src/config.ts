import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
/** Repo root, whether running from `src` (tsx) or `dist` (built). */
export const projectRoot = resolve(here, '../..');

function env(name: string, fallback: string): string {
  const value = process.env[name];
  return value !== undefined && value !== '' ? value : fallback;
}

function num(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Strip any trailing slash so we can concatenate paths safely. */
function normaliseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

export interface Config {
  port: number;
  host: string;
  /** Seeds the first connection preset on a fresh install. */
  comfyUrl: string;
  /**
   * Fixes the password from the environment, skipping the first-run claim.
   * When unset, the first person to reach the server chooses it.
   */
  password: string | null;
  dataDir: string;
  dbPath: string;
  /**
   * Where the portable settings files live. A directory above the project by
   * default, so deleting the project for a clean start keeps the arrangement.
   */
  stateDir: string;
  /** Where rated images are copied so they outlive the ComfyUI that made them. */
  archiveDir: string;
  /** Directory of the built web app, served as the SPA. */
  webDir: string;
  /**
   * Whether the shell route exists at all. Off unless explicitly enabled —
   * an authenticated web terminal is still remote code execution.
   */
  terminalEnabled: boolean;
  logLevel: string;
}

function flag(name: string, fallback = false): boolean {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

export function loadConfig(): Config {
  /*
   * Outside the project by default.
   *
   * The database holds the gallery, the ratings and the encrypted archive —
   * everything you would be most upset to lose — and it used to live in
   * `./data`, inside the directory you delete when you want a clean reinstall.
   * A sibling directory keeps it, alongside the settings files, and an explicit
   * `LATENT_DATA_DIR` still wins for anyone who wants it somewhere specific.
   */
  const dataDir = resolve(projectRoot, env('LATENT_DATA_DIR', '../latent-data'));
  mkdirSync(dataDir, { recursive: true });
  if (process.env.LATENT_DATA_DIR === undefined) adoptLegacyDataDir(dataDir);

  const password = process.env.LATENT_PASSWORD?.trim();

  return {
    port: num('PORT', 5173 + 1000),
    host: env('HOST', '0.0.0.0'),
    comfyUrl: normaliseUrl(env('COMFY_URL', 'http://127.0.0.1:8188')),
    password: password ? password : null,
    dataDir,
    dbPath: resolve(dataDir, 'latent.db'),
    stateDir: resolve(projectRoot, env('LATENT_STATE_DIR', '..')),
    archiveDir: resolve(dataDir, 'archive'),
    webDir: resolve(projectRoot, 'web/dist'),
    terminalEnabled: flag('LATENT_TERMINAL'),
    logLevel: env('LOG_LEVEL', 'info'),
  };
}

/**
 * Move an existing `./data` up next to the project.
 *
 * Installs made before the move keep their gallery, ratings and archive without
 * anybody having to know the directory changed. Only ever runs when the new
 * location is empty, so it cannot overwrite a database that is already there,
 * and only when the location was not chosen explicitly.
 */
function adoptLegacyDataDir(dataDir: string): void {
  const legacy = resolve(projectRoot, 'data');
  if (legacy === dataDir) return;
  if (!existsSync(join(legacy, 'latent.db')) || existsSync(join(dataDir, 'latent.db'))) return;

  for (const entry of readdirSync(legacy)) {
    const from = join(legacy, entry);
    const to = join(dataDir, entry);
    if (existsSync(to)) continue;
    try {
      renameSync(from, to);
    } catch {
      // A different filesystem (a bind-mounted volume, say): copy instead.
      cpSync(from, to, { recursive: true });
      rmSync(from, { recursive: true, force: true });
    }
  }
}

/** `http://host:8188` -> `ws://host:8188`, preserving TLS. */
export function toWebSocketUrl(httpUrl: string): string {
  return httpUrl.replace(/^http/, 'ws');
}
