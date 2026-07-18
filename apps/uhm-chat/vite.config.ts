import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import path from 'path';

// https://vite.dev/config/
export default defineConfig({
  define: {
    'process.env.PKG_VERSION': JSON.stringify('dev'),
  },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'prompt',
      workbox: {
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024, // Tăng giới hạn lên 5MB
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/bucket\.ermis\.network\/.*$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'ermis-image-cache',
              expiration: {
                maxEntries: 1000,
                maxAgeSeconds: 30 * 24 * 60 * 60, // 30 Days
              },
              cacheableResponse: {
                statuses: [0, 200],
              },
            },
          },
          {
            urlPattern: /\.(?:png|jpg|jpeg|svg|gif|webp)$/,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'general-image-cache',
              expiration: {
                maxEntries: 200,
              },
            },
          },
        ],
      },
      devOptions: {
        enabled: false,
      },
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
    dedupe: ['react', 'react-dom'],
  },
  optimizeDeps: {
    exclude: ['@ermis-network/ermis-chat-react', '@ermis-network/ermis-chat-sdk'],
    // The SDK intentionally keeps these CommonJS/UMD dependencies external.
    // Prebundle them so Vite dev provides correct ESM interop.
    include: ['event-source-polyfill', 'form-data', 'isomorphic-ws'],
  },
  css: { devSourcemap: false },
  server: {
    port: 3001,
    strictPort: true,
  },
});
