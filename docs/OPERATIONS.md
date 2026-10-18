# Operating VYUHA

Everything an operator needs for the Docker Compose stack (`docker-compose.yml`) and the single-image
deployment (`Dockerfile`, `render.yaml`). Design background: `docs/ARCHITECTURE.md`.

## What holds state

| Where | What | Backed up by |
| --- | --- | --- |
| PostgreSQL (`pgdata` volume in Compose) | accounts, scenarios, terrain and weather, sessions, the full event log, decisions, grades, progress metrics | `pg_dump` (below) |
| Server process memory | running exercises, sockets, rate-limit buckets | nothing needed: rebuilt from the event log on start |
| Images | code, migrations, map tiles and fonts | rebuild from the repository |

The event log is the source of truth: a running exercise survives a server restart (`resumeAll` replays its
inputs), and every after action review is rebuilt from it. A database backup is therefore a complete backup.

## Health and monitoring

- `GET /health/ready` (Compose: `http://localhost:4000/health/ready`, single image: `/api/health/ready`):
  200 while the database answers, 503 otherwise. The Compose `server` healthcheck and Render's health check
  use it; the `web` container starts only once the server is ready.
- `GET /health/live`: the process answers. `GET /health`: overview for people, always 200.
- Metrics: set `METRICS_TOKEN` (32+ random characters, `openssl rand -hex 32`) and scrape
  `GET /metrics` with `Authorization: Bearer <METRICS_TOKEN>`. Without the variable the endpoint does not
  exist. It reports counts and timings only (no session ids, codes, names or settings). Worth alerting on:
  `vyuha_db_up 0`, `vyuha_tick_lag_max_seconds` above 1, `vyuha_event_loop_delay_p99_seconds` above 0.2.

```bash
docker compose ps                                    # server shows (healthy) once ready
curl -s localhost:4000/health/ready
curl -s -H "Authorization: Bearer $METRICS_TOKEN" localhost:4000/metrics
```

## Backups

Take them while the stack runs; `pg_dump` gives a consistent snapshot without stopping anything. The custom
format (`-Fc`) is compressed and restores selectively.

```bash
mkdir -p backups
docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' \
  > "backups/vyuha-$(date +%Y%m%d-%H%M%S).dump"
docker compose exec -T db pg_restore --list < backups/<file>.dump | head   # check the file reads back
```

The dump holds password hashes and every exercise's event log: store it like the database itself (access
limited, encrypted at rest, off the machine), and keep at least the last 7 daily copies. A cron entry on the
host is enough, for example `0 2 * * * cd /opt/vyuha && <the pg_dump line>`.

Render: paid PostgreSQL plans have automatic daily backups in the dashboard. On the free plan (deleted
after 30 days) run the same `pg_dump -Fc` from your machine against the database's **External Database
URL** (`pg_dump "<url>?sslmode=require" -Fc > vyuha.dump`).

## Restore

Restoring replaces the database, so stop the server first (sockets and ticks must not write meanwhile).

```bash
docker compose stop server web
docker compose exec -T db sh -c 'dropdb -U "$POSTGRES_USER" --if-exists "$POSTGRES_DB" && createdb -U "$POSTGRES_USER" "$POSTGRES_DB"'
docker compose exec -T db sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --exit-on-error' \
  < backups/<file>.dump
docker compose start server web                      # migrations newer than the dump apply on start
```

To rehearse without touching production, restore into a scratch database
(`createdb -U vyuha restore_check`, then `pg_restore ... -d restore_check`) and drop it afterwards.
Signing in keeps working after a restore, but accounts get the token versions stored in the dump: anyone
who signed out after the backup was taken can be signed in again by an older cookie until they sign out
once more. Rotate `JWT_SECRET` after restoring an old backup if that matters.

## Upgrading a deployment that has sessions from before ownership

The `20261018120000_session_ownership` migration adds `Session.ownerId` and leaves it empty on every
existing session: nobody can know from the old data who ran which exercise, so nothing is assigned
automatically. Until an operator names an owner, such a session is closed to every instructor (lobby,
God View, controls, review and exports all answer 403). Trainees who already joined keep their own
cockpit. A session that was RUNNING keeps ticking after the upgrade (it is resumed from its event log)
and no instructor can pause or end it until it has an owner, so plan the order:

1. **Before upgrading**, back up the database (see Backups) and ask instructors to end or pause running
   exercises. Paused ones stay paused after the upgrade.
2. **Deploy.** Migrations apply on start; existing rows and event logs are kept unchanged.
3. **List the sessions without an owner:**
   `pnpm --filter @vyuha/server sessions:assign-owner -- --list` (id, code, status, date, scenario, trainees).
4. **Map each one to the instructor who ran it**, from your own records (class schedule, who handed out
   the code). Only the owner can later share it with co-instructors, and the script never changes a
   session that already has an owner, so check the email before running it:
   `pnpm --filter @vyuha/server sessions:assign-owner -- --owner <instructor email> --session <id or code>`.
   `--all-unowned` gives every remaining one to a single instructor; use it only when that is correct
   (for example a one-instructor installation).
5. **Verify:** the owner signs in and sees the session under their sessions; `--list` shows none left
   (or only the ones you deliberately left closed). Sessions you cannot attribute can stay ownerless:
   they keep their data, they are just closed until someone is named.

Inside Docker, run the script in the server container (same flags as above):
`docker compose exec -w /repo/apps/server server ./node_modules/.bin/tsx scripts/assign-session-owner.ts --list`

## Routine tasks

| Task | Command |
| --- | --- |
| Apply migrations | automatic on container start; manually `pnpm --filter @vyuha/server db:deploy` |
| Give sessions from before ownership an owner | `pnpm --filter @vyuha/server sessions:assign-owner -- --list`, then `-- --owner <email> --session <id or code>` or `-- --owner <email> --all-unowned` |
| Turn off demo data once real accounts exist | `SEED_ON_START=false` in `.env`, then `docker compose up -d` |
| Sign every user out | rotate `JWT_SECRET` in `.env` and `docker compose up -d` (one user: they press Sign out) |
| Rotate the database password | `docker compose exec db psql -U vyuha -c "\password vyuha"`, put the new value in `.env` as `POSTGRES_PASSWORD`, `docker compose up -d` |
| Follow the logs | `docker compose logs -f server` (cookies and authorization headers are redacted) |

## Limits to keep in mind

- One server process only (see "Single instance" in `docs/ARCHITECTURE.md`); do not scale the service out.
- Rate limits and socket revalidation timers are in memory and reset on restart.
- Signing out is global for that user: every device is signed out.
- Restarting the server pauses nothing permanently, but exercise time does not advance while it is down.
