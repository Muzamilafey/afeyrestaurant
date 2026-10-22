import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import path from 'node:path';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // 'prompt', not 'autoUpdate': a new version must never reload a till in the middle of an order.
      registerType: 'prompt',
      injectRegister: false,
      includeAssets: ['favicon.svg', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png'],
      // The manifest is served by the API (/api/v1/manifest.webmanifest) so the installed app shows the business name.
      manifest: false,
      workbox: {
        // App shell is cached for offline start; API data is cached in IndexedDB by the app itself.
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//, /^\/uploads\//],
        cleanupOutdatedCaches: true,
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        runtimeCaching: [
          { urlPattern: /\/uploads\/.*\.(png|jpg|jpeg|webp)$/, handler: 'CacheFirst', options: { cacheName: 'product-images', expiration: { maxEntries: 500, maxAgeSeconds: 30 * 86400 } } },
          { urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/, handler: 'StaleWhileRevalidate', options: { cacheName: 'google-fonts-css' } },
          { urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/, handler: 'CacheFirst', options: { cacheName: 'google-fonts', expiration: { maxEntries: 20, maxAgeSeconds: 365 * 86400 }, cacheableResponse: { statuses: [0, 200] } } },
        ],
      },
    }),
  ],
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:4000', changeOrigin: false, ws: true },
      '/uploads': 'http://localhost:4000',
    },
  },
  build: { sourcemap: true, chunkSizeWarningLimit: 1200 },
  test: { environment: 'jsdom', setupFiles: ['./src/test-setup.ts'], css: false },
});
