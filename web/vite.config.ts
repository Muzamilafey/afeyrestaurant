import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import path from 'node:path';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'Chili POS',
        short_name: 'Chili POS',
        description: 'Restaurant & bar point of sale',
        theme_color: '#07963C',
        background_color: '#F3F5F4',
        display: 'standalone',
        orientation: 'landscape',
        start_url: '/',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'favicon.svg', sizes: 'any', type: 'image/svg+xml' },
        ],
      },
      workbox: {
        // App shell is cached for offline start; API data is cached in IndexedDB by the app itself.
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//, /^\/uploads\//],
        runtimeCaching: [{ urlPattern: /\/uploads\/.*\.(png|jpg|webp)$/, handler: 'CacheFirst', options: { cacheName: 'product-images', expiration: { maxEntries: 500, maxAgeSeconds: 30 * 86400 } } }],
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
