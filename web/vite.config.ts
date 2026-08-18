import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const resolvePath = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

/** The Latent server, which proxies everything through to ComfyUI. */
const SERVER_ORIGIN = process.env.LATENT_SERVER ?? 'http://127.0.0.1:6173';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg', 'icon-192.png', 'icon-512.png'],
      manifest: {
        name: 'Latent',
        short_name: 'Latent',
        description: 'A mobile ComfyUI client',
        theme_color: '#0a0a0f',
        background_color: '#0a0a0f',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Never cache the API: generations, queue state and images proxied from
        // ComfyUI must always be live. Only the app shell is precached.
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [],
      },
    }),
  ],
  resolve: {
    // Use the shared package's source directly so type changes hot-reload
    // without a separate build step.
    alias: {
      '@latent/shared': resolvePath('../shared/src/index.ts'),
    },
  },
  server: {
    host: true, // reachable from a phone on the same network
    port: 5173,
    proxy: {
      '/api': {
        target: SERVER_ORIGIN,
        changeOrigin: true,
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
