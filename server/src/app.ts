import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';

import { Archive } from './archive.js';
import { Auth } from './auth.js';
import { Importer } from './importer.js';
import { InputLibrary } from './inputLibrary.js';
import { Vault } from './vault.js';
import { plainConnection, type ConnectionConfig } from './comfy/connection.js';
import { loadConfig, type Config } from './config.js';
import { Store } from './db.js';
import { Orchestrator } from './orchestrator.js';
import { StateFiles } from './statefile.js';
import { Endless } from './endless.js';
import { StudyRunner } from './study.js';
import { Sweeper } from './sweeper.js';
import { WorkflowScanner } from './workflowScan.js';
import { registerChatRoutes } from './routes/chat.js';
import { registerConnectionRoutes, toConfig } from './routes/connections.js';
import type { AppContext } from './routes/context.js';
import { registerGalleryRoutes } from './routes/gallery.js';
import { registerFavoriteRoutes } from './routes/favorites.js';
import { registerGenerateRoutes } from './routes/generate.js';
import { registerImportRoutes } from './routes/import.js';
import { registerInputImageRoutes } from './routes/inputImages.js';
import { registerLayoutRoutes } from './routes/layouts.js';
import { registerMediaRoutes } from './routes/media.js';
import { registerStudyRoutes } from './routes/studies.js';
import { registerPromptBlockRoutes } from './routes/promptBlocks.js';
import { registerPresetRoutes } from './routes/presets.js';
import { registerQueueRoutes } from './routes/queue.js';
import { registerSystemRoutes } from './routes/system.js';
import { registerWorkflowRoutes } from './routes/workflows.js';
import { attachTerminal } from './terminal.js';

/** Routes reachable before logging in. */
const PUBLIC_API_PATHS = new Set([
  '/api/status',
  '/api/auth/login',
  '/api/auth/logout',
  // The claim endpoint has to be reachable by definition; it refuses once a
  // password exists, so it cannot be used to take over a configured server.
  '/api/auth/setup',
]);

/**
 * Decide which ComfyUI to talk to at boot.
 *
 * A fresh install seeds a preset from `COMFY_URL`, so an existing v1 deployment
 * keeps working with no configuration. After that the stored active connection
 * wins — the environment variable is only ever a starting point.
 */
function resolveConnection(store: Store, config: Config, app: FastifyInstance): ConnectionConfig {
  const active = store.getActiveConnection();
  if (active) return toConfig(active);

  if (store.countConnections() === 0) {
    const id = randomUUID();
    store.insertConnection(id, { name: 'Default', url: config.comfyUrl, authMode: 'none' });
    store.activateConnection(id);
    app.log.info(`Seeded the first connection from COMFY_URL (${config.comfyUrl})`);
    const seeded = store.getConnectionWithSecret(id);
    if (seeded) return toConfig(seeded);
  }

  // Connections exist but none is active (someone deleted the active one
  // directly in the database). Fall back rather than starting up broken.
  const first = store.listConnections()[0];
  if (first) {
    store.activateConnection(first.id);
    const restored = store.getConnectionWithSecret(first.id);
    if (restored) return toConfig(restored);
  }
  return plainConnection(config.comfyUrl);
}

export interface BuiltApp {
  app: FastifyInstance;
  ctx: AppContext;
  config: Config;
}

