# VYUHA — Virtual Yuddh-abhyas Under Hampered Awareness

SIH 26248 · Immersive multi-domain decision-making trainer for degraded communication environments.
See `CLAUDE.md` for the full plan.

## Prerequisites
- Node.js 20+
- pnpm 9 (`npm install -g pnpm@9`)
- Docker Desktop (must be running)

## Setup
```bash
cp .env.example .env
cp apps/server/.env.example apps/server/.env
cp apps/web/.env.example apps/web/.env

docker compose up -d db      # PostgreSQL 16 on localhost:5432
pnpm install
pnpm db:migrate              # prisma migrate dev
pnpm dev                     # server :4000, web :5173
```
Open http://localhost:5173. Check the API at http://localhost:4000/health → `{"ok":true,"db":true}`.

## Full stack in Docker
```bash
docker compose up --build    # web :8080, server :4000, db :5432
```

## Scripts
| Script | Purpose |
|---|---|
| `pnpm dev` | server + web with hot reload |
| `pnpm build` | build every workspace |
| `pnpm test` | Vitest in every workspace |
| `pnpm typecheck` / `pnpm lint` | quality gates |
| `pnpm db:migrate` / `pnpm db:seed` | database migration / seed |

## Layout
- `packages/engine` — pure deterministic simulation (seeded PRNG)
- `packages/shared` — Zod schemas and shared types
- `apps/server` — Fastify + Socket.IO + Prisma
- `apps/web` — Vite + React + Tailwind

## Real terrain and weather (Phase 3)

- Instructor > scenario > "Ingest real terrain and weather" samples a 64x64 elevation grid from the Open-Meteo Elevation API (batches of 100, retry with backoff, 10 s timeout) plus current weather, and stores both in PostgreSQL.
- Open-Meteo has per-minute/hour limits. Per-minute limits are waited out; hourly/daily limits fail fast and the app falls back to the last cached grid in the DB, then to the real-data copy bundled for Op Silent Ridge (`apps/server/src/seed/silent-ridge-geo.json`), so the demo works offline.
- `pnpm db:seed` tries live ingestion once and otherwise uses the bundled copy. Regenerate the bundle with `pnpm --filter @vyuha/server geo:fallback` (needs internet).
- Optional env: `OPEN_METEO_ELEVATION_URL`, `OPEN_METEO_FORECAST_URL` (point at a local mirror), web `VITE_MAP_STYLE_URL` (local tile style). With no tiles reachable the map shows the terrain overlay on a plain background.

## Trainee cockpit and language (Phase 6)

- `/session/:code` is the trainee cockpit: tactical map (own unit, teammates "last known", reported contacts with age labels; low-confidence reports are dashed and faded), comms panel (live signal bars, PACE, switch channel, inbox, compose), reports panel (Admiralty A1-F6 grading) and a decision modal (action, confidence, rationale of 10+ characters).
- Jamming shows as static over the map and a JAMMED badge; losing the data-link freezes teammates and contacts on the map at their last good state. Both respect `prefers-reduced-motion`.
- English / Hindi toggle (top right); all trainee-facing strings live in `apps/web/src/i18n/en.json` and `hi.json` (a test checks both files have the same keys). Instructor screens are localised in Phase 7.
- MapLibre 6 needs its worker served at `/maplibre/` (handled by a small Vite plugin in dev and emitted into the production build; nginx serves `.mjs` as JavaScript).
- `GET /auth/session` always answers 200 (`user: null` when signed out), so a signed-out page load produces no console errors.
