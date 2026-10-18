# Deploying VYUHA on Render

`render.yaml` in the repository root is a Render Blueprint. It creates:

| Resource       | What it is                                                                                  |
| -------------- | ------------------------------------------------------------------------------------------- |
| `vyuha`        | One Docker web service: the web app, the API (under `/api`) and the live socket together.   |
| `vyuha-db`     | A PostgreSQL database, connected to the service automatically.                              |

Everything is served from one address, so the sign-in cookie is an ordinary same-site cookie and
there is no cross-origin set-up to get wrong. The map works without any outside service: the exercise
area tiles, fonts and sprites are inside the image.

## Steps

1. Make sure the latest code is on GitHub (`git push origin main`).
2. In the Render dashboard choose **New +, then Blueprint**, connect your GitHub account and pick this
   repository. Render reads `render.yaml` and shows the service and the database. Choose **Apply**.
3. Wait for the first build (several minutes: it installs, builds the web app and the server, then
   migrates and seeds the database on start). The service is ready when its status shows **Live**.
4. Open the service address (`https://vyuha-xxxx.onrender.com`) and choose **Instructor login** or
   **Trainee login**.

## Sign-in details

The demo accounts are created on first start, and both sign-in pages show their email and password in a
**Demo access** box so a visitor is never stuck. The password is `SEED_PASSWORD` (`Vyuha@123` in
`render.yaml`). With `SEED_RESET_PASSWORDS=true` every start sets the demo accounts back to it, so an account
created by an earlier deploy with a different password works again.

This is meant for a public prototype: anyone can sign in as the demo instructor. Production only accepts
the published password because `render.yaml` sets `DEMO_MODE=true`, the explicit opt-in; the server logs a
warning on every start while it is on, and without it the server refuses to start with that password. For a
real deployment remove `DEMO_MODE` and `SEED_RESET_PASSWORDS`, set `SEED_PASSWORD` to a generated value
(`generateValue: true`, 12+ characters), and build the web app with `VITE_SHOW_DEMO_LOGIN=false` to hide the
box.

| Account                                              | Portal           |
| ---------------------------------------------------- | ---------------- |
| `instructor@vyuha.local`                             | Instructor login |
| `trainee1@vyuha.local` to `trainee6@vyuha.local`     | Trainee login    |

Anyone can also create their own trainee account on the Trainee login page. Instructor accounts are
never self-registered.

Without `SEED_RESET_PASSWORDS`, `SEED_PASSWORD` is only used when an account is first created: changing it
later does not change the password of an account that already exists.

## Settings

Set by the Blueprint or the image, so you normally touch none of them:

| Variable          | Value on Render                          | Purpose                                                       |
| ----------------- | ---------------------------------------- | ------------------------------------------------------------- |
| `DATABASE_URL`    | from `vyuha-db`                          | PostgreSQL connection                                         |
| `JWT_SECRET`      | generated                                | signs the sign-in cookie                                      |
| `DEMO_MODE`       | `true`                                   | explicit opt-in to a public demo with the published password  |
| `SEED_PASSWORD`   | `Vyuha@123`                              | password of the demo accounts (shown on the sign-in pages)    |
| `SEED_RESET_PASSWORDS` | `true`                              | sets the demo accounts back to `SEED_PASSWORD` on every start |
| `SEED_ON_START`   | `true`                                   | adds the demo accounts and Op Silent Ridge when missing       |
| `RENDER_EXTERNAL_URL` | provided by Render                   | used as the allowed origin, so `CORS_ORIGIN` need not be set  |
| `API_PREFIX`      | `/api` (image)                           | API address under the web app                                 |
| `WEB_DIST_DIR`    | `/repo/apps/web/dist` (image)            | folder the server serves as the web app                       |
| `COOKIE_SECURE`   | `true` (image)                           | sign-in cookie only over https                                |
| `TRUST_PROXY`     | `1` (image)                              | proxy hops in front of the server; see "Client addresses" below |

## Client addresses (verify after the first deploy)

Sign-in and registration are rate limited per visitor address. Behind Render the server reads that address
from `X-Forwarded-For`, counting `TRUST_PROXY` entries from the right (the ones Render's proxies appended);
anything further left was written by the client and is ignored, so a forged header cannot mint new
addresses. Render does not document how many entries its proxies append (a Render staff reply in
[this thread](https://feedback.render.com/features/p/send-the-correct-xforwardedfor) says the real client
address is the first one, while a user test there showed client-sent values are kept, not replaced), so
the image assumes one and you should confirm it:

1. From your own machine note your public address (`curl -s https://ifconfig.me`).
2. `curl -s -H 'X-Forwarded-For: 192.0.2.99' https://<your-service>.onrender.com/api/health`
3. In the service **Logs**, find that request's `remoteAddress`:
   - your own public address: correct, nothing to do;
   - a Render or Cloudflare address (the same for everyone): set `TRUST_PROXY=2`, redeploy, repeat;
   - `192.0.2.99`: the value is too high (the forged entry was trusted); lower it.

A value that is too low never lets a client bypass the limits, it only groups visitors who share a proxy
address. Login is also limited per account and registration has a server-wide budget, neither of which
depends on addresses.

## Things to know on the free plan

Check Render's current free-plan terms before relying on them. At the time of writing:

- A free web service **goes to sleep after about 15 minutes without traffic**. The first visit after
  that takes up to a minute while it wakes. An exercise that was running resumes when the service
  starts again, but it does not advance while the service is asleep, so keep it awake during a session.
- A free PostgreSQL database **expires after 30 days**. Export what you need, or move to a paid
  database for anything you want to keep.
- The service has little memory (512 MB). A handful of simultaneous trainees is fine; a large class
  needs a paid plan.

## Adding the demo progress history

`pnpm demo:history` plays three real sessions with scripted bot trainees. Run it from your computer
against the Render database: copy the database's **External Database URL** from the Render dashboard
and run

```bash
DATABASE_URL="<external url>?sslmode=require" JWT_SECRET="any-32-characters-or-more-here!!" \
CORS_ORIGIN="http://localhost" pnpm demo:history
```

## If something goes wrong

- **Build fails:** read the build log on the service's **Events** tab; it is the same build as
  `docker build .` run locally.
- **Service stays "Deploying":** the health check is `/api/health`. Open the **Logs** tab; the most
  common cause is a database that is still starting, which fixes itself on the next attempt.
- **Sign-in says too many attempts:** sign-ins are limited per visitor; wait a minute.
- **A page shows the sign-in again after reload:** the sign-in cookie needs https. Use the
  `https://` address Render shows, not `http://`.

## Running the same image locally

```bash
docker build -t vyuha .
docker run --rm -p 10000:10000 -e PORT=10000 -e COOKIE_SECURE=false \
  -e DATABASE_URL="postgresql://vyuha:<POSTGRES_PASSWORD>@host.docker.internal:5432/vyuha" \
  -e JWT_SECRET="$(openssl rand -hex 32)" -e SEED_PASSWORD="$(openssl rand -hex 16)" \
  -e RENDER_EXTERNAL_URL="http://localhost:10000" -e SEED_ON_START=true --read-only --tmpfs /tmp vyuha
```

The image runs as the unprivileged `node` user. In production it refuses to start with the placeholder
`JWT_SECRET`, an empty or published database password, or a demo account that still accepts the
published demo password; the seed refuses to run without a strong `SEED_PASSWORD`. The database on
your machine must be reachable from the container (for example started with `pnpm db:up`).

Then open http://localhost:10000.
