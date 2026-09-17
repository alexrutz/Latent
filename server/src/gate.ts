import { randomBytes } from 'node:crypto';

/**
 * A short-lived pass, bought by re-entering the app password.
 *
 * For the few places where being signed in is not enough. Sessions here are
 * stateless — an HMAC of the stored password hash, with no server-side table to
 * hang a flag on — so "did they type it again" cannot live on the session, and
 * a client-side version of the same question is a lock that `curl` walks past.
 * A ticket is the smallest thing that survives that: minted only after the
 * password has been checked, sent back on the requests it covers, and held in
 * memory only, so a restart or a sign-out ends every one of them.
 *
 * Each guarded thing holds its own book of these. Closing the notes should not
 * end an update that is halfway through installing, and finishing an update
 * should not quietly leave the notes open.
 */
export class PasswordGate {
  private readonly tickets = new Map<string, number>();

  constructor(
    /** How long a pass lasts. Long enough to finish, short enough to forget. */
    private readonly lifetimeMs = 15 * 60 * 1000,
  ) {}

  /** Mint one. The caller has just proved it knows the password. */
  issue(now = Date.now()): string {
    this.sweep(now);
    const ticket = randomBytes(24).toString('base64url');
    this.tickets.set(ticket, now + this.lifetimeMs);
    return ticket;
  }

  /**
   * Whether this pass is still good — and if so, extend it.
   *
   * Sliding rather than fixed: the expiry is there so a pass does not outlive
   * the sitting it was bought for, and being asked for the password again in
   * the middle of writing a list is the kind of security that gets switched
   * off.
   */
  check(ticket: unknown, now = Date.now()): boolean {
    if (typeof ticket !== 'string' || ticket === '') return false;
    const expires = this.tickets.get(ticket);
    if (expires === undefined) return false;
    if (expires <= now) {
      this.tickets.delete(ticket);
      return false;
    }
    this.tickets.set(ticket, now + this.lifetimeMs);
    return true;
  }

  /** Hand one back, when the screen it was for is closed. */
  revoke(ticket: unknown): void {
    if (typeof ticket === 'string') this.tickets.delete(ticket);
  }

  /** Every pass at once: signing out ends all of them. */
  revokeAll(): void {
    this.tickets.clear();
  }

  private sweep(now: number): void {
    for (const [ticket, expires] of this.tickets) {
      if (expires <= now) this.tickets.delete(ticket);
    }
  }
}
