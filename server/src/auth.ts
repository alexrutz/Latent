import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

export const SESSION_COOKIE = 'latent_session';
const SESSION_MAX_AGE_S = 60 * 60 * 24 * 30; // 30 days — this is a home server.

/**
 * Single shared password, deliberately.
 *
 * There are no user accounts to manage: this guards one person's (or one
 * household's) ComfyUI box. The session cookie is an HMAC derived from the
 * password itself, so it is stateless and changing `LATENT_PASSWORD`
 * automatically invalidates every existing session.
 */
export class Auth {
  readonly required: boolean;
  private readonly token: string;

  constructor(private readonly password: string | null) {
    this.required = password !== null;
    this.token = password
      ? createHmac('sha256', password).update('latent-session-v1').digest('base64url')
      : '';
  }

  /** Constant-time check so the cookie can't be brute-forced byte by byte. */
  private matches(candidate: string, expected: string): boolean {
    const a = Buffer.from(candidate);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  checkPassword(candidate: unknown): boolean {
    if (!this.required) return true;
    if (typeof candidate !== 'string' || this.password === null) return false;
    return this.matches(candidate, this.password);
  }

  isAuthenticated(request: FastifyRequest): boolean {
    if (!this.required) return true;
    const cookie = request.cookies[SESSION_COOKIE];
    return typeof cookie === 'string' && this.matches(cookie, this.token);
  }

  setSession(reply: FastifyReply): void {
    reply.setCookie(SESSION_COOKIE, this.token, {
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

  /** Fastify hook: reject unauthenticated API calls. */
  guard = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (this.isAuthenticated(request)) return;
    await reply.code(401).send({ error: 'Authentication required' });
  };
}
