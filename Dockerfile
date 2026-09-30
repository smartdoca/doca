ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE} AS base

WORKDIR /app
RUN npm install --global pnpm@11.25.0

FROM base AS build

# better-sqlite3 may fall back to node-gyp when the platform's prebuilt
# binary is unavailable. Keep the compiler only in this build stage.
RUN apt-get -o Acquire::Retries=5 update \
    && apt-get -o Acquire::Retries=5 install --yes --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

ARG TARGETARCH
# Keep downloaded tarballs outside the image layers. A source change no longer
# throws them away, and a lockfile change only downloads packages that are new.
RUN pnpm config set store-dir /pnpm/store \
    && pnpm config set fetch-retries 5 \
    && pnpm config set fetch-timeout 120000 \
    && pnpm config set network-concurrency 8

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN --mount=type=cache,id=pnpm-${TARGETARCH},target=/pnpm/store,sharing=locked \
    pnpm fetch --reporter=append-only

# Manifests only, so editing application source does not reinstall dependencies.
# Keep dev dependencies: the server entry point imports vite and uses tsx.
COPY --parents apps/*/package.json packages/*/package.json ./
RUN --mount=type=cache,id=pnpm-${TARGETARCH},target=/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile --offline --reporter=append-only \
    && pnpm config set verify-deps-before-run false

COPY tsconfig.json ./
COPY apps ./apps
COPY packages ./packages
RUN pnpm build

FROM base AS runtime

ENV NODE_ENV=production \
    DOCA_HOST=0.0.0.0 \
    DOCA_PORT=39120 \
    DOCA_DATABASE=sqlite \
    DOCA_DATA_DIR=/data \
    DOCA_SQLITE_PATH=/data/doca.db \
    DOCA_UPLOAD_DIR=/data/uploads

# AI's SQLite file defaults to ai.db alongside DOCA_SQLITE_PATH.
# Supply DOCA_ORIGIN=https://your-domain at runtime, behind an HTTPS proxy.
COPY --from=build /app/package.json /app/tsconfig.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/server ./apps/server
COPY --from=build /app/apps/web/dist ./apps/web/dist

RUN mkdir -p /data/uploads && chown -R node:node /data
USER node

# Mount a persistent volume here for SQLite, AI memory and local uploads.
VOLUME ["/data"]
EXPOSE 39120

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "--input-type=module", "-e", "import http from 'node:http'; http.get('http://127.0.0.1:39120/health', {headers: {host: new URL(process.env.DOCA_ORIGIN).host}}, r => { r.resume(); if (r.statusCode !== 200) process.exit(1) }).on('error', () => process.exit(1))"]

# Start Node directly so it receives container shutdown signals.
CMD ["node", "--import", "tsx", "apps/server/src/main.ts"]
