import { setWorkerUrl } from 'maplibre-gl';

// See vite.config.ts: the worker files are served from /maplibre/ in dev and emitted into the build.
setWorkerUrl(`${import.meta.env.BASE_URL}maplibre/maplibre-gl-worker.mjs`);
