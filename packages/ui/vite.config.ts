import { resolve } from 'node:path';

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The Manager's client.
 *
 * `@ruood/announcement-schema` is aliased to its TypeScript source rather than
 * resolved through the workspace link, and it has to be: the package's built
 * output is CommonJS, where `export * from './constants'` compiles to an
 * `__exportStar` call that Rollup cannot analyse statically. The types resolve
 * from the `.d.ts` and the bundle then fails at build time on a named import
 * that is genuinely there. The same mapping is in `jest.config.js`, for the
 * same reason.
 *
 * It is the same source either way, which is the point — the browser runs the
 * real validator, so the editor's live errors are the errors publishing will
 * give, not an approximation of them.
 *
 * `@ruood/announcement-core` is deliberately NOT aliased. It reaches for `fs`,
 * `sharp` and `simple-git`; the client imports only its types, which erase.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@ruood/announcement-schema': resolve(__dirname, '../schema/src/index.ts'),
    },
  },
  build: {
    outDir: 'dist/web',
    emptyOutDir: true,
    // A local tool inspected by one person; a readable stack beats a few KB.
    sourcemap: true,
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // The browser only ever talks to this origin, so there is no CORS to
      // configure and no cross-origin request for the server to weigh up.
      '/api': { target: 'http://127.0.0.1:4874', changeOrigin: false },
    },
  },
});
