FROM node:24-slim AS build
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @vyuha/server build

FROM node:24-slim
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
# Files stay owned by root, so the running server cannot modify its own code, Prisma engines or migrations.
COPY --from=build /repo /repo
RUN chmod 0755 /repo/apps/server/docker-entrypoint.sh
ENV NODE_ENV=production \
    CHECKPOINT_DISABLE=1 \
    PRISMA_HIDE_UPDATE_MESSAGE=1
# The unprivileged user that ships with the node image (uid 1000).
USER node
EXPOSE 4000
CMD ["/repo/apps/server/docker-entrypoint.sh"]
