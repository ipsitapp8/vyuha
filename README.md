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
Open http://localhost:5173 and choose **Instructor login** or **Trainee login** (demo accounts after `pnpm db:seed`: `instructor@vyuha.local` and `trainee1@vyuha.local` to `trainee3@vyuha.local`, password `Vyuha@123`). Trainees can create their own account; instructor accounts are issued by an administrator. Check the API at http://localhost:4000/health → `{"ok":true,"db":true}`.

## Full stack in Docker
```bash
docker compose up --build    # web :8080, server :4000, db :5432
```

### Offline base map
The map works with no internet by default (`MAP_MODE=offline`): the exercise-area tiles (`apps/web/public/tiles/area.pmtiles`) and map fonts and sprites (`apps/web/public/map-assets/`) are in the repo. To regenerate them for another area or newer data, run `scripts/fetch-tiles.sh` once while online (needs `curl`, `unzip` and Node). Set `MAP_MODE=online` in `.env` to use the hosted OpenFreeMap style instead. Details in `docs/ARCHITECTURE.md`.

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

## Instructor God View and MSEL authoring (Phase 7)

- `/instructor/sessions/:id` (alias `/instructor/session/:id`): lobby management before the start; during the exercise the **God View** shows the ground-truth map beside the selected trainee's perceived map (dashed markers on the truth map are what that trainee believes), start/pause/resume/end and 1x/2x/4x, live inject buttons (jam a channel, cut SATCOM, spoof an order, conflicting report, weather change), per-channel degradation sliders, a horizontal MSEL timeline (add / edit / remove injects that have not fired), and a card per trainee (picture drift, last decision, average latency, confidence vs correctness and Brier score, spoofs acted on).
- Instructor inputs travel over the socket (`instructor:input`, `instructor:watch`), are validated with Zod, logged as session events and replayed exactly after a server restart.
- `/instructor/scenarios/:id/msel`: form-based MSEL editor with JSON import/export. Imports are checked with the shared Zod schema and against the scenario (unknown units, wrong sides, positions outside the area). Sessions already started keep the MSEL they began with.
- All instructor screens are available in English and Hindi.

## After Action Review and exports (Phase 8)

After an instructor ends a session, open **Open after action review** on the God View (or **Review** on the instructor home) to reach `/aar/:sessionId`. The review is rebuilt only from the `SessionEvent` and `Decision` tables by deterministic replay, so it works for any ended session.

- **Ghost Replay**: timeline scrubber, truth map beside the chosen trainee's perceived map, clickable decision markers showing rationale, confidence and both snapshots.
- **Charts**: picture drift over time, decision latency, confidence calibration, channel usage vs jamming.
- **Trainee summary** (screen and PDF) with decisions, Brier, latency, grading and **spoofs challenged**: how many of the fake orders a trainee received they challenged with Authenticate, as a share with the counts (for example 100% (1 of 1)); a dash when none reached them.
- **Team message flow** graph and rule-based **Key Learning Points** (offline, no AI).
- **Exports** (instructor only): PDF report (`/aar/:id/export.pdf`), decisions CSV, full event log JSON.

Test: `pnpm --filter @vyuha/server test` (AAR export and replay tests), `pnpm --filter @vyuha/engine test` (analysis rules), `pnpm --filter @vyuha/web test`.

## Hardening and audit (Phase 9)

- Server: helmet headers, exact CORS allow-list, 1 MiB body and 64 KiB socket limits, login/register throttling, log redaction (`LOG_LEVEL`).
- Web: error boundary with reload and home actions.
- Guards in the test suite: payload-leak test (no ground truth to trainees, instructor-only endpoints), engine performance budget (4 teams x 4 players, tick under 100 ms), replay equality.
- End-to-end: `pnpm e2e` drives an instructor and two trainees in Chrome through spoof, end and PDF export. Needs `docker compose up -d db`, `pnpm db:migrate` and `pnpm db:seed`; it reuses servers already running on 4000 and 5173.
- Docs: `docs/ARCHITECTURE.md` (design, security, air-gapped deployment) and `docs/DEMO_SCRIPT.md` (12-minute walkthrough).

## Progress across sessions

When a session ends, the server computes five numbers per trainee from its event log and decisions and stores them in `SessionMetric`: average decision latency, latency under jamming (decisions taken while any channel was jammed 30% or more), Brier score, share of fake orders challenged with Authenticate, and report grading accuracy. `/progress/:userId` charts them across sessions, with a "3rd session vs 1st session" change in decision delay under jamming and a Brier trend arrow; with fewer than 2 sessions it says "Need 2+ sessions for a trend". An instructor sees every trainee (`/progress`), a trainee only themself. The AAR PDF adds a "Progress so far" section for trainees with 2+ sessions.

**Demo history without faking anything:** `pnpm demo:history` plays three real Op Silent Ridge exercises through the normal lobby, session manager and metric recording, with three scripted bot trainees (`apps/server/src/demo`) who get faster and start authenticating the fake order. The engine scores what they did, so no metric is typed in by hand. Runs are deterministic. The bots are flagged `isDemoBot` and shown as "Demo bot" everywhere. Needs the database seeded (`pnpm db:migrate && pnpm db:seed`). `pnpm demo:history -- --reset` removes the bots' sessions and plays them again.

## Interface and accessibility

The web app follows the layout of an Indian government portal so it is familiar and easy to read: a utility bar with reader controls, a tricolour rule, the service name and purpose, a navy main menu for the signed-in role (instructor: scenarios and sessions, trainee progress; trainee: join an exercise, my progress) and a footer that states the data sources and that this is a prototype, not an official government website. It uses its own mark, not the State Emblem of India, whose use is restricted by law.

- **Text size** A−, A, A+ (five steps) and a **high-contrast** theme, both remembered in the browser.
- **Skip to main content** link, landmarks, a visible 3 px keyboard focus, and dark-on-light status colours chosen for contrast.
- English and Hindi, and a layout that works down to phone width.
- The trainee cockpit keeps a single slim header so the map and panels have the room.

## Deploying

`render.yaml` is a Render Blueprint and the root `Dockerfile` builds one image holding the web app, the API (under `/api`) and the live socket, so a single service plus a PostgreSQL database is the whole deployment. Step by step instructions, settings and free-plan limits are in `docs/DEPLOY_RENDER.md`. The image was run against a fresh database and checked in a real browser: sign-in, deep links, team management, the live cockpit and map, and the PDF export.
