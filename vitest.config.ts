import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const resolvePath = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

export default defineConfig({
  resolve: {
    // Run tests against the shared package's source, so `npm test` never
    // depends on a stale `shared/dist`.
    alias: {
      '@latent/shared/fixtures': resolvePath('./shared/src/fixtures/index.ts'),
      '@latent/shared': resolvePath('./shared/src/index.ts'),
    },
  },
  test: {
    include: ['shared/src/**/*.test.ts', 'server/src/**/*.test.ts', 'web/src/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
  },
});
