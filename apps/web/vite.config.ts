import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

// MapLibre 6 runs in a module worker whose URL it derives from its own module location. Once Vite
// bundles it into the app chunk that guess is wrong, so we serve the worker files ourselves at a fixed
// path (/maplibre/...) in dev and emit them into the production build.
const WORKER_FILES = ['maplibre-gl-worker.mjs', 'maplibre-gl-shared.mjs'] as const;
const distDir = fileURLToPath(new URL('./node_modules/maplibre-gl/dist/', import.meta.url));

function maplibreWorker(): Plugin {
  return {
    name: 'vyuha-maplibre-worker',
    configureServer(server) {
      server.middlewares.use('/maplibre', (req, res, next) => {
        const name = (req.url ?? '').replace(/^\//, '').split('?')[0] ?? '';
        if (!(WORKER_FILES as readonly string[]).includes(name)) return next();
        res.setHeader('Content-Type', 'text/javascript');
        res.end(readFileSync(distDir + name));
      });
    },
    generateBundle() {
      for (const name of WORKER_FILES) {
        this.emitFile({
          type: 'asset',
          fileName: `maplibre/${name}`,
          source: readFileSync(distDir + name),
        });
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), maplibreWorker()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: { port: 5173 },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,
  },
});
