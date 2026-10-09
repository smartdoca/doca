# Quick start

[中文](quickstart.zh-CN.md)

This guide installs Doca 0.1.12 on one server with the published Docker image, SQLite, and local file storage. You need Git, Docker Engine, the Docker Compose plugin, and a domain pointing at the server. Production requires HTTPS through a reverse proxy on that server. You do not need Node.js or pnpm to run the image.

This is a fresh installation. Existing deployments must read the [release requirements](releases/0.1.12.md) first: this release rejects older database baselines and provides no automatic migration. Preserve existing databases, files, and configuration.

## 1. Clone the repository

Use the checkout matching the image so Compose and the administrator scripts match the release:

```sh
git clone --branch v0.1.12 --depth 1 https://github.com/smartdoca/doca.git
cd doca
```

## 2. Configure .env

```sh
cp docker.env.example .env
```

Edit `.env`, replacing the example domain with your own HTTPS origin:

```dotenv
DOCA_ORIGIN=https://doca.example.com
DOCA_FILE_STORE_ID=local
DOCA_FILE_STORES_JSON='{"version":1,"stores":{"local":{"provider":"local","root":"/data/storage"}}}'
```

Use only the origin, without a subpath, query, or fragment. A root trailing slash is normalized. Keep `/data/storage` inside the container's persistent volume. `docker.env.example` is for Docker; `.env.example` is for [source development](development.md).

Configure a reverse proxy on the same server. For example, with Caddy:

```caddyfile
doca.example.com {
    reverse_proxy 127.0.0.1:39120
}
```

Caddy terminates TLS and forwards HTTP and WebSocket traffic. DNS must point to this server and the proxy must be able to obtain its certificate. Other proxies must preserve `Host` and forward WebSocket upgrades on `/api/v1/ws`. See [deployment](deployment.md).

## 3. Pull the image

```sh
docker compose pull
```

Compose uses `docker.io/smartdoca/doca:0.1.12`. This step downloads the prebuilt image; it does not build the source checkout.

## 4. Start Doca

```sh
docker compose up -d
docker compose ps
```

Wait for the container to become healthy. The health response is:

```json
{"status":"ok","version":"0.1.12"}
```

If startup fails, inspect `docker compose logs --tail=100 doca`. The Compose port is bound to `127.0.0.1`; browser access uses your HTTPS domain through the proxy.

## 5. Initialize the administrator password

In the same directory as `compose.yaml`, run:

```sh
bash scripts/bootstrap-admin.sh
```

Enter the administrator login, a password of at least 12 characters, and the password again. The current script prompts in Chinese; password input is hidden. Doca has no default account or password. The script runs a one-off container against the same database and stores a password hash. If an administrator already exists, initialization stops without changing that account.

Open `https://doca.example.com` and sign in. Do not put the administrator login or password in `.env`. To recover an existing administrator account, use [password reset](deployment.md#change-a-password).

## Next steps

- Read the [user guide](user-guide.md) to create documents and libraries.
- Review [authentication](authentication.md) before opening registration or configuring SSO.
- Read [configuration](configuration.md), [file storage](storage.md), and [operations](deployment.md) before changing storage or making backups.
- Use [horizontal scaling](horizontal-scaling.md) only when deploying multiple replicas.

SQLite, uploads, plugins, and the AI database use the `doca_data` volume. Preserve it across restarts and include all databases, referenced storage, and protected configuration in backups. `docker compose down -v` deletes that volume and must not be used for an ordinary restart or upgrade.
