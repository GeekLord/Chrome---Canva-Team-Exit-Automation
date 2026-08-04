import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const projectRoot = import.meta.dirname;

/**
 * Pass 1 of the MV3 build: extension pages and the background service worker.
 *
 * These outputs may be ES modules, so Rollup is allowed to emit shared chunks.
 * The content script is built separately (see vite.config.content.ts) because
 * MV3 content scripts must be a single classic script, not a module.
 */
export default defineConfig({
  root: resolve(projectRoot, 'src'),
  publicDir: resolve(projectRoot, 'public'),
  build: {
    outDir: resolve(projectRoot, 'dist'),
    emptyOutDir: true,
    target: 'chrome110',
    sourcemap: true,
    minify: false,
    rollupOptions: {
      input: {
        'service-worker': resolve(projectRoot, 'src/background/service-worker.ts'),
        popup: resolve(projectRoot, 'src/popup/index.html'),
        options: resolve(projectRoot, 'src/options/index.html'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name].[ext]',
      },
    },
  },
});
