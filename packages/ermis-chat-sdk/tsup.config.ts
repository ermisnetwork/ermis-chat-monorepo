import { defineConfig } from 'tsup';
import { readFileSync } from 'fs';
import path from 'path';

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));
const shimPath = path.resolve(__dirname, 'src/shims/empty.ts');

export default defineConfig([
  // 1. Node.js bundle (CJS + ESM) + type declarations
  {
    entry: ['src/index.ts'],
    format: ['cjs', 'esm'],
    outDir: 'dist',
    dts: true,
    sourcemap: true,
    clean: true,
    splitting: false,
    external: ['axios', 'form-data', 'isomorphic-ws', 'https', 'ws', 'event-source-polyfill'],
    define: {
      'process.env.PKG_VERSION': JSON.stringify(pkg.version),
    },
    outExtension({ format }) {
      return { js: format === 'cjs' ? '.cjs' : '.mjs' };
    },
  },
  // 2. Browser bundle (CJS + ESM) — shims jsonwebtoken & https to null
  {
    entry: ['src/index.ts'],
    format: ['cjs', 'esm'],
    outDir: 'dist',
    sourcemap: true,
    splitting: false,
    external: ['axios', 'form-data', 'isomorphic-ws', 'ws', 'event-source-polyfill'],
    define: {
      'process.env.PKG_VERSION': JSON.stringify(pkg.version),
    },
    esbuildOptions(options) {
      options.alias = {
        https: shimPath,
      };
    },
    outExtension({ format }) {
      return { js: format === 'cjs' ? '.browser.cjs' : '.browser.mjs' };
    },
  },
  // 3. Full browser bundle (IIFE, minified for CDN)
  {
    entry: ['src/index.ts'],
    format: ['iife'],
    outDir: 'dist',
    sourcemap: true,
    minify: true,
    splitting: false,
    globalName: 'ErmisChatSDK',
    define: {
      'process.env.PKG_VERSION': JSON.stringify(pkg.version),
    },
    esbuildOptions(options) {
      options.alias = {
        https: shimPath,
      };
    },
    outExtension() {
      return { js: '.browser.full-bundle.min.js' };
    },
  },
]);
