# VYUHA architecture

```
Browser (Trainee)    --Socket.IO--+
Browser (Trainee)    --Socket.IO--+--> apps/server (Fastify + Socket.IO)
Browser (Instructor) --Socket.IO--+      SessionManager --tick 1 s--> packages/engine
                     --REST-------+      TruthState --> PerceivedState per player
                                         Prisma --> PostgreSQL 16
```

## Packages

| Package           | Role                                                                                                                                                                                                                          |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/engine` | Pure deterministic simulation. No I/O, no `Date.now`, no `Math.random`: all randomness comes from the seeded `mulberry32` PRNG whose state lives in `TruthState.rngState`. Also holds the AAR analysis and keyframe replay. |
| `packages/shared` | Zod schemas, DTO types and socket event names. Every REST body and socket payload is validated with these on the server.                                                                                                      |
| `apps/server`     | Authoritative server: auth, lobby, session manager, socket handlers, geodata ingestion, AAR service and exports.                                                                                                              |
| `apps/web`        | React cockpit for trainees, God View and MSEL authoring for instructors, After Action Review. English and Hindi.                                                                                                              |

## Truth versus perception

The engine holds one ground-truth world per session. Each tick the server asks the engine for a
`PerceivedState` per player, built field by field from what that player could know: own sensors,
messages that were actually delivered (possibly delayed, corrupted or fabricated) and last-known
friendly positions with age. Trainee sockets only ever receive their own `PerceivedState`; only the
instructor room receives `TruthView`. `apps/server/src/sessions/leak.test.ts` fails the build if any
ground-truth field or hostile unit id reaches a trainee socket, or if an instructor endpoint can be
reached by a trainee or an anonymous user.

## Tick pipeline (`step`)

Scheduled injects, player inputs, movement, runners, adaptive EW, sensing, beacons, message delivery
(line of sight, quality, PRNG outcome), authentication resolution, picture-drift sampling, pruning.

Performance guard: `packages/engine/src/perf.test.ts` runs 4 teams of 4 players and asserts that the
95th percentile of one tick plus every player's perceived state is under 100 ms.

## Event sourcing and recovery

Every state change is appended to `SessionEvent`; the engine events of a tick are persisted
atomically. The `SESSION_STARTED` event stores the starting snapshot, and trainee actions and
instructor injects are logged as input events. After a server restart a running session is rebuilt
by replaying the inputs through the engine (`SessionManager.resumeAll`). The same replay powers the
AAR: the review shows truth and a trainee's perception at any tick without storing extra snapshots.

## Progress across sessions

`ProgressService` (apps/server/src/progress) runs when a started session ends. It feeds the stored events and decisions to `computeProgressMetrics` (packages/engine/src/progress.ts, built on `computeMetrics`) and upserts one `SessionMetric` row per trainee, so re-recording a session never duplicates rows. Null means a metric could not be measured in that session (for example no decision was taken under jamming). The trend maths (`percentChange`, `compareToFirst`, `brierTrend`, `average`) lives next to it and is unit tested. `GET /progress/:userId` is open to the trainee themself and to instructors; `GET /progress/trainees` is instructor only. The demo bots in `apps/server/src/demo` are ordinary players driven through the normal action path, flagged by `User.isDemoBot`.

## Security

- Auth: bcrypt password hashes, JWT in an httpOnly `SameSite=Lax` cookie, roles `INSTRUCTOR` and
  `TRAINEE`. Sockets authenticate with the same cookie. There are two sign-in pages, `/login/instructor` and
  `/login/trainee`; the page sends its portal with the credentials and the server refuses an account of the other role
  (403, no cookie), only after the password was right. Instructor accounts are never self-registered.
- Tokens are versioned per user (`User.tokenVersion`, claim `ver`). Signing out increments the version,
  which revokes every token of that user on every device, and drops their open sockets. Rights always
  come from the current database row; the role inside a token is never trusted.
- Sockets: the handshake verifies the cookie and the page's `Origin` (CORS does not cover WebSocket
  upgrades, and a same-site page on another port or subdomain would otherwise ride the cookie). Each
  socket keeps its token's version and expiry; joins, trainee actions and instructor commands re-read
  the account (deleted, re-roled, signed out or expired = error and disconnect), idle sockets are
  re-checked every 30 s, and a socket is dropped when its token expires. Never per simulation tick.
- `@fastify/helmet` headers on every API response (HSTS is sent always; browsers ignore it over plain
  http). The nginx web container sends a Content-Security-Policy generated at build time from the
  bundle's own `VITE_API_URL` / `VITE_MAP_MODE` / `VITE_MAP_STYLE_URL` (so `connect-src` lists exactly the
  API, its socket and, online, the map host), plus nosniff, frame deny, no-referrer, Permissions-Policy,
  COOP and HSTS only when a TLS proxy forwards `X-Forwarded-Proto: https`
  (`apps/web/src/lib/securityHeaders.ts`).
- Containers: PostgreSQL is not published on the host (only `docker-compose.dev.yml` publishes it, on
  127.0.0.1). The server runs as `node` and the web as unprivileged nginx on 8080; both have read-only
  root filesystems (only `/tmp` writable) and `no-new-privileges`. Image files stay root-owned, so the
  server cannot change its code, Prisma engines or migrations. `src/dockerConfig.test.ts` guards this.
- CORS is an exact allow-list (`CORS_ORIGIN`, comma separated). Wildcards and paths are refused at
  start-up.
- Limits: 1 MiB JSON bodies (typed 413), 64 KiB socket messages, token-bucket throttles on
  login/register per address (the address comes from `TRUST_PROXY` hops, never from client-written
  `X-Forwarded-For` entries), on login per account (20, then one every 10 s, from any address), a
  server-wide budget for new accounts (50 at once, then 30 a minute; malformed requests do not count) and on
  socket actions per player. Buckets live in process memory, which matches the single-instance design
  below; memory is bounded (refilled buckets are pruned, at most 10 000 kept, least recently used
  evicted). Restarting the server resets them.
- Logs (pino through Fastify, `LOG_LEVEL`) redact `cookie`, `authorization` and `set-cookie`.
- CSV exports prefix cells that start with `=`, `+`, `-`, `@`, tab or carriage return so
  spreadsheets do not run them as formulas.
- The web app has an error boundary, so a render error shows a recoverable message.

## Session ownership and instructor access

A session belongs to the instructor who created it (`Session.ownerId`). The owner can share it with other
instructor accounts (`SessionInstructor`, `POST/DELETE /sessions/:id/instructors`); co-instructors can do
everything except manage that list. Baseline twins are owned by the instructor who asked for them and
shared with everyone who could instruct the source run. `SessionAccess`
(`apps/server/src/sessions/access.ts`) is the one place the rule lives, and every instructor-only REST
route and socket handler goes through it:

| Surface | Rule |
| --- | --- |
| Session list, lobby, teams, players, start/pause/probe/resume/end, speed, baseline | owner or co-instructor |
| Socket join, live injects, MSEL edits, watch | owner or co-instructor, re-checked on every command |
| AAR summary, snapshot, decisions, JSON / CSV / PDF exports | owner or co-instructor |
| Degraded vs baseline comparison | must be allowed on both runs; the summary hides a twin the reader cannot open |
| Progress (`/progress/:userId`, `/progress/trainees`) and the PDF's "Progress so far" | metrics only from sessions the reader may review; a trainee sees their own complete record |
| Trainee lobby, PACE of their own team, cockpit socket, `/aar/:id/my-sa` | trainees who are players of that session |

Sessions created before ownership existed have no owner and are closed to every instructor until an
operator assigns one (`pnpm --filter @vyuha/server sessions:assign-owner -- --list`, see
`docs/OPERATIONS.md`). The scenario library (`/scenarios`, MSEL editing, geodata ingest) is shared by all
instructors on purpose and is not owner-scoped; a lobby session uses the scenario's MSEL as it is when the
exercise starts. If instructors must not edit each other's scenarios, the next step is to check
`Scenario.createdById` on `PUT /scenarios/:id/msel` and `POST /scenarios/:id/ingest-geo`, or to copy the
MSEL into the session when it is created.

## Single instance

Run exactly one server process. Live exercises (`SessionManager` runtimes), Socket.IO rooms, the
revalidation and expiry timers and the rate-limit buckets live in that process's memory; a second replica
would split sessions between processes, and a trainee and their instructor could land on different ones.
`render.yaml` pins `numInstances: 1`; Docker Compose starts one `server`. Restarts are safe: every input is
event-sourced, so `resumeAll` rebuilds running sessions on start. Scaling out would need the Socket.IO Redis
adapter plus session-to-process affinity (or moving the tick loop to a single worker), and shared rate-limit
and revocation state; none of that is built, because one process comfortably carries the target load
(`perf.test.ts`: 4 teams of 4 players well under 100 ms per tick).

## Health, metrics and configuration

| Endpoint | Meaning |
| --- | --- |
| `GET /health` | overview, always 200: `{ ok: true, db }` |
| `GET /health/live` | the process answers (liveness) |
| `GET /health/ready` | 200 only while PostgreSQL answers, else 503 (Compose healthcheck, Render health check) |
| `GET /metrics` | Prometheus text, only when `METRICS_TOKEN` is set and sent as `Authorization: Bearer …`; counts and timings only (uptime, memory, event-loop delay, running/paused sessions, tick lag, ticks, sockets, db up), never ids, codes, users or settings |

Server environment, validated at start-up (`apps/server/src/config.ts`; a bad value stops the process
with a message naming the variable, never its value):

| Variable | Required | Notes |
| --- | --- | --- |
| `DATABASE_URL` | yes | production refuses an empty or the old published password |
| `JWT_SECRET` | yes | 32+ characters; production refuses the example placeholder |
| `CORS_ORIGIN` | yes (Render: `RENDER_EXTERNAL_URL`) | exact origins, comma separated; also the Socket.IO origin allow-list |
| `NODE_ENV`, `PORT`, `LOG_LEVEL` | no | `production`, `4000`, `info` |
| `COOKIE_SECURE` | no | `true` behind https; production logs a warning while it is `false` |
| `TRUST_PROXY` | no | number of reverse proxies in front (`true` = 1); the client address is read that many entries from the right of `X-Forwarded-For`, so forged entries are ignored. Leave `false` when the server is reachable directly |
| `API_PREFIX`, `WEB_DIST_DIR` | no | single-image deployment (`/api`, built web app) |
| `METRICS_TOKEN` | no | 32+ characters; unset = no `/metrics` |
| `SEED_ON_START`, `SEED_PASSWORD` | no / with seed in production | seed demo data; production needs 12+ characters, never the published demo password (unless `DEMO_MODE`) |
| `SEED_RESET_PASSWORDS` | no | `true` sets the demo accounts back to `SEED_PASSWORD` on every start (public demo) |
| `DEMO_MODE` | no | `true` = deliberate public demo (Render blueprint): production may run with the published demo password and warns on every start instead of refusing. Never for real exercises |
| `OPEN_METEO_ELEVATION_URL`, `OPEN_METEO_FORECAST_URL` | no | point at a local mirror |

Migrations live in `apps/server/prisma/migrations` and are applied with `prisma migrate deploy` (the
container entrypoint does it on every start; `pnpm db:migrate` in development). Backups, restore and
operator tasks: `docs/OPERATIONS.md`.

## Air-gapped deployment

`docker compose up --build` starts PostgreSQL, the server and the web build on one machine and needs
no internet once the images are built. Migrations and the demo seed run on start (`SEED_ON_START`,
through `apps/server/docker-entrypoint.sh`, which calls Prisma and tsx directly so no package manager
is fetched at run time),
and the seed falls back to the real Open-Meteo terrain and weather snapshot bundled in the repo
(`pnpm --filter @vyuha/server geo:fallback` regenerates it).

### Offline base map

The map reads a single static [PMTiles](https://docs.protomaps.com/pmtiles/) file served by the web
container, so there is no tile server:

| File                                 | What it is                                                                                                                |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/public/tiles/area.pmtiles` | Protomaps/OpenStreetMap vector tiles for Op Silent Ridge plus a 20 km margin, zoom 0 to 15 (about 3.5 MB)                 |
| `apps/web/public/map-assets/`        | Glyphs (Noto Sans Regular, Medium, Italic) and the v4 `light` sprite sheet from protomaps/basemaps-assets                  |

