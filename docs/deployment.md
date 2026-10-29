# Deploy Doca

[中文](deployment.zh-CN.md)

One server can run the image specified by `compose.yaml` on main. A single container uses SQLite and does not need PostgreSQL or Redis. Use those only when you run more than one application replica. See [single instance and horizontal scaling](horizontal-scaling.md).

## Requirements

- Docker Engine and the Docker Compose plugin.
- An HTTP(S) origin reachable by users. Public HTTPS needs DNS and a TLS certificate; trusted internal HTTP is also supported.
- A reverse proxy on the same machine as the container. Compose publishes Doca only on `127.0.0.1:39120`.

The proxy must forward HTTP and the WebSocket path `/api/v1/ws`. Keep the original `Host` header.

## Files

Clone the deployment files from main or transfer the [deployment bundle for servers without GitHub access](deployment-without-github.md). The business server does not need a source checkout. The image does not contain `scripts/bootstrap-admin.sh` or `scripts/reset-admin-password.sh`; those scripts stay on the host and start a one-off container. Include the `docker/chromium-seccomp.json` policy referenced by Compose as well.

```sh
git clone --branch main --depth 1 https://github.com/workhold/doca.git
cd doca
cp docker.env.example .env
```

Edit `.env` before the first start.

## Required settings

File storage also requires `DOCA_FILE_STORE_ID` and `DOCA_FILE_STORES_JSON`, as provided by `docker.env.example`. Backend paths and credentials are read from the environment; the administration page is read-only. See [file storage](storage.md).

The current host uses generation `doca-2026-10-12-book-payload-storage-v1`. Startup automatically aligns released 0.1.22 databases on `doca-2026-10-09-history-storage-v1` through current-DDL review/reconciliation and records the new generation. All old rows remain, including SQL book outcomes; no body conversion, cleanup or old-body adapter is added. Residual old book records can require manual handling. Existing 0.1.23 object data remains. See [database structure evolution](database-schema-evolution.md) and [current release requirements](releases/0.2.24.md). The exact 0.1.13 baseline `doca-2026-10-08-knowledge-books-v2` still needs the explicit history upgrade below. Preserve databases, private objects, configuration and the original credential master key.

`DOCA_ORIGIN` is the origin users type in the browser. HTTP and HTTPS are accepted, including in production. Use only the origin without a subpath, query, or fragment; a root trailing slash is normalized.

```text
DOCA_ORIGIN=https://docs.example.com
```

The Docker example already supplies the required file-store values. For a fresh single server, change the origin, generate a key with `openssl rand -hex 32`, and replace the public sample `DOCA_CREDENTIAL_MASTER_KEY`. The key is required even without plugins; existing deployments must keep their original key. Retain the file-store values; PostgreSQL and Redis are conditional. See [configuration](configuration.md) for defaults, S3 fields, and separate Webhook/AI stores.

## Start

0.1.26 changes plugin storage to one [shared business database](plugin-database-isolation.md), separate from core. On 0.1.25, normally uninstall every external business plugin before stopping all instances. Private business records, credentials and objects are discarded without migration; core data and ordinary files remain. Remove obsolete per-plugin settings, configure one PostgreSQL database/account once (SQLite is automatic), then reinstall and reconfigure plugins. See [0.1.26 upgrade requirements](releases/0.1.26.md).

Stop all old hosts and back up the database before updating. Released 0.1.22 schema aligns automatically on current startup with all existing business rows retained. No manual book command is required. Retained SQL book outcomes are not adapted to the native object format; handle residual records manually as needed. To preserve them as usable outcomes, run the existing optional [lossless conversion](knowledge-book-storage-verification.md) before first startup. Earlier supported generations first complete the history upgrade below. Update all host and web instances together.

### Upgrade from 0.1.13

Stop every Doca instance and back up databases (including SQLite WAL), file storage and configuration. Keep the original `DOCA_CREDENTIAL_MASTER_KEY`. Use the current main deployment files and their matching image. Pull it and run one offline maintenance container with the existing deployment environment:

```sh
docker compose stop
docker compose pull
docker compose run --rm --no-deps doca node --import tsx apps/server/src/bootstrap/history-storage.ts upgrade --apply
```

