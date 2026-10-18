import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { loadEnv, type Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import { nginxSecurityHeaders } from './src/lib/securityHeaders';

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

// The production web container's nginx headers, built from the same VITE_* values as the bundle so the
// Content-Security-Policy allows exactly the API and map hosts this build talks to. apps/web/Dockerfile
// moves the file out of dist into nginx's config.
function nginxHeaders(env: Record<string, string>): Plugin {
  return {
    name: 'vyuha-nginx-security-headers',
    apply: 'build',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'nginx/security-headers.conf',
        source: nginxSecurityHeaders({
          apiUrl: env['VITE_API_URL'],
          mapMode: env['VITE_MAP_MODE'],
          mapStyleUrl: env['VITE_MAP_STYLE_URL'],
        }),
      });
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), maplibreWorker(), nginxHeaders(loadEnv(mode, process.cwd(), 'VITE_'))],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: { port: 5173 },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    // Rendering whole pages in jsdom is slow when the machine is busy (other builds, Docker); the default 5 s
    // made the first test of a file fail by timeout alone.
    testTimeout: 20_000,
  },
}));