Both are committed, so a fresh clone works offline. To rebuild them (new area, newer OSM data) run
`scripts/fetch-tiles.sh` once while online. It downloads the `pmtiles` CLI if it is missing, finds
the newest Protomaps planet build and runs
`pmtiles extract <build> area.pmtiles --bbox=77.23,33.90,77.92,34.44 --maxzoom=15`, then verifies the
archive and downloads the matching assets. `BBOX=min_lon,min_lat,max_lon,max_lat` and `MAXZOOM=n`
override the area, `--force` re-downloads.

How the browser uses it (`apps/web/src/lib/basemap.ts`):

1. `MAP_MODE=offline` (default; `VITE_MAP_MODE` in the web app, `MAP_MODE` in `.env` and
   docker compose) builds a local MapLibre style with the `pmtiles://` protocol. The style holds no URL
   outside the app's own origin (a unit test checks this) and its attribution is plain text.
2. The tile file is read with HTTP Range requests. nginx serves `/tiles/` as plain static bytes
   (no gzip, `Accept-Ranges: bytes`, a real 404 when missing) and the Vite dev server does the same.
3. If the PMTiles file is missing or is not a PMTiles archive, every map falls back to a hillshade
   with elevation tint and contour lines drawn from the stored terrain grid
   (`GET /scenarios/:id/terrain`, any signed-in user), so a map is never blank. A notice says so.
