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

`docker compose up --build` starts PostgreSQL, the server and the web build on one machine. Once the
images are built it needs no internet: migrations and the demo seed run on start (`SEED_ON_START`),
and the seed falls back to the real Open-Meteo terrain and weather snapshot bundled in the repo
(`pnpm --filter @vyuha/server geo:fallback` regenerates it).

Map tiles are the one external dependency. The base map style is the build argument
`VITE_MAP_STYLE_URL` (default OpenFreeMap). On an isolated network, host an OpenMapTiles-compatible
style and tiles inside it (for example tileserver-gl with an MBTiles extract of the exercise area)
and rebuild the web image with `VITE_MAP_STYLE_URL=http://<tile-host>/styles/<name>/style.json`.
Without a reachable style the maps have no base layer, but units, the exercise and the exports
still work. This tile-hosting setup is described here but has not been tested.

Set `JWT_SECRET` before real use. The compose file ships a placeholder and the server logs a warning
when it is still in place in production.

## Testing

| Layer  | Command                            | What it covers                                                             |
| ------ | ---------------------------------- | -------------------------------------------------------------------------- |
| engine | `pnpm --filter @vyuha/engine test` | rules, determinism, AAR analysis, performance budget, coverage gate        |
| server | `pnpm --filter @vyuha/server test` | REST, sockets, replay equality, leak guard, hardening, exports             |
| web    | `pnpm --filter @vyuha/web test`    | cockpit, God View, MSEL, AAR, i18n parity, error boundary                  |
| e2e    | `pnpm e2e`                         | instructor and two trainees in real browsers through to the PDF export     |
