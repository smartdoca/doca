FROM node:24-bookworm-slim AS base

WORKDIR /app
RUN npm install --global pnpm@11.25.0

FROM base AS build

# better-sqlite3 may fall back to node-gyp when the platform's prebuilt
# binary is unavailable. Keep the compiler only in this build stage.
RUN apt-get -o Acquire::Retries=5 update \
    && apt-get -o Acquire::Retries=5 install --yes --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY vendor ./vendor
RUN test -f vendor/eppt-editor-0.3.0-alpha.1-5b6cc25660ca.tgz \
    && test -f vendor/online-office-univer-sheet-0.2.0-rc.15-a82c0d180779.tgz \
    && test -f vendor/aidcanvas-0.4.1-ebf7d8848977.tgz \
    && test -f vendor/exmd-collaborative-editor-0.4.2-c92c0ac78baf.tgz \
    && test -f vendor/slatetsx-kit-editor-0.4.1-91a49985bf15.tgz
# Keep dev dependencies: the current server entry point imports vite and uses tsx.
RUN pnpm install --frozen-lockfile \
    --fetch-retries=5 \
    --fetch-timeout=120000 \
    --network-concurrency=8 \
    --reporter=append-only

COPY tsconfig.json ./
COPY apps ./apps
COPY packages ./packages
RUN pnpm build

FROM base AS runtime

ENV NODE_ENV=production \
    DOCA_HOST=0.0.0.0 \
    DOCA_PORT=39120 \
    DOCA_DATABASE=sqlite \
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
  CMD ["node", "--input-type=module", "-e", "fetch('http://127.0.0.1:39120/health').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"]

# Start Node directly so it receives container shutdown signals.
CMD ["node", "--import", "tsx", "apps/server/src/main.ts"]
