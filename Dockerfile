# One image for the whole product: the web app, the API (under /api), the live socket and the database
# migration. It is what render.yaml deploys, and it also runs anywhere Docker does.
FROM node:24-slim AS build
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
# The browser talks to the API at /api on the same address, and uses the bundled offline map.
ENV VITE_API_URL=/api VITE_MAP_MODE=offline
RUN pnpm --filter @vyuha/web build && pnpm --filter @vyuha/server build
# The nginx header file is for the separate web container; here the server sets the headers (helmet).
RUN rm -r apps/web/dist/nginx

FROM node:24-slim
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
# Files stay owned by root, so the running server cannot modify its own code, Prisma engines or migrations.
COPY --from=build /repo /repo
RUN chmod 0755 /repo/apps/server/docker-entrypoint.sh
ENV NODE_ENV=production \
    API_PREFIX=/api \
    WEB_DIST_DIR=/repo/apps/web/dist \
    COOKIE_SECURE=true \
    TRUST_PROXY=1 \
    CHECKPOINT_DISABLE=1 \
    PRISMA_HIDE_UPDATE_MESSAGE=1
# The unprivileged user that ships with the node image (uid 1000).
USER node
# Render sets PORT (10000); locally pass -e PORT=... and publish it.
EXPOSE 10000
CMD ["/repo/apps/server/docker-entrypoint.sh"]
