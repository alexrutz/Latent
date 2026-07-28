import { existsSync } from 'node:fs';
import { join } from 'node:path';

import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';

import { Auth } from './auth.js';
import { loadConfig, toWebSocketUrl, type Config } from './config.js';
import { Store } from './db.js';
import { Orchestrator } from './orchestrator.js';
import type { AppContext } from './routes/context.js';
import { registerGalleryRoutes } from './routes/gallery.js';
import { registerGenerateRoutes } from './routes/generate.js';
import { registerMediaRoutes } from './routes/media.js';
import { registerQueueRoutes } from './routes/queue.js';
import { registerSystemRoutes } from './routes/system.js';
import { registerWorkflowRoutes } from './routes/workflows.js';

/** Routes reachable before logging in. */
const PUBLIC_API_PATHS = new Set(['/api/status', '/api/auth/login', '/api/auth/logout']);

export interface BuiltApp {
  app: FastifyInstance;
  ctx: AppContext;
  config: Config;
}

export async function buildApp(overrides: Partial<Config> = {}): Promise<BuiltApp> {
  const config = { ...loadConfig(), ...overrides };

  const app = Fastify({
    logger: { level: config.logLevel },
    // Phones on a slow link uploading a 40 MB photo need generous timeouts.
    bodyLimit: 96 * 1024 * 1024,
  });

  const store = new Store(config.dbPath);
  const auth = new Auth(config.password);
  const orchestrator = new Orchestrator(
    store,
    config.comfyUrl,
    toWebSocketUrl(config.comfyUrl),
    app.log,
  );

  const ctx: AppContext = { config, store, orchestrator, auth };

  await app.register(fastifyCookie);
  await app.register(fastifyMultipart);
  await app.register(fastifyWebsocket);

  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/')) return;
    const path = request.url.split('?')[0] ?? '';
    if (PUBLIC_API_PATHS.has(path)) return;
    await auth.guard(request, reply);
  });

  registerSystemRoutes(app, ctx);
  registerWorkflowRoutes(app, ctx);
  registerGenerateRoutes(app, ctx);
  registerQueueRoutes(app, ctx);
  registerGalleryRoutes(app, ctx);
  registerMediaRoutes(app, ctx);

  /**
   * The live event stream.
   *
   * Every connected device receives the same events; a `snapshot` is sent
   * immediately on connect so a phone waking from sleep is correct at once,
   * without replaying anything it missed.
   */
  app.get('/api/ws', { websocket: true }, (socket, request) => {
    // The onRequest hook already rejects an unauthenticated upgrade with a 401
    // during the handshake. This is defence in depth: if `/api/ws` were ever
    // added to PUBLIC_API_PATHS, the live stream must still stay private.
    if (!auth.isAuthenticated(request)) {
      socket.close(4401, 'Authentication required');
      return;
    }
    orchestrator.attachClient(socket);
  });

  await registerWebApp(app, config);

  app.addHook('onClose', async () => {
    await orchestrator.stop();
    store.close();
  });

  orchestrator.start();

  return { app, ctx, config };
}

/**
 * Serve the built PWA, falling back to `index.html` for client-side routes.
 * In development Vite serves the app instead and this is skipped.
 */
async function registerWebApp(app: FastifyInstance, config: Config): Promise<void> {
  const indexPath = join(config.webDir, 'index.html');
  if (!existsSync(indexPath)) {
    app.log.warn(
      `No built web app at ${config.webDir} — run "npm run build" (in development, use the Vite dev server).`,
    );
    return;
  }

  await app.register(fastifyStatic, { root: config.webDir, wildcard: false });

  app.setNotFoundHandler((request, reply) => {
    if (request.method !== 'GET' || request.url.startsWith('/api/')) {
      return reply.code(404).send({ error: 'Not found' });
    }
    return reply.sendFile('index.html');
  });
}
