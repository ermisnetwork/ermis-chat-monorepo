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
      registerType: 'autoUpdate',
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
      // Use workspace sources in dev so Vite can hot-reload SDK/UI changes instantly.
      react: path.resolve(__dirname, '../../node_modules/react'),
      'react-dom': path.resolve(__dirname, '../../node_modules/react-dom'),
      '@ermis-network/ermis-chat-react/dist/index.css': path.resolve(
        __dirname,
        '../../packages/ermis-chat-react/src/styles/index.css',
      ),
      '@ermis-network/ermis-chat-react': path.resolve(
        __dirname,
        '../../packages/ermis-chat-react/src/index.ts',
      ),
      '@ermis-network/ermis-chat-sdk': path.resolve(
        __dirname,
        '../../packages/ermis-chat-sdk/src/index.ts',
      ),
    },
    dedupe: ['react', 'react-dom'],
  },
  optimizeDeps: {
    exclude: ['@ermis-network/ermis-chat-react', '@ermis-network/ermis-chat-sdk'],
  },
  css: {
    devSourcemap: true,
  },
  server: {
    port: 3001,
    strictPort: true,
  },
});
