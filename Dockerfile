ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE} AS base

WORKDIR /app
ARG DOCA_NPM_REGISTRY=https://registry.npmjs.org
RUN npm install --global pnpm@11.25.0 --registry "${DOCA_NPM_REGISTRY}" \
    && pnpm config set registry "${DOCA_NPM_REGISTRY}"

FROM base AS build

# better-sqlite3 may fall back to node-gyp when the platform's prebuilt
# binary is unavailable. Keep the compiler only in this build stage.
ARG DOCA_APT_MIRROR=deb.debian.org
RUN sed -i "s|deb.debian.org|${DOCA_APT_MIRROR}|g" /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::Retries=5 update \
    && apt-get -o Acquire::Retries=5 install --yes --no-install-recommends ca-certificates \
    && sed -i 's|http://|https://|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::Retries=5 update \
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
COPY patches ./patches
RUN --mount=type=cache,id=pnpm-${TARGETARCH},target=/pnpm/store,sharing=locked \
    pnpm fetch --reporter=append-only

# Manifests only, so editing application source does not reinstall dependencies.
# The web build needs the full workspace install, including dev dependencies.
# The runtime stage keeps only modules the production server loads.
COPY --parents apps/*/package.json packages/*/package.json ./
RUN --mount=type=cache,id=pnpm-${TARGETARCH},target=/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile --prefer-offline --reporter=append-only \
    && pnpm config set verify-deps-before-run false

COPY tsconfig.json ./
COPY apps ./apps
COPY packages ./packages
COPY docker/prune-runtime-modules.mjs docker/prune-runtime-build-inputs.mjs docker/split-runtime-modules.mjs docker/split-runtime-web.mjs ./docker/
RUN pnpm build \
    && node docker/prune-runtime-modules.mjs --apply /app \
    && node docker/prune-runtime-build-inputs.mjs --apply /app \
    && node docker/split-runtime-modules.mjs /app \
    && node docker/split-runtime-web.mjs /app

FROM ${NODE_IMAGE} AS render-runtime

WORKDIR /app

ENV NODE_ENV=production \
    DOCA_HOST=0.0.0.0 \
    DOCA_PORT=39120 \
    DOCA_DATABASE=sqlite \
    DOCA_DATA_DIR=/data \
    DOCA_SQLITE_PATH=/data/doca.db \
    DOCA_FILE_STORE_ID=local \
    DOCA_PDF_PYTHON=/opt/doca-pdf/bin/python \
    DOCA_OFFICE_RENDERER=/usr/bin/soffice \
    DOCA_FILE_STORES_JSON="{\"version\":1,\"stores\":{\"local\":{\"provider\":\"local\",\"root\":\"/data/storage\"}}}"

COPY docker/pdf-requirements.txt /tmp/doca-pdf-requirements.txt
ARG DOCA_APT_MIRROR=deb.debian.org
ARG DOCA_PYPI_INDEX=https://pypi.org/simple
RUN sed -i "s|deb.debian.org|${DOCA_APT_MIRROR}|g" /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::Retries=5 update \
    && apt-get -o Acquire::Retries=5 install --yes --no-install-recommends ca-certificates \
    && sed -i 's|http://|https://|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::Retries=5 update \
    && apt-get -o Acquire::Retries=5 install --yes --no-install-recommends \
      python3 python3-venv libpango-1.0-0 libpangoft2-1.0-0 libharfbuzz-subset0 \
      fonts-noto-cjk fonts-liberation \
      libreoffice-writer libreoffice-calc libreoffice-impress libreoffice-math \
    && python3 -m venv /opt/doca-pdf \
    && /opt/doca-pdf/bin/pip install --no-cache-dir --index-url "${DOCA_PYPI_INDEX}" -r /tmp/doca-pdf-requirements.txt \
    && rm -rf /var/lib/apt/lists/* /tmp/doca-pdf-requirements.txt

RUN mkdir -p /data/storage && chown -R node:node /data
USER node

# Rendering dependencies are cached independently from application source.
FROM render-runtime AS runtime

