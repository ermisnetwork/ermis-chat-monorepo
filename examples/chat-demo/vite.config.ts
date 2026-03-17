import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
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
