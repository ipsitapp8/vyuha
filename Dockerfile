# One image for the whole product: the web app, the API (under /api), the live socket and the database
# migration. It is what render.yaml deploys, and it also runs anywhere Docker does.
FROM node:20-slim AS build
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
# The browser talks to the API at /api on the same address, and uses the bundled offline map.
ENV VITE_API_URL=/api VITE_MAP_MODE=offline
RUN pnpm --filter @vyuha/web build && pnpm --filter @vyuha/server build

FROM node:20-slim
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /repo
COPY --from=build /repo /repo
ENV NODE_ENV=production \
    API_PREFIX=/api \
    WEB_DIST_DIR=/repo/apps/web/dist \
    COOKIE_SECURE=true \
    TRUST_PROXY=true
# Render sets PORT (10000); locally pass -e PORT=... and publish it.
EXPOSE 10000
CMD ["sh", "-c", "pnpm --filter @vyuha/server db:deploy && if [ \"$SEED_ON_START\" = \"true\" ]; then pnpm --filter @vyuha/server db:seed; fi && pnpm --filter @vyuha/server start"]
