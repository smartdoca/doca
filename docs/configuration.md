# Configuration

[中文](configuration.zh-CN.md)

Choose `docker.env.example` for Compose and `.env.example` for source development, then copy it to the repository-root `.env`. They use different origins and database paths; both show `/data/storage` for the container's persistent file volume. For source development, change the storage root to an absolute writable directory on your machine. Do not interchange origins or commit secrets.

## Required Compose settings

| Variable | Requirement | Single-server example |
| --- | --- | --- |
| `DOCA_ORIGIN` | Must be explicitly set as an HTTP(S) origin | `https://doca.example.com` |
| `DOCA_FILE_STORE_ID` | Must be nonempty; must identify a store in the JSON | `local` |
| `DOCA_FILE_STORES_JSON` | Must be nonempty; valid version 1 configuration with physical backend | See below |
| `DOCA_CREDENTIAL_MASTER_KEY` | Required at every startup; exactly 64 hexadecimal characters (32 bytes) | Generate with `openssl rand -hex 32` |

```dotenv
DOCA_ORIGIN=https://doca.example.com
DOCA_FILE_STORE_ID=local
DOCA_FILE_STORES_JSON='{"version":1,"stores":{"local":{"provider":"local","root":"/data/storage"}}}'
```

For a new single-server installation, **change the public origin and replace the public example credential key** with the output of `openssl rand -hex 32`; the required file-store values are already supplied. PostgreSQL, Redis, model keys, and SSO credentials are conditional. Existing deployments must keep their original master key.

