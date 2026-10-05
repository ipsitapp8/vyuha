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

The demo accounts are created on first start. Their password is a random value Render generated, not a
published one: open the `vyuha` service, go to **Environment** and read `SEED_PASSWORD`.

| Account                                              | Portal           |
| ---------------------------------------------------- | ---------------- |
| `instructor@vyuha.local`                             | Instructor login |
| `trainee1@vyuha.local` to `trainee6@vyuha.local`     | Trainee login    |

Anyone can also create their own trainee account on the Trainee login page. Instructor accounts are
never self-registered.

`SEED_PASSWORD` is only used when an account is first created. Changing it later does not change the
password of an account that already exists.

## Settings

Set by the Blueprint or the image, so you normally touch none of them:

| Variable          | Value on Render                          | Purpose                                                       |
| ----------------- | ---------------------------------------- | ------------------------------------------------------------- |
| `DATABASE_URL`    | from `vyuha-db`                          | PostgreSQL connection                                         |
| `JWT_SECRET`      | generated                                | signs the sign-in cookie                                      |
| `SEED_PASSWORD`   | generated                                | password of the demo accounts                                 |
| `SEED_ON_START`   | `true`                                   | adds the demo accounts and Op Silent Ridge when missing       |
| `RENDER_EXTERNAL_URL` | provided by Render                   | used as the allowed origin, so `CORS_ORIGIN` need not be set  |
| `API_PREFIX`      | `/api` (image)                           | API address under the web app                                 |
| `WEB_DIST_DIR`    | `/repo/apps/web/dist` (image)            | folder the server serves as the web app                       |
| `COOKIE_SECURE`   | `true` (image)                           | sign-in cookie only over https                                |
| `TRUST_PROXY`     | `true` (image)                           | rate limits count each visitor, not Render's proxy            |

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
  -e DATABASE_URL="postgresql://vyuha:vyuha_dev_password@host.docker.internal:5432/vyuha" \
  -e JWT_SECRET="$(openssl rand -hex 32)" \
  -e RENDER_EXTERNAL_URL="http://localhost:10000" -e SEED_ON_START=true vyuha
```

Then open http://localhost:10000.