Only `doca-2026-10-08-knowledge-books-v2` is accepted; the command never creates or resets the database. The transaction adds history archive tables and tasks while preserving all original snapshot bytes. After the new host starts, the latest 20 full snapshots remain in the database. For each group of 10 older snapshots, only the newest is retained in file storage; the other nine are removed after write/read verification and cannot be restored from the application. Storage failure retains the entire original group. History is displayed as one list; incomplete groups remain in the database. See [history storage and rollback](storage.md#history-storage-and-offline-upgrade).

The command first records `doca-2026-10-09-history-storage-v1`; current startup then applies the approved structural alignment to `doca-2026-10-12-book-payload-storage-v1`. The direct history rollback command accepts only the history-storage generation or its interrupted rollback marker, so it cannot undo a database already aligned by the current host. See [history maintenance limits](storage.md#history-storage-and-offline-upgrade) and [book-storage recovery](knowledge-book-storage-verification.md) before any rollback. Preserve later writes and retained file bytes; sampled-away history requires the pre-upgrade backup. Never point an old image directly at a newer database.

```sh
docker compose pull
docker compose up -d
```

`docker compose up -d` pulls the image specified by `compose.yaml`. Add `--build` only when you want an image built from this checkout.

Check the container:

```sh
docker compose ps
curl -fsS -H 'Host: docs.example.com' http://127.0.0.1:39120/health
```

Replace `docs.example.com` with the host in your configured origin, including its port if nonstandard. The built-in container probe already supplies this Host; wait for `docker compose ps` to show `healthy`. A bare loopback curl is rejected with 421.

A healthy process returns `status: "ok"` and the actual image version in `version`.

Document rendering also needs its deployment checks: this checkout adds LibreOffice and sandboxed Chromium, while optional SAM requires a separate trusted Linux runtime. See [Docker document renderers](docker-rendering.md) for component availability, the included Chromium seccomp policy and the explicit SAM mount. A healthy server alone does not verify those tools.

SQLite, uploaded files, and the AI database are stored in the `doca_data` volume. The database must be empty on first start. A non-empty database must use a supported compatibility generation; reviewed additive changes are reconciled automatically, while destructive or semantic differences are reported for review. Do not delete a database that already contains users.

## Reverse proxy

Terminate TLS in Caddy or Nginx on the same host and forward to `127.0.0.1:39120`.

```caddyfile
docs.example.com {
	reverse_proxy 127.0.0.1:39120
}
```

Caddy proxies WebSocket upgrades by default. An Nginx server needs `Upgrade` and `Connection` headers on `/api/v1/ws`.

`DOCA_TRUST_PROXY` is empty by default: no forwarded headers are trusted, including connections from loopback. To preserve client IPs for audit and limits, configure only the proxy IP/CIDR that the application actually sees. A Docker bridge can make a host proxy appear as the bridge gateway rather than `127.0.0.1`; inspect the deployment network before choosing this value. Without it, proxied users may share the proxy IP quota.

If a load balancer on another machine connects to this host, publish the container port on the private interface instead of only loopback, and set `DOCA_TRUST_PROXY` to that load balancer's IP range. Do not trust the public internet.

For a trusted internal HTTP site, set `DOCA_ORIGIN=http://doca.internal` and serve that address through an HTTP reverse proxy. You can also publish the container port on a chosen private interface and include that port in the origin. The supplied Compose mapping binds only to loopback. No development-mode override is needed; keep production mode. HTTP support does not alter Host or Origin validation.

## Create the administrator

There is no default account or password. After the container is healthy, run this in the directory that contains `compose.yaml`:

```sh
bash scripts/bootstrap-admin.sh
```

The script prompts for the login and the password. The password must be at least 12 characters. It is passed only to that one container command. The database stores a hash. If an administrator already exists, the command stops and does not change the current password.

## Change a password

A signed-in user opens `#/account` and chooses **Change password**. The new password must be at least 12 characters. After it is saved, every session for that account is signed out.

When the administrator cannot sign in, reset the existing account from the deployment directory:

```sh
bash scripts/reset-admin-password.sh
```

This does not create an account and it is not available over HTTP. If the database file is locked, run `docker compose stop`, reset the password, then `docker compose up -d`. Do not write the login or password into `.env`.

## Static assets

The HTML page and the API stay on `DOCA_ORIGIN`. `DOCA_ASSET_BASE` changes only `/assets/...` URLs inside that HTML.

The server negotiates Brotli (`br`), gzip, or original bytes using `Accept-Encoding` and sends `Vary: Accept-Encoding`. URLs and built files stay unchanged, including existing build directories. HTML asset URLs are rewritten before compression. The server uses a bounded 32 MiB per-process cache of encoded public static resources; it does not add compressed copies to the image or compress private API/file responses through this route. Proxies/CDNs must preserve encoding negotiation and `Vary`, or handle compression themselves. This affects browser transfers; Docker uses its own image-layer compression and cache.

The built `/cad/` worker files and WASM use the same encoding negotiation and retain `no-cache` because their names are not hashed. Paths outside the declared CAD assets remain unavailable.

Leave it unset to serve JavaScript, CSS, and the other built files from the container at `/assets`. When you set it, use an HTTP(S) prefix with no userinfo, query, hash, or trailing slash:

```text
DOCA_ASSET_BASE=https://cdn.example.com/doca/0.1.11
```

A page that referenced `/assets/index-abc.js` then loads:

```text
https://cdn.example.com/doca/0.1.11/assets/index-abc.js
```

Publish the whole `apps/web/dist/assets` directory at that prefix and keep the `assets` path segment. The file names include a content hash and must match the HTML inside the same image. API requests remain on `DOCA_ORIGIN`.

An official tag such as `v1.2.3` builds the web app and attaches `doca-web-assets-v1.2.3.tar.gz` to the GitHub Release. Extract it, keep the `assets` directory, and put that directory on a CDN that sends cross-origin headers for ES modules. Do not use a `github.com/.../releases/download` URL as `DOCA_ASSET_BASE`. A push to `main`, or a prerelease tag such as `v1.2.3-rc.1`, does not create that Release.

The container keeps its own `/assets` files. Fonts and images referenced from stylesheets with a root path still load from Doca.

`index.html` is sent with `Cache-Control: no-cache`, so a new visit after a release fetches the new page. Hashed files under `/assets/` are sent with `Cache-Control: public, max-age=31536000, immutable`. Their names change when the content changes, so a year-long cache does not keep an old script after the new HTML is loaded. A CDN in front of `DOCA_ASSET_BASE` needs the same long cache on those hashed files.

### Configure static-CDN response headers

`DOCA_ASSET_BASE` changes URLs; it does not configure the CDN. Set uploaded S3 build objects to `Cache-Control: public, max-age=31536000, immutable` and preserve Content-Type (`text/javascript` for JS, `text/css` for CSS). To cover existing objects without changing metadata, attach a CloudFront **Response headers policy** only to the static `*/assets/*` behavior: add that Cache-Control under **Custom headers** with **Override**. Cross-origin ES modules also require `Access-Control-Allow-Origin: https://doca.example.com`; these public build files can use `*` without credentials. Do not attach this policy to HTML, APIs or private files.

Set the static hashed-file **Cache policy** separately: Minimum TTL 0, Default/Maximum TTL 31536000 seconds. A response headers policy changes browser headers, not edge TTL; see [AWS response headers policies](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/modifying-response-headers.html). Publish new filenames and retain older releases for later chunk loads in already-open pages.

A static Nginx CDN can serve a release directory as follows, with standard `mime.types` loaded by the server:

```nginx
location /doca/0.2.12/assets/ {
    alias /srv/doca/0.2.12/assets/;
    add_header Cache-Control "public, max-age=31536000, immutable";
    add_header Access-Control-Allow-Origin "https://doca.example.com";
}
```

When proxying Doca `/assets/`, hide the existing origin header with `proxy_hide_header Cache-Control;` before adding its replacement. The example omits `always` so missing files do not receive a year-long 404 cache. Check the final CDN response:

```sh
curl -I https://cdn.example.com/doca/0.2.12/assets/<actual-hashed-JS-filename>.js
```

Verify Cache-Control, Content-Type and CORS. HTML stays on Doca with revalidation. For document images and protected files, use [storage: browser image caching and the file CDN](storage.md#browser-image-caching-and-the-file-cdn).

## Knowledge-book payload conversion

0.1.25 aligns the supported old generation through ordinary schema comparison, retaining all business data without automatic book cleanup or runtime body adapters. Existing target-generation objects remain unchanged. The existing [optional lossless procedure](knowledge-book-storage-verification.md) must run before first startup if old SQL outcomes must remain usable. Interrupted conversions still require their original manifest. Preserve all data and later writes when restoring backups; update every host and web build together.