Use an HTTP(S) origin without credentials, subpaths, query, or fragment. A root trailing slash is normalized. Production accepts both HTTP and HTTPS. The proxy preserves the configured `Host`; a request addressed only to `127.0.0.1` fails the Host check. See [health checks](deployment.md#start).

## Defaults depend on the entry point

| Entry point | Origin | Database / files | Credential master key |
| --- | --- | --- | --- |
| Repository Compose | Required in `.env` | SQLite `/data/doca.db`; file ID/JSON required in `.env`; `doca_data` mounted at `/data` | Required; use the persistent deployment key |
| Published image without Compose | Must supply an HTTP(S) origin | Image explicitly supplies SQLite and local storage defaults under `/data`; mount persistent `/data` yourself | Required; use the persistent deployment key |
| Source development | `http://127.0.0.1:39130` | SQLite `./data/v1/doca.db`; file ID/JSON required, supplied by `.env.example` | Required; replace the public example key |

The source file-store parser has no implicit default; the image defaults are explicit Dockerfile environment values. Local storage requires a writable persistent root. S3 requires `bucket`, `region`, boolean `forcePathStyle`, and explicit `credentials:{accessKeyId,secretAccessKey,sessionToken?}`. An optional endpoint must be an HTTP(S) root origin without credentials, a subpath, query, or fragment. Explicit HTTP endpoints support trusted internal object storage such as RustFS; the operator controls network access, and site, asset and CDN origins also accept HTTP(S). AWS shell credentials do not replace these JSON fields. See [file storage](storage.md) for a RustFS configuration example.

Store IDs and physical locations must remain available after objects are written. The configured current store ID must match the recorded active ID; editing the ID, path, or bucket does not move data. Do not change these values as a migration shortcut.

## Conditional settings and optional backends

| Variables | When needed / default |
| --- | --- |
| `DOCA_DATABASE=postgres`, `DOCA_DATABASE_URL` | PostgreSQL selection requires its URL; default database is SQLite |
| `DOCA_DATABASE_POOL_MAX` | Main database connections per process; default 10 |
| `DOCA_WEBHOOK_DATABASE_URL` | Optional explicit PostgreSQL delivery database; otherwise derived as described below |
| `DOCA_REDIS_URL` | Required for cross-instance events, presence, and rate limits; unset uses process-local implementations |
| `DOCA_REDIS_PREFIX`, `DOCA_INSTANCE_ID` | Prefix defaults to `doca`; instance ID defaults to a random process ID |
| `DOCA_TRUST_PROXY` | Comma-separated trusted proxy IPs/CIDRs; **no proxy is trusted by default**, including loopback |
| `DOCA_PLUGINS_DIR` | Writable installation/cache directory; Compose defaults to `/data/plugins` |
| `DOCA_PDF_CHROMIUM` | Optional Chromium executable for rich-text/Markdown PDF export; otherwise install the matching Playwright browser. The sandbox stays enabled |
| `DOCA_PLUGIN_STORE_URL` | HTTP(S) origin; default `https://store.smartdoca.cc` |
| `DOCA_PLUGIN_NPM_REGISTRY` | Prebuilt-package registry; default `https://registry.npmjs.org` |
| `DOCA_ASSET_BASE` | Optional built-asset prefix; empty serves `/assets` from Doca |
| `DOCA_AI_IMAGE_MAX_ATTEMPTS_PER_PAGE` | Submitted paid image requests per source page; default 5 when unset. A positive safe decimal integer is required; 0, empty or malformed values fail startup |
| `DOCA_AI_IMAGE_SEGMENT_PROFILE` | Optional absolute path to a trusted, strict version 1 local SAM2 profile; unset disables segmentation. Malformed explicit configuration fails startup; an unavailable verified runtime does not expose the tool. See [local segmentation](ai-image-segmentation.md) |

Image request limits are fixed when the server starts. For example, set `DOCA_AI_IMAGE_MAX_ATTEMPTS_PER_PAGE=10` in the source or Compose `.env` and restart the server or recreate the container. All replicas must use the same limit. Retrying, resuming, changing prompts or re-registering a batch does not clear accumulated attempts. Pending or uncertain submitted requests count; reference exports and local recomposition do not. Existing images, request records and usage remain untouched. Lowering the limit rejects further paid requests, including reuse of a paid-attempt receipt whose ordinal now exceeds the limit; it never skips or converts those records. Batch version 3 and paid-attempt version 1 remain unchanged; older batch formats are still rejected without migration.

A missing, empty or malformed master key rejects startup, including deployments without plugins. The runtime has no default key. The public example value in the example files must be replaced for a fresh installation. Generate one once with `openssl rand -hex 32`, back it up separately, and use the same key on every replica/restart. See [managed credentials](plugin-credentials.md).

Webhook delivery always uses a separate database. SQLite creates `webhooks.db` beside the main database. PostgreSQL defaults to `<main_database>_webhooks`; a missing database triggers a creation attempt. If the account lacks database-creation privileges, pre-create that dedicated database and grant access, or set `DOCA_WEBHOOK_DATABASE_URL` to an accessible dedicated database. The AI store uses `ai.db` in Compose and the `doca_ai` schema in the main PostgreSQL database; PostgreSQL permissions must allow its initialization. These stores need backups even when no external AI model is configured.

Multiple replicas require shared PostgreSQL, Redis, and file storage. Changing a variable does not transfer existing data. Read [horizontal scaling](horizontal-scaling.md) and [release requirements](releases/0.1.10.md).

## Passing environment variables through Compose

`.env` supplies Compose interpolation; it does not automatically forward every variable to the container. Only settings declared in `compose.yaml` reach the service. Container bind address, port, SQLite/AI paths, and data directory are fixed in the current file. Change its environment, port mappings, and persistent mounts together when customizing those values.

Additional environment variables must be forwarded explicitly in the Compose service environment and configured in the deployment directory’s `.env`.

## Administrator settings and applying changes

Registration, identity providers, verification gateways, search, AI models, and webhook subscriptions use their administration pages. File backend credentials stay in the environment; the storage page is read-only. Platform service credentials and plugin encrypted credentials are separate services; see [service credentials](service-credentials.md).

`docker compose config --quiet` validates interpolation without printing resolved secrets. It does not validate application JSON, reach databases, or prove cloud credentials work. Restart with `docker compose up -d`, inspect logs and health, then exercise configured services. See [deployment](deployment.md) and [development](development.md).

## Login lifetime

`DOCA_SESSION_TTL_SECONDS` controls browser, QR-login and WebView sessions, including the database expiry and session cookie `Max-Age`. The default is `86400` seconds (24 hours). `DOCA_MOBILE_SESSION_TTL_SECONDS` controls mobile bearer sessions and their existing renewal flow; the default is `15552000` seconds (180 days). Both accept decimal integers from 1 to 2147483647. Empty, zero, negative or malformed values refuse startup. Compose explicitly passes both variables.

```dotenv
DOCA_SESSION_TTL_SECONDS=86400
DOCA_MOBILE_SESSION_TTL_SECONDS=15552000
```

Restart to apply deployment changes. Already issued browser sessions retain their stored expiry; new logins use the new lifetime, and mobile renewals use the configured mobile lifetime. No session rows or persisted formats are converted. Session and authentication-flow cookies use `Secure` on HTTPS, while HTTP keeps `HttpOnly` and the existing SameSite policy. HTTP sites use `ws` for realtime connections.

The approved HTTP browser adapter supplies UUID v4 through `crypto.getRandomValues` when `crypto.randomUUID` is missing, and supplies only SHA-256 `crypto.subtle.digest` through pinned `@noble/hashes` when `crypto.subtle` is missing. Native implementations stay in use when present. The digest matches native bytes; existing IDs, spreadsheet checksums and document formats are not converted. This does not provide other WebCrypto operations.

Text-copy buttons use one shared helper. It uses native Clipboard when available; otherwise the approved HTTP adapter copies through a temporary textarea and `document.execCommand("copy")`, restores focus and selection, and reports failures. It never reads the system clipboard or treats a failed copy as success.
