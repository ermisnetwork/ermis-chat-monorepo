import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

export default defineConfig({
  base: process.env.VITE_BASE_PATH || '/',
  plugins: [react(), tailwindcss()],
  define: {
    'process.env.PKG_VERSION': JSON.stringify('dev'),
  },
  resolve: {
    alias: {
      // Deduplicate React – ensures one copy across all packages
      'react': path.resolve(__dirname, '../../node_modules/react'),
      'react-dom': path.resolve(__dirname, '../../node_modules/react-dom'),
      // Point directly to source files for instant HMR during development
      '@ermis-network/ermis-chat-react': path.resolve(
        __dirname,
        '../../packages/ermis-chat-react/src/index.ts',
      ),
      '@ermis-network/ermis-chat-sdk': path.resolve(
        __dirname,
        '../../packages/ermis-chat-sdk/src/index.ts',
      ),
    },
  },
  optimizeDeps: {
    // Exclude workspace packages from pre-bundling so aliases work
    exclude: ['@ermis-network/ermis-chat-sdk', '@ermis-network/ermis-chat-react'],
  },
});
