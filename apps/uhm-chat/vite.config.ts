import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

// https://vite.dev/config/
export default defineConfig({
  define: {
    'process.env.PKG_VERSION': JSON.stringify('dev'),
  },
  plugins: [
    react(),
    tailwindcss(),
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
    allowedHosts: ['3001uhm.sub2s.live'],
    proxy: {
      // Proxy bucket requests through same-origin to avoid CORS entirely.
      // In production, configure nginx/CDN to proxy this same path prefix.
      '/__bucket': {
        target: 'https://bucket.ermis.network',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/__bucket/, ''),
      },
    },
    watch: {
      // Prevent HMR full-page reloads caused by tsup --watch rebuilding dist/
      ignored: [
        '**/packages/ermis-chat-sdk/dist/**',
        '**/packages/ermis-chat-react/dist/**',
      ],
    },
  },
});
