import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const projectRoot = import.meta.dirname;

/**
 * Pass 2 of the MV3 build: the Canva content script.
 *
 * MV3 content scripts are classic scripts, so this bundle must be a
 * self-contained IIFE with no import statements and no shared chunks.
 * `emptyOutDir` stays false so this pass does not wipe pass 1 output.
 */
export default defineConfig({
  build: {
    outDir: resolve(projectRoot, 'dist'),
    emptyOutDir: false,
    target: 'chrome110',
    sourcemap: true,
    minify: false,
    lib: {
      entry: resolve(projectRoot, 'src/content/index.ts'),
      name: 'CanvaTeamExitAutomationContent',
      formats: ['iife'],
      fileName: () => 'content.js',
    },
  },
});
