import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
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
  comfyUrl: string;
  /** Optional shared password. When unset the app is open. */
  password: string | null;
  dataDir: string;
  dbPath: string;
  /** Directory of the built web app, served as the SPA. */
  webDir: string;
  logLevel: string;
}

export function loadConfig(): Config {
  const dataDir = resolve(projectRoot, env('LATENT_DATA_DIR', 'data'));
  mkdirSync(dataDir, { recursive: true });

  const password = process.env.LATENT_PASSWORD?.trim();

  return {
    port: num('PORT', 5173 + 1000),
    host: env('HOST', '0.0.0.0'),
    comfyUrl: normaliseUrl(env('COMFY_URL', 'http://127.0.0.1:8188')),
    password: password ? password : null,
    dataDir,
    dbPath: resolve(dataDir, 'latent.db'),
    webDir: resolve(projectRoot, 'web/dist'),
    logLevel: env('LOG_LEVEL', 'info'),
  };
}

/** `http://host:8188` -> `ws://host:8188`, preserving TLS. */
export function toWebSocketUrl(httpUrl: string): string {
  return httpUrl.replace(/^http/, 'ws');
}
