# VYUHA (Virtual Yuddh-abhyas Under Hampered Awareness)
SIH 26248 · Immersive Multi-Domain Decision-Making Trainer for Degraded Communication Environments (MoD / DSSC)

App name is shown everywhere as "VYUHA", tagline "Virtual Yuddh-abhyas Under Hampered Awareness".

## Ground rules (apply to every phase)
- TypeScript strict everywhere. No `any`. No `// @ts-ignore`.
- Never leave TODOs, placeholders, mock buttons, or fake data in UI paths. Every button must work.
- After each task run: `pnpm -r typecheck && pnpm -r lint && pnpm -r test && pnpm -r build`. Fix failures before reporting done.
- All socket payloads and API bodies are validated with Zod schemas from `packages/shared`.
- Every async handler has try/catch and sends a typed error; the UI shows loading, empty and error states.
- Keep the engine pure (no I/O, no Date.now, no Math.random) — use the seeded PRNG passed in.
- Work only on the current phase. At the end, summarise files changed and how to test.
- Never remove features to "simplify"; scope is fixed.

## 1. What judges will check

| Required outcome | Typical build | What VYUHA builds |
|---|---|---|
| Scenario engine injecting delay / dropout / conflicting reports | Random timers that hide messages | **Truth vs Perception engine**: one hidden ground-truth world; every player gets a *different*, degraded copy computed from terrain, jamming, channel and role |
| Multiplayer team coordination | Shared chat room | **Information asymmetry**: teammates see different maps and must reconcile them; relayed messages can be corrupted |
| Instructor dashboard | Start/stop + log | **God View** (truth + each player's perception side-by-side), live injects, MSEL timeline, "drift" score |
| Exportable AAR | Event list as PDF | **Ghost Replay AAR**: at each decision show "what you saw" vs "what was true", latency, confidence calibration, rationale — PDF + JSON + CSV |

Extra coverage: quality of judgement under uncertainty, deception (spoofed orders), comms planning (PACE), air-gapped deployment, deterministic replay.

**Real data note**: real military/EW data is classified. VYUHA uses real open geospatial data (OSM tiles, real terrain elevation, real weather) so line-of-sight, movement and visibility are physically grounded, plus doctrinally realistic synthetic events authored as scenario files.

## 2. Feature list
1. Truth/Perception split — ground truth never sent to trainees; server computes per-player `PerceivedState` each tick.
2. Terrain-aware radio — LOS from real elevation grid (Open-Meteo, cached). Hills block VHF; quality drops with distance + jamming.
3. Reliance-adaptive adversary EW — jams the team's most-used channel harder over time.
4. PACE comms plan — Primary/Alternate/Contingency/Emergency (VHF, HF, SATCOM, Runner/Data-link); switching costs latency and bandwidth.
5. Admiralty Code grading (A1–F6) — hidden true reliability; grading accuracy scored.
6. Deception & authentication — spoofed orders; authenticate challenge costs time; acting on unauthenticated spoof is logged.
7. Confidence-tagged decisions — action, confidence 0–100, rationale; AAR computes Brier score.
8. Ghost Replay AAR — timeline scrubber, trainee map vs truth map, decision markers.
9. Picture Drift Meter — missed units, ghost units, position error (m).
10. Deterministic seeded runs — same seed + inputs = identical exercise.
11. MSEL authoring — form UI, JSON import/export.
12. Air-gap ready — `docker compose up` runs locally; tiles/elevation pre-cacheable.
13. Bilingual UI (English / Hindi).

## 3. Tech stack
- pnpm workspaces monorepo
  - `packages/engine` — pure TS simulation, deterministic (`mulberry32`), heavily unit tested.
  - `packages/shared` — Zod schemas, shared types, socket event contracts.
  - `apps/server` — Node 20, Fastify, Socket.IO, Prisma, PostgreSQL.
  - `apps/web` — Vite + React 18 + TS, Tailwind, shadcn/ui, MapLibre GL JS, Zustand, React Router, i18next.
- DB: PostgreSQL 16 (Docker), Prisma.
- Auth: JWT in httpOnly cookie; roles `INSTRUCTOR`, `TRAINEE`; trainees join via 6-char session code.
- Exports: PDF via `@react-pdf/renderer` (server), JSON, CSV.
- Real data: map tiles from OpenFreeMap/OSM (configurable URL); elevation from Open-Meteo Elevation API sampled to a grid and stored in DB; weather from Open-Meteo Forecast stored in DB.
- Tests: Vitest (engine + server), Playwright (one E2E multiplayer test).
- Quality gates: TS `strict`, ESLint, Prettier.

## 4. Architecture
```
Browser (Trainee)    --Socket.IO--+
Browser (Trainee)    --Socket.IO--+--> apps/server
Browser (Instructor) --Socket.IO--+     SessionManager -> packages/engine (tick every 1s)
                                        TruthState -> PerceivedState[player]
                                        Prisma -> PostgreSQL
```
- Server is authoritative; clients never compute truth.
- Sockets join room `session:{id}:player:{playerId}`; instructor joins `session:{id}:instructor`.
- Every state change is an event appended to `SessionEvent` (event sourcing); AAR and replay are rebuilt from events.

## 5. Data model (Prisma)
- `User` (id, name, email, passwordHash, role)
- `Scenario` (id, title, description, areaBounds, seed, msel JSON, initialUnits JSON, paceDefaults JSON, createdById)
- `TerrainGrid` (scenarioId, rows, cols, bbox, elevations Float[])
- `WeatherSnapshot` (scenarioId, visibilityM, precipitationMm, windKph, fetchedAt)
- `Session` (id, scenarioId, code, status LOBBY|RUNNING|PAUSED|ENDED, startedAt, endedAt, degradationProfile JSON)
- `Team` (id, sessionId, name, pacePlan JSON)
- `Player` (id, sessionId, teamId, userId, role PL_CDR|SECTION_CDR|EW_OFFICER|ISR_OPERATOR, unitId)
- `SessionEvent` (id, sessionId, tick, type, payload JSON, visibleTo String[])
- `Decision` (id, sessionId, playerId, tick, actionType, payload JSON, confidence Int, rationale String, perceivedSnapshot JSON, truthSnapshot JSON, latencyMs Int)
- `ReportGrade` (id, playerId, reportId, gradedReliability, gradedCredibility, trueReliability, trueCredibility)

## 6. Engine rules
- Tick = 1 s real time (1x/2x/4x); instructor can pause.
- Units: id, side (BLUE/RED/NEUTRAL), domain (LAND/AIR/CYBER/EW), type, position, heading, speed, strength, status.
- Channels: VHF (LOS, short range), HF (long range, weather-sensitive, low bandwidth), SATCOM (reliable, cyber-attackable, high latency), DATALINK (fast, jammable), RUNNER (never jammed, very slow, moves physically).
- Message delivery A→B over channel C:
  1. `los = lineOfSight(terrain, A.pos, B.pos)` (50 samples)
  2. `quality = baseQuality[C] × distanceFactor × losFactor × (1 − jamming[C]) × weatherFactor[C]`
  3. Seeded PRNG outcome: DELIVERED / DELAYED (delay ∝ 1−quality) / DROPPED / CORRUPTED (numbers/positions mutated).
- Contact reports from sensors (units, drones), each with true reliability (A–F) and credibility (1–6). Lower reliability → position noise, wrong type, or fabricated ghost contact.
- Conflicting reports: engine can emit 2 reports on the same entity with different positions/types.
- Adaptive EW: every 30 ticks compute channel usage share per team; raise `jamming[mostUsedChannel]` by `adaptRate`, decay others.
- Spoof inject: fake HQ order; `authenticate` reveals truth after 15 s.
- Perceived state per player = units seen by own sensors + delivered reports (with errors) + own team's last known positions (with age).
- Metrics: picture drift (missed / ghost / avg position error), decision latency, Brier score, report grading accuracy, channel switch count, spoof-acted count.

## 7. Phases
1 Scaffold · 2 DB/auth/roles + seed · 3 Real geodata ingestion · 4 Simulation engine · 5 Live multiplayer sessions · 6 Trainee UI · 7 Instructor God View · 8 AAR + exports · 9 Hardening + audit · then final PPT-match check. One phase per session; commit after each (`git commit -m "phase N"`).
