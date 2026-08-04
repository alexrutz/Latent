import { createMockComfy } from './comfy.js';
import { createMockLlama } from './llama.js';

/**
 * Runs the mock ComfyUI standalone: `npm run mock`.
 * Point the real server at it with COMFY_URL=http://127.0.0.1:8188.
 */
const port = Number(process.env.MOCK_PORT ?? 8188);
const stepDelayMs = Number(process.env.MOCK_STEP_MS ?? 35);

const mock = createMockComfy({ stepDelayMs, logLevel: process.env.LOG_LEVEL ?? 'warn' });
const address = await mock.listen(port, process.env.MOCK_HOST ?? '127.0.0.1');

console.log(`Mock ComfyUI listening on ${address} (${stepDelayMs}ms per simulated step)`);

/*
 * A stand-in for llama.cpp alongside it, so the chat module can be driven
 * without a model file. Its replies are scripted over `/__script`, which is why
 * this is a mock and not a tiny model.
 */
const llama = createMockLlama({ logLevel: process.env.LOG_LEVEL ?? 'warn' });
llama.app.post('/__script', async (request) => {
  llama.script(...(request.body as Parameters<typeof llama.script>));
  return { ok: true };
});
// What was actually sent, so a test can assert on the request rather than only
// on the reply — which is the only way to see that a tool was withheld.
llama.app.get('/__requests', async () => llama.requests);
const llamaAddress = await llama.listen(Number(process.env.MOCK_LLAMA_PORT ?? 8189));
console.log(`Mock model server listening on ${llamaAddress}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void Promise.all([mock.close(), llama.close()]).then(() => process.exit(0));
  });
}
