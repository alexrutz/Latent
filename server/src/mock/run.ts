import { createMockComfy } from './comfy.js';

/**
 * Runs the mock ComfyUI standalone: `npm run mock`.
 * Point the real server at it with COMFY_URL=http://127.0.0.1:8188.
 */
const port = Number(process.env.MOCK_PORT ?? 8188);
const stepDelayMs = Number(process.env.MOCK_STEP_MS ?? 35);

const mock = createMockComfy({ stepDelayMs, logLevel: process.env.LOG_LEVEL ?? 'warn' });
const address = await mock.listen(port, process.env.MOCK_HOST ?? '127.0.0.1');

console.log(`Mock ComfyUI listening on ${address} (${stepDelayMs}ms per simulated step)`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void mock.close().then(() => process.exit(0));
  });
}
