import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

import type { Store } from './db.js';

export const SESSION_COOKIE = 'latent_session';
const SESSION_MAX_AGE_S = 60 * 60 * 24 * 30; // 30 days — this is a home server.
const PASSWORD_SETTING = 'password_hash';

const SCRYPT_KEYLEN = 32;
const MIN_PASSWORD_LENGTH = 6;

/** Fixed-window limiter on login attempts, per client address. */
const LOGIN_WINDOW_MS = 60_000;
const LOGIN_MAX_ATTEMPTS = 10;

/**
 * A single shared password, claimed on first use.
 *
 * There are no user accounts: this guards one person's GPU. The password is
 * stored as a scrypt hash, and the session cookie is an HMAC over that hash — so
 * it needs no server-side session table, and changing the password invalidates
 * every existing session automatically.
 *
 * When `LATENT_PASSWORD` is set it wins outright, which is how headless and
 * Docker deployments avoid the claim window entirely.
 */
export class Auth {
  /** Always true. Kept explicit because v1 allowed an open server and no longer does. */
  readonly required = true;

  private readonly envPassword: string | null;
  private cachedRecord: string | null = null;
  private cachedToken: string | null = null;
  private readonly attempts = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly store: Store,
    envPassword: string | null,
  ) {
    this.envPassword = envPassword && envPassword.length > 0 ? envPassword : null;
    if (this.envPassword) this.persistEnvPassword();
  }

  /**
   * Mirror an env-supplied password into the store so the claim window never
   * opens, and so both paths share one code path for verification.
   */
  private persistEnvPassword(): void {
    if (!this.envPassword) return;
    const existing = this.store.getSecretSetting(PASSWORD_SETTING);
    if (existing && verifyPassword(this.envPassword, existing)) return;
    this.store.setSecretSetting(PASSWORD_SETTING, hashPassword(this.envPassword));
  }

  private record(): string | null {
    return this.store.getSecretSetting(PASSWORD_SETTING);
  }

  /** No password chosen yet: the app must run its setup flow before anything else. */
  get setupRequired(): boolean {
    return this.record() === null;
  }

  /**
   * The session token for the current password.
   *
   * Derived from the stored hash rather than the password itself, so the raw
   * password is never needed after login.
   */
  private sessionToken(): string | null {
    const record = this.record();
    if (!record) return null;
    if (record !== this.cachedRecord) {
      this.cachedRecord = record;
      this.cachedToken = createHmac('sha256', record).update('latent-session-v2').digest('base64url');
    }
    return this.cachedToken;
  }

  /** Claim the server. Fails if a password already exists — the window is one-shot. */
  setup(password: unknown): { ok: true } | { ok: false; error: string } {
    if (!this.setupRequired) {
      return { ok: false, error: 'A password has already been set on this server.' };
    }
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
      return {
        ok: false,
        error: `Choose a password of at least ${MIN_PASSWORD_LENGTH} characters.`,
      };
    }
    this.store.setSecretSetting(PASSWORD_SETTING, hashPassword(password));
    return { ok: true };
  }

  /** Change the password. Requires the current one, and logs every session out. */
  changePassword(current: unknown, next: unknown): { ok: true } | { ok: false; error: string } {
    if (this.envPassword) {
      return {
        ok: false,
        error: 'The password is fixed by the LATENT_PASSWORD environment variable.',
      };
    }
    if (!this.checkPassword(current)) {
      return { ok: false, error: 'That is not the current password.' };
    }
    if (typeof next !== 'string' || next.length < MIN_PASSWORD_LENGTH) {
      return { ok: false, error: `Choose a password of at least ${MIN_PASSWORD_LENGTH} characters.` };
    }
    this.store.setSecretSetting(PASSWORD_SETTING, hashPassword(next));
    return { ok: true };
  }

  checkPassword(candidate: unknown): boolean {
    const record = this.record();
    if (!record || typeof candidate !== 'string') return false;
    return verifyPassword(candidate, record);
  }

  isAuthenticated(request: FastifyRequest): boolean {
    const expected = this.sessionToken();
    if (!expected) return false; // Unclaimed server: nobody is authenticated.
    const cookie = request.cookies[SESSION_COOKIE];
    return typeof cookie === 'string' && constantTimeEquals(cookie, expected);
  }

  setSession(reply: FastifyReply): void {
    const token = this.sessionToken();
    if (!token) return;
    reply.setCookie(SESSION_COOKIE, token, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      // Not `secure`: this is typically served over plain HTTP on a LAN, and a
      // secure cookie would silently never be stored.
      maxAge: SESSION_MAX_AGE_S,
    });
  }

  clearSession(reply: FastifyReply): void {
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
  }

  /**
   * Rate-limit login attempts so a weak password can't be walked through over a
   * LAN. Returns false when the caller should be turned away without a check.
   */
  registerLoginAttempt(clientKey: string): boolean {
    const now = Date.now();
    const entry = this.attempts.get(clientKey);

    if (!entry || now > entry.resetAt) {
      this.attempts.set(clientKey, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
      return true;
    }
    entry.count += 1;
    return entry.count <= LOGIN_MAX_ATTEMPTS;
  }

  clearLoginAttempts(clientKey: string): void {
    this.attempts.delete(clientKey);
  }

  /** Fastify hook: reject unauthenticated API calls. */
  guard = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (this.isAuthenticated(request)) return;
    if (this.setupRequired) {
      await reply.code(401).send({ error: 'This server has not been set up yet.' });
      return;
    }
    await reply.code(401).send({ error: 'Authentication required' });
  };
}

/* ------------------------------------------------------------------ */
/* Password hashing                                                    */
/* ------------------------------------------------------------------ */

/** Stored as `scrypt$<salt-hex>$<hash-hex>` so the format can evolve later. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(candidate: string, record: string): boolean {
  const [scheme, saltHex, hashHex] = record.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;

  try {
    const expected = Buffer.from(hashHex, 'hex');
    const actual = scryptSync(candidate, Buffer.from(saltHex, 'hex'), expected.length);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
