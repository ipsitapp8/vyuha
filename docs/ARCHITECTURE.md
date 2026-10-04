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

## Security

- Auth: bcrypt password hashes, JWT in an httpOnly `SameSite=Lax` cookie, roles `INSTRUCTOR` and
  `TRAINEE`. Sockets authenticate with the same cookie.
- `@fastify/helmet` headers on every API response; nginx adds nosniff, frame deny and no-referrer.
- CORS is an exact allow-list (`CORS_ORIGIN`, comma separated). Wildcards and paths are refused at
  start-up.
- Limits: 1 MiB JSON bodies (typed 413), 64 KiB socket messages, token-bucket throttles on
  login/register per address and on socket actions per player.
- Logs (pino through Fastify, `LOG_LEVEL`) redact `cookie`, `authorization` and `set-cookie`.
- CSV exports prefix cells that start with `=`, `+`, `-`, `@`, tab or carriage return so
  spreadsheets do not run them as formulas.
- The web app has an error boundary, so a render error shows a recoverable message.

## Air-gapped deployment

`docker compose up --build` starts PostgreSQL, the server and the web build on one machine and needs
no internet once the images are built. Migrations and the demo seed run on start (`SEED_ON_START`),
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

Set `JWT_SECRET` before real use. The compose file ships a placeholder and the server logs a warning
when it is still in place in production.

## Testing

| Layer  | Command                            | What it covers                                                             |
| ------ | ---------------------------------- | -------------------------------------------------------------------------- |
| engine | `pnpm --filter @vyuha/engine test` | rules, determinism, AAR analysis, performance budget, coverage gate        |
| server | `pnpm --filter @vyuha/server test` | REST, sockets, replay equality, leak guard, hardening, exports             |
| web    | `pnpm --filter @vyuha/web test`    | cockpit, God View, MSEL, AAR, i18n parity, error boundary                  |
| e2e    | `pnpm e2e`                         | instructor and two trainees in real browsers through to the PDF export     |