4. `MAP_MODE=online` uses the hosted style in `VITE_MAP_STYLE_URL` instead (default OpenFreeMap),
   and also falls back to the hillshade if it cannot load.

The Playwright test `e2e/offline-map.spec.ts` aborts every non-localhost request, makes the browser's
DNS fail for all other hosts, and asserts that the map draws from the PMTiles file with Range
responses, makes no external request and has no failed request; a second test removes the tile file
and checks the hillshade fallback.

`JWT_SECRET` and `POSTGRES_PASSWORD` have no default. `docker compose` stops with a message until they
are set in `.env`, and in production the server refuses to start when `JWT_SECRET` is missing, shorter
than 32 characters or still the placeholder from the example files, or when `DATABASE_URL` carries an
empty or the old published database password. The seed demands `SEED_PASSWORD` (12+ characters, not the
published demo password) in production and replaces the published password on demo accounts an older
seed created; with the seed off, the server refuses to start while any demo account still accepts it.

## Testing

| Layer  | Command                            | What it covers                                                             |
| ------ | ---------------------------------- | -------------------------------------------------------------------------- |
| engine | `pnpm --filter @vyuha/engine test` | rules, determinism, AAR analysis, performance budget, coverage gate        |
| server | `pnpm --filter @vyuha/server test` | REST, sockets, replay equality, leak guard, hardening, exports             |
| web    | `pnpm --filter @vyuha/web test`    | cockpit, God View, MSEL, AAR, i18n parity, error boundary                  |
| e2e    | `pnpm e2e`                         | instructor and two trainees in real browsers through to the PDF export     |

