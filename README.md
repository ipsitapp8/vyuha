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
