import { buildApp } from './app.js';

const { app, config } = await buildApp();

try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info(`Latent is serving on http://${config.host}:${config.port}`);
  app.log.info(`ComfyUI: ${config.comfyUrl}`);
  if (!config.password) {
    app.log.warn('No LATENT_PASSWORD set — anyone on this network can use the app.');
  }
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    app.log.info(`${signal} received — shutting down`);
    void app.close().then(() => process.exit(0));
  });
}