export async function buildApp(overrides: Partial<Config> = {}): Promise<BuiltApp> {
  const config = { ...loadConfig(), ...overrides };

  /*
   * An explicitly placed data directory is self-contained.
   *
   * The settings files normally live a directory above the project so they
   * survive it being deleted — but a caller that has pointed the database
   * somewhere specific (a test, an embedded use) means "keep everything here",
   * and writing outside that would leak state between runs.
   */
  if (overrides.dataDir && !overrides.stateDir) config.stateDir = overrides.dataDir;
  /*
   * …and that has to include the archive, which `loadConfig` derived from the
   * *default* data directory before the override was seen. Leaving it behind
   * put every caller's images in one shared folder — and because archive paths
   * are content-addressed, one run would then find another run's file already
   * at its path, keep it, and store a row pointing at bytes encrypted under a
   * key it does not have.
   */
  if (overrides.dataDir && !overrides.archiveDir) {
    config.archiveDir = resolve(overrides.dataDir, 'archive');
  }
  // `loadConfig` only creates the directory it derived itself.
  mkdirSync(config.dataDir, { recursive: true });

  const app = Fastify({
    logger: { level: config.logLevel },
    // Phones on a slow link uploading a 40 MB photo need generous timeouts.
    bodyLimit: 96 * 1024 * 1024,
  });

  const store = new Store(config.dbPath);
  const auth = new Auth(store, config.password);
  const vault = new Vault(store);
  const archive = new Archive(config.archiveDir, store, vault);
  const importer = new Importer(store, archive);
  const inputs = new InputLibrary(store);
  const sweeper = new Sweeper(store, archive, app.log);
  /*
   * Before anything reads the database: a fresh install with settings files
   * next to it should come up already configured, including the connection the
   * orchestrator is about to be built around.
   */
  const stateFiles = new StateFiles(store, config.stateDir, app.log);
  /*
   * With the password in the environment the files can be read straight away.
   * Without it they stay sealed until somebody signs in — except for files
   * written before they were encrypted, which `restore` still reads so an
   * upgraded install comes up configured rather than blank.
   */
  if (config.password) stateFiles.unlock(config.password);
  else stateFiles.restore();

  const orchestrator = new Orchestrator(store, resolveConnection(store, config, app), app.log);
  const workflowScanner = new WorkflowScanner(store, orchestrator, stateFiles);
  // The context is built below and the runner needs it, so it is handed a
  // getter rather than the object — a cycle broken by a closure, not a cast.
  const endless = new Endless(store, orchestrator, () => ctx, app.log);
  const studyRunner = new StudyRunner(store, orchestrator, app.log);
  /*
   * The runner has to hear about every run that settles, not only its own: it
   * is how a shot moves from queued to done, and how the last shot of a study
   * turns the study over to its rating phase. Filtering to study runs happens
   * inside, where the shot lookup already is.
   */
  orchestrator.onSettled = (generationId, ok) =>
    studyRunner.onGenerationSettled(generationId, ok);

  // With the password fixed in the environment there is nobody to wait for, so
  // the archive can be unsealed at boot. Otherwise it stays locked until the
  // first sign-in.
  if (config.password) vault.unlock(config.password);

  const ctx: AppContext = {
    config,
    store,
    orchestrator,
    auth,
    archive,
    vault,
    importer,
    inputs,
    stateFiles,
    sweeper,
    workflowScanner,
    endless,
    studyRunner,
  };

  /*
   * Treat an empty JSON body as `{}`.
   *
   * Fastify's default parser rejects `content-type: application/json` with no
   * body outright, which turns every bodyless POST (`/activate`, `/interrupt`)
   * and DELETE into a 400 for any client that sets the header unconditionally —
   * which most HTTP helpers do.
   */
  app.addContentTypeParser<string>(
    'application/json',
    { parseAs: 'string' },
    (_request, body, done) => {
      if (body === undefined || body === null || body === '') {
        done(null, {});
        return;
      }
      try {
        done(null, JSON.parse(body));
      } catch {
        const error = new Error('Invalid JSON body') as Error & { statusCode?: number };
        error.statusCode = 400;
        done(error, undefined);
      }
    },
  );

  await app.register(fastifyCookie);
  await app.register(fastifyMultipart);
  await app.register(fastifyWebsocket);

  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/')) return;
    const path = request.url.split('?')[0] ?? '';
    if (PUBLIC_API_PATHS.has(path)) return;
    await auth.guard(request, reply);
  });

  registerChatRoutes(app, ctx);
  registerSystemRoutes(app, ctx);
  registerConnectionRoutes(app, ctx);
  registerWorkflowRoutes(app, ctx);
  registerPresetRoutes(app, ctx);
  registerLayoutRoutes(app, ctx);
  registerGenerateRoutes(app, ctx);
  registerQueueRoutes(app, ctx);
  registerGalleryRoutes(app, ctx);
  registerFavoriteRoutes(app, ctx);
  registerPromptBlockRoutes(app, ctx);
  registerImportRoutes(app, ctx);
  registerInputImageRoutes(app, ctx);
  registerMediaRoutes(app, ctx);
  registerStudyRoutes(app, ctx);

  /**
   * The shell. Registered only when explicitly enabled — a route that does not
   * exist cannot be reached by a stolen session cookie.
   */
  if (config.terminalEnabled) {
    app.log.warn(
      'LATENT_TERMINAL is on: anyone who logs in gets a shell on this machine.',
    );
    app.get('/api/terminal/ws', { websocket: true }, (socket, request) => {
      if (!auth.isAuthenticated(request)) {
        socket.close(4401, 'Authentication required');
        return;
      }
      void attachTerminal(socket, app.log);
    });
  }

  /** Drop archived copies of images nobody rated. */
  app.post('/api/archive/prune', async () => ({ removed: await archive.pruneUnrated() }));

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
    stateFiles.stop();
    endless.stop();
    studyRunner.pause();
    sweeper.stop();
    vault.lock();
    store.close();
  });

  orchestrator.start();
  stateFiles.start();
  sweeper.start();

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
