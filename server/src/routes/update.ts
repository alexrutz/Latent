import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { AppContext } from './context.js';

/**
 * Installing a new version of Latent onto the machine running it.
 *
 * The work is in `server/src/update.ts`; these are the doors onto it. Two
 * things shape them.
 *
 * **Reading is separate from doing.** `GET /api/update` needs nothing but the
 * session, because "which commit is this and is a newer one waiting" is not a
 * secret from somebody who is already signed in, and the screen has to be able
 * to render before there is anything to ask a password for. Everything that
 * changes the machine needs the password again on top of the session.
 *
 * **Nothing is held open.** An install takes minutes and a phone will not hold
 * a request that long, so `run` starts the work and returns at once; progress
 * is read back by polling `GET /api/update` with a cursor. That also survives
 * the part where `npm run build` deletes `web/dist` out from under the page
 * that is watching.
 */

/** The header this screen's pass travels in. Not a cookie: it must not last. */
const TICKET_HEADER = 'x-latent-update';

export interface UpdateRouteOptions {
  /**
   * Replace the running process. Injected so a test can reach the route.
   *
   * `app.close` first, not a bare exit: the onClose hooks stop the orchestrator
   * and close the database, and a SQLite file abandoned mid-write is a worse
   * outcome than any update failure this is trying to recover from.
   */
  restart?: () => Promise<void>;
}

export function registerUpdateRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  options: UpdateRouteOptions = {},
): void {
  const restart =
    options.restart ??
    (async () => {
      app.log.warn('Restarting to run the update that was just installed.');
      await app.close();
      process.exit(0);
    });

  /**
   * Everything below this needs the password, not just the session.
   *
   * 403 with a marker rather than 401, so the screen knows to ask for the
   * password rather than to conclude the session has expired and throw somebody
   * back to a sign-in they do not need.
   */
  const barred = (request: FastifyRequest, reply: FastifyReply): boolean => {
    if (ctx.updateGate.check(request.headers[TICKET_HEADER])) return false;
    void reply
      .code(403)
      .send({ error: 'Enter your password to install an update', needsPassword: true });
    return true;
  };

  /**
   * What is installed, what is waiting, and how the last attempt went.
   *
   * `since` is a cursor over the log. A client polls with the `cursor` it was
   * last given and is told only what has happened since — which is what makes
   * polling once a second from a phone during a ten-minute install reasonable.
   */
  app.get<{ Querystring: { since?: string } }>('/api/update', async (request) => {
    const since = Number(request.query.since);
    return ctx.updater.status(Number.isFinite(since) && since > 0 ? since : 0);
  });

  /**
   * Ask the remote what it has.
   *
   * Behind the session but not behind the password: this only reads, and the
   * point of it is to be able to say "there is an update waiting" to somebody
   * who has not decided to install anything yet.
   */
  app.post('/api/update/check', async () => ctx.updater.check());

  /**
   * Buy a pass with the app password.
   *
   * Rate-limited on the same counter the login uses, per address. This is a
   * second door onto the same password, and an uncounted one would simply be
   * the cheaper door to hammer.
   */
  app.post<{ Body: { password?: string } }>('/api/update/unlock', async (request, reply) => {
    if (!ctx.auth.registerLoginAttempt(request.ip)) {
      return reply.code(429).send({ error: 'Too many attempts. Wait a minute and try again.' });
    }
    if (!ctx.auth.checkPassword(request.body?.password)) {
      return reply.code(401).send({ error: 'That is not the password.' });
    }
    ctx.auth.clearLoginAttempts(request.ip);
    return { ticket: ctx.updateGate.issue(), status: await ctx.updater.status() };
  });

  /** Hand the pass back, which is what closing the screen does. */
  app.post('/api/update/lock', async (request, reply) => {
    ctx.updateGate.revoke(request.headers[TICKET_HEADER]);
    return reply.code(204).send();
  });

  /**
   * Start one.
   *
   * Answers with the run as it stands a moment after starting — the steps it
   * intends to take, none of them finished — so the screen has something to
   * draw immediately instead of an empty box until the first line of output.
   */
  app.post('/api/update/run', async (request, reply) => {
    if (barred(request, reply)) return reply;

    const started = await ctx.updater.start();
    if (!started.ok) return reply.code(409).send({ error: started.error });
    return { run: started.run, status: await ctx.updater.status() };
  });

  /**
   * Replace the running process so the installed version is the one running.
   *
   * Refused unless something was actually installed, and refused on a machine
   * where nothing would start Latent again — on which this button is a stop
   * button, and the phone that pressed it is the worst place to learn that.
   * `force` is there because the detection can only ever be a guess, and being
   * unable to overrule it would be the more annoying failure.
   */
  app.post<{ Body: { force?: boolean } }>('/api/update/restart', async (request, reply) => {
    if (barred(request, reply)) return reply;

    const status = await ctx.updater.status();
    if (!status.run?.restartRequired) {
      return reply.code(409).send({
        error: 'Nothing has been installed that a restart would pick up.',
      });
    }
    if (!status.supervisor.restarts && request.body?.force !== true) {
      return reply.code(409).send({ error: status.supervisor.note, needsForce: true });
    }

    // Answer first. The process is about to go away, and a client left holding
    // a dead socket cannot tell "restarting" from "crashed".
    void reply.send({ ok: true });
    setTimeout(() => void restart(), 250);
    return reply;
  });
}