## Additions (SAGAT, air and cyber injects, baseline runs)

- **Probes** are engine inputs (`PROBE_START`, `PROBE_ANSWER`, `PROBE_CLOSE`), so they are logged and replayed like everything else. `PROBE_START` freezes the truth of its tick inside `TruthState.probes`; scoring (`probe.ts`) compares an answer with that frozen copy. `PROBE_SCORED` and `PROBE_TRUTH` are visible to the instructor only; a trainee's `PerceivedState.probe` carries just the probe id and its times. Answers are the one action accepted while a session is paused: they wait in the input queue and are applied on the first tick after resume, or in the final tick when the exercise ends.
- **GPS spoof and C2 compromise** live in `TruthState.gpsSpoofs` and `TruthState.c2Compromises`. The spoof shifts what the UAV reports (`reportedPosition`, and reports at `registerReport`); the compromise shifts only what one player is shown (`believedFriendlyPosition`), leaving the stored fixes honest, so the picture is correct again the moment it is caught. Neither draws extra random numbers except the per-teammate drift bearings.
- **Baseline runs** set `TruthState.clean`. The flag is stored in `Session.degradationProfile` and in the `SESSION_STARTED` payload, so replay and the review rebuild a baseline exactly. In a clean run degrading injects are skipped (`INJECT_SKIPPED`), `currentJamming` is zero and every message is delivered after its channel latency.
- **Radio audio and 3D terrain** are client-side. The audio plays only what `perceived:state` already carries. The terrain uses a custom MapLibre protocol (`vyuhadem://`) whose tiles are computed from `GET /scenarios/:id/terrain`.

