# Configuration

[中文](configuration.zh-CN.md)

Start with `docker.env.example` for Docker or `.env.example` for development. Copy the chosen example to `.env` in the repository root. Compose and the source startup code read this file. Never commit secrets.

## Required Docker settings

| Variable | Purpose | Single-server example |
| --- | --- | --- |
| `DOCA_ORIGIN` | Exact public browser origin; HTTPS in production | `https://doca.example.com` |
| `DOCA_FILE_STORE_ID` | Store receiving new objects | `local` |
| `DOCA_FILE_STORES_JSON` | Version 1 file-store configuration, including physical location and credentials | See below |

```dotenv
DOCA_ORIGIN=https://doca.example.com
DOCA_FILE_STORE_ID=local
DOCA_FILE_STORES_JSON='{"version":1,"stores":{"local":{"provider":"local","root":"/data/storage"}}}'
```

The single quotes protect the JSON as one environment value. Compose mounts the `doca_data` volume at `/data`; do not put persistent files outside that volume without arranging another persistent mount. Store IDs and physical locations must remain stable after writing objects. See [storage](storage.md).

## Optional backends

| Variables | When needed |
| --- | --- |
| `DOCA_DATABASE`, `DOCA_DATABASE_URL` | Select PostgreSQL instead of the default SQLite |
| `DOCA_DATABASE_POOL_MAX` | Limit connections per process; default 10 |
| `DOCA_WEBHOOK_DATABASE_URL` | Explicit PostgreSQL database for webhook deliveries |
| `DOCA_REDIS_URL`, `DOCA_REDIS_PREFIX`, `DOCA_INSTANCE_ID` | Distributed events, presence, and limits |
| `DOCA_TRUST_PROXY` | Trusted proxy IPs/CIDRs when traffic comes from a non-loopback proxy |
| `DOCA_CREDENTIAL_MASTER_KEY` | Plugins requiring `storage.credentials.v1`; 32 bytes encoded as 64 hexadecimal characters |
| `DOCA_PLUGINS_DIR` | Persistent installation/cache directory; container default `/data/plugins` |
| `DOCA_PLUGIN_STORE_URL` | Plugin store HTTPS origin; default `https://store.smartdoca.cc` |
| `DOCA_PLUGIN_NPM_REGISTRY` | Public registry for complete prebuilt plugin packages |
| `DOCA_ASSET_BASE` | Optional HTTPS prefix for the matching built Web assets |

To generate a credential master key, run `openssl rand -hex 32` locally and place the result in the protected deployment configuration. Generate it once, back it up separately, and use the same key on every replica and restart. Do not rotate it by generating another value on startup. Details are in [managed credentials](plugin-credentials.md).

Multiple replicas require shared PostgreSQL, Redis, and file storage. Changing only `DOCA_DATABASE` does not transfer an existing database. Read [horizontal scaling](horizontal-scaling.md) and the [current release requirements](releases/0.1.10.md).

## Administrator settings

The administrator configures registration, identity providers, verification gateways, document search, AI models, and webhook subscriptions through their corresponding administration pages. File backend credentials belong in the environment and the storage page is read-only. Platform service credentials and plugin-managed encrypted credentials have different APIs and storage responsibilities; see [service credentials](service-credentials.md).

## Applying changes

Review `.env` without exposing secrets in logs. `docker compose config --quiet` validates Compose configuration without printing the resolved environment. Apply changes with `docker compose up -d`. This may recreate the application container and does not copy or migrate stored data.

The [deployment guide](deployment.md) covers TLS, administrator recovery, backups, and release changes. [Development](development.md) covers local ports and source-only settings.
