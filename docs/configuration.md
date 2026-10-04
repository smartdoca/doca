# Configuration

[中文](configuration.zh-CN.md)

Choose `docker.env.example` for Compose and `.env.example` for source development, then copy it to the repository-root `.env`. They use different origins and physical paths. Do not interchange them or commit secrets.

## Required Compose settings

| Variable | Requirement | Single-server example |
| --- | --- | --- |
| `DOCA_ORIGIN` | Must be explicitly set; production requires HTTPS | `https://doca.example.com` |
| `DOCA_FILE_STORE_ID` | Must be nonempty; must identify a store in the JSON | `local` |
| `DOCA_FILE_STORES_JSON` | Must be nonempty; valid version 1 configuration with physical backend | See below |

```dotenv
DOCA_ORIGIN=https://doca.example.com
DOCA_FILE_STORE_ID=local
DOCA_FILE_STORES_JSON='{"version":1,"stores":{"local":{"provider":"local","root":"/data/storage"}}}'
```

For a new single-server installation, **only the public origin needs changing in the Docker example**; the other two required values are already supplied. PostgreSQL, Redis, model keys, SSO credentials, and a plugin credential master key are unnecessary for core startup. Optional features need their own configuration.

Use an HTTP(S) origin without credentials, subpaths, query, or fragment. A root trailing slash is normalized. Production rejects HTTP. The proxy preserves the configured `Host`; a request addressed only to `127.0.0.1` fails the Host check. See [health checks](deployment.md#start).

## Defaults depend on the entry point

| Entry point | Origin | Database / files | Credential master key |
| --- | --- | --- | --- |
| Repository Compose | Required in `.env` | SQLite `/data/doca.db`; file ID/JSON required in `.env`; `doca_data` mounted at `/data` | Empty is valid for core startup |
| Published image without Compose | Must supply HTTPS origin | Image explicitly supplies SQLite and local storage defaults under `/data`; mount persistent `/data` yourself | Optional until a plugin requires credentials |
| Source development | `http://127.0.0.1:39130` | SQLite `./data/v1/doca.db`; file ID/JSON required, supplied by `.env.example` | Optional |

The source file-store parser has no implicit default; the image defaults are explicit Dockerfile environment values. Local storage requires a writable persistent root. S3 requires `bucket`, `region`, boolean `forcePathStyle`, and explicit `credentials:{accessKeyId,secretAccessKey,sessionToken?}`. An optional endpoint must be an HTTPS root origin. AWS shell credentials do not replace these JSON fields. See [file storage](storage.md).

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
| `DOCA_CREDENTIAL_MASTER_KEY` | Required only for plugins that require `storage.credentials.v1`; exactly 64 hexadecimal characters (32 bytes) |
| `DOCA_PLUGINS_DIR` | Writable installation/cache directory; Compose defaults to `/data/plugins` |
| `DOCA_PLUGIN_STORE_URL` | HTTPS origin; default `https://store.smartdoca.cc` |
| `DOCA_PLUGIN_NPM_REGISTRY` | Prebuilt-package registry; default `https://registry.npmjs.org` |
| `DOCA_ASSET_BASE` | Optional built-asset prefix; empty serves `/assets` from Doca |

Without a master key, core services start and the credential service is absent; a plugin declaring it as a required injection cannot activate. A supplied malformed key fails startup. Generate one once with `openssl rand -hex 32`, back it up separately, and use the same key on every replica/restart. See [managed credentials](plugin-credentials.md).

Webhook delivery always uses a separate database. SQLite creates `webhooks.db` beside the main database. PostgreSQL defaults to `<main_database>_webhooks`; a missing database triggers a creation attempt. If the account lacks database-creation privileges, pre-create that dedicated database and grant access, or set `DOCA_WEBHOOK_DATABASE_URL` to an accessible dedicated database. The AI store uses `ai.db` in Compose and the `doca_ai` schema in the main PostgreSQL database; PostgreSQL permissions must allow its initialization. These stores need backups even when no external AI model is configured.

Multiple replicas require shared PostgreSQL, Redis, and file storage. Changing a variable does not transfer existing data. Read [horizontal scaling](horizontal-scaling.md) and [release requirements](releases/0.1.10.md).

## Administrator settings and applying changes

Registration, identity providers, verification gateways, search, AI models, and webhook subscriptions use their administration pages. File backend credentials stay in the environment; the storage page is read-only. Platform service credentials and plugin encrypted credentials are separate services; see [service credentials](service-credentials.md).

`docker compose config --quiet` validates interpolation without printing resolved secrets. It does not validate application JSON, reach databases, or prove cloud credentials work. Restart with `docker compose up -d`, inspect logs and health, then exercise configured services. See [deployment](deployment.md) and [development](development.md).