# AI's SQLite file defaults to ai.db alongside DOCA_SQLITE_PATH.
# Supply the browser-facing HTTP(S) DOCA_ORIGIN at runtime, behind a proxy.
COPY --link --from=build /app/package.json /app/tsconfig.json ./
COPY --link --from=build /app/artifacts/runtime-layers/common/node_modules ./node_modules
COPY --link --from=build /app/artifacts/runtime-layers/canvas/node_modules ./node_modules
COPY --link --from=build /app/artifacts/runtime-layers/markdown/node_modules ./node_modules
COPY --link --from=build /app/artifacts/runtime-layers/sheet/node_modules ./node_modules
COPY --link --from=build /app/artifacts/runtime-layers/slate/node_modules ./node_modules
COPY --link --from=build /app/artifacts/runtime-layers/slides/node_modules ./node_modules
COPY --link --from=build /app/artifacts/runtime-layers/metadata/node_modules ./node_modules
COPY --link --from=build /app/packages ./packages
COPY --link --from=build /app/apps/server ./apps/server
COPY --link docker/admin.sh ./docker/admin.sh
COPY --link --from=build /app/apps/browser-extension ./apps/browser-extension
COPY --link --from=build /app/artifacts/runtime-web-layers/cad ./apps/web/dist
COPY --link --from=build /app/artifacts/runtime-web-layers/fonts ./apps/web/dist
COPY --link --from=build /app/artifacts/runtime-web-layers/large-00 ./apps/web/dist
COPY --link --from=build /app/artifacts/runtime-web-layers/large-01 ./apps/web/dist
COPY --link --from=build /app/artifacts/runtime-web-layers/large-02 ./apps/web/dist
COPY --link --from=build /app/artifacts/runtime-web-layers/large-03 ./apps/web/dist
COPY --link --from=build /app/artifacts/runtime-web-layers/large-04 ./apps/web/dist
COPY --link --from=build /app/artifacts/runtime-web-layers/large-05 ./apps/web/dist
COPY --link --from=build /app/artifacts/runtime-web-layers/large-06 ./apps/web/dist
COPY --link --from=build /app/artifacts/runtime-web-layers/large-07 ./apps/web/dist
COPY --link --from=build /app/artifacts/runtime-web-layers/code-00 ./apps/web/dist
COPY --link --from=build /app/artifacts/runtime-web-layers/code-01 ./apps/web/dist
COPY --link --from=build /app/artifacts/runtime-web-layers/code-02 ./apps/web/dist
COPY --link --from=build /app/artifacts/runtime-web-layers/code-03 ./apps/web/dist
COPY --link --from=build /app/artifacts/runtime-web-layers/code-04 ./apps/web/dist
COPY --link --from=build /app/artifacts/runtime-web-layers/code-05 ./apps/web/dist
COPY --link --from=build /app/artifacts/runtime-web-layers/code-06 ./apps/web/dist
COPY --link --from=build /app/artifacts/runtime-web-layers/code-07 ./apps/web/dist
COPY --link --from=build /app/artifacts/runtime-web-layers/code-08 ./apps/web/dist
COPY --link --from=build /app/artifacts/runtime-web-layers/code-09 ./apps/web/dist
COPY --link --from=build /app/artifacts/runtime-web-layers/code-0a ./apps/web/dist
COPY --link --from=build /app/artifacts/runtime-web-layers/code-0b ./apps/web/dist
COPY --link --from=build /app/artifacts/runtime-web-layers/code-0c ./apps/web/dist
COPY --link --from=build /app/artifacts/runtime-web-layers/code-0d ./apps/web/dist
COPY --link --from=build /app/artifacts/runtime-web-layers/code-0e ./apps/web/dist
COPY --link --from=build /app/artifacts/runtime-web-layers/code-0f ./apps/web/dist
COPY --link --from=build /app/artifacts/runtime-web-layers/entry ./apps/web/dist


# Mount a persistent volume here for SQLite, AI memory and local file storage.
VOLUME ["/data"]
EXPOSE 39120

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "--input-type=module", "-e", "import http from 'node:http'; http.get('http://127.0.0.1:39120/health', {headers: {host: new URL(process.env.DOCA_ORIGIN).host}}, r => { r.resume(); if (r.statusCode !== 200) process.exit(1) }).on('error', () => process.exit(1))"]

# Start Node directly so it receives container shutdown signals.
CMD ["node", "--import", "tsx", "apps/server/src/main.ts"]
