# Deploy without GitHub access

[简体中文](deployment-without-github.zh-CN.md)

The business server does not need a source checkout, Git, Node.js, or pnpm. Install Docker Engine, the Docker Compose plugin, Bash, and OpenSSL beforehand, then transfer deployment files, prepare the image, start Doca, and initialize the administrator. This guide installs Doca 0.2.19 on a fresh single server with SQLite and local file storage. Existing installations must review the [release requirements](releases/0.2.19.md) and preserve their databases, files, configuration, and credential master key.

## 1. Transfer deployment files

Someone with repository access runs this command from the release checkout matching the image:

```sh
node scripts/pack-deployment.mjs
```

Transfer `doca-deploy-v0.2.19.tar.gz` and its `.sha256` checksum through an enterprise file service, an internal download URL, or removable storage. The packer reads only public deployment files and includes no local `.env`, user data, or container image. The official-tag Release workflow also attaches the bundle and checksum; this workflow change takes effect with a new tag and does not backfill existing Releases.

Place both files in the same directory on the business server, verify, and extract:

```sh
sha256sum -c doca-deploy-v0.2.19.tar.gz.sha256
tar -xzf doca-deploy-v0.2.19.tar.gz
cd doca-deploy-v0.2.19
```

On macOS, use `shasum -a 256 -c doca-deploy-v0.2.19.tar.gz.sha256`. Run subsequent deployment commands from this directory:

```text
doca-deploy-v0.2.19/
  compose.yaml
  docker.env.example
  README.zh-CN.md
  README.md
  LICENSE
  docker/
    chromium-seccomp.json
    chromium-seccomp.md
    chromium-seccomp.LICENSE
  scripts/
    bootstrap-admin.sh
    reset-admin-password.sh
```

The bundle derives Compose from the matching release, preserving environment variables, persistent mounts, and Chromium security settings. It removes the source build configuration and uses `pull_policy: missing` so a loaded image needs no registry access. Copying only `compose.yaml` and `.env` is insufficient: include the listed `docker/` and `scripts/` files with their relative paths intact. Transfer the seccomp policy unchanged and keep Chromium sandboxing enabled. The host kernel must also permit user namespaces.

### Copy Compose and .env manually

For a text handoff, save this single-server configuration as `compose.yaml` and have the supplier separately provide the matching `docker/` and `scripts/` files. The bundle includes additional optional settings; this example uses only SQLite and local storage.

```yaml
services:
  doca:
    image: docker.io/smartdoca/doca:0.2.19
    pull_policy: missing
    restart: unless-stopped
    init: true
    security_opt:
      - seccomp=./docker/chromium-seccomp.json
    shm_size: "1gb"
    stop_grace_period: 30s
    environment:
      NODE_ENV: production
      DOCA_ORIGIN: "${DOCA_ORIGIN:?Set DOCA_ORIGIN in .env}"
      DOCA_HOST: 0.0.0.0
      DOCA_PORT: "39120"
      DOCA_DATABASE: sqlite
      DOCA_SQLITE_PATH: /data/doca.db
      DOCA_BOOK_BATCH_CHECKPOINTS: "${DOCA_BOOK_BATCH_CHECKPOINTS-on}"
      DOCA_AI_SQLITE_PATH: /data/ai.db
      DOCA_DATA_DIR: /data
      DOCA_FILE_STORE_ID: "${DOCA_FILE_STORE_ID:?Set DOCA_FILE_STORE_ID in .env}"
      DOCA_FILE_STORES_JSON: "${DOCA_FILE_STORES_JSON:?Set DOCA_FILE_STORES_JSON in .env}"
      DOCA_CREDENTIAL_MASTER_KEY: "${DOCA_CREDENTIAL_MASTER_KEY:?Generate and set the key in .env}"
    ports:
      - "127.0.0.1:39120:39120"
    volumes:
      - doca_data:/data

volumes:
  doca_data:
```

Save the following as `.env`, set the actual browser origin, and fill in the master key generated in the next step:

```dotenv
DOCA_ORIGIN=https://docs.example.com
DOCA_CREDENTIAL_MASTER_KEY=
DOCA_FILE_STORE_ID=local
DOCA_FILE_STORES_JSON='{"version":1,"stores":{"local":{"provider":"local","root":"/data/storage"}}}'
```

## 2. Configure the environment and proxy

For the bundle, run the following; skip copying if you created `.env` manually:

```sh
cp docker.env.example .env
openssl rand -hex 32
chmod 600 .env
```

Write the generated 64-character hexadecimal value to `DOCA_CREDENTIAL_MASTER_KEY`, replacing the public example. Set `DOCA_ORIGIN` to the HTTP(S) origin users will open. Generate the key once, back it up securely and separately, and retain it across restarts. Keep the local storage root at `/data/storage`. Do not put administrator credentials in `.env`.

Compose binds only to `127.0.0.1:39120`, so configure a reverse proxy on the same server. For public HTTPS, Caddy can use:

```caddyfile
docs.example.com {
    reverse_proxy 127.0.0.1:39120
}
```

Point DNS to the server and allow certificate issuance, or use existing enterprise certificates. For a trusted internal network without internet access, set `DOCA_ORIGIN=http://doca.internal`, configure internal DNS or client hosts entries, and use this HTTP proxy without public certificate issuance:

```caddyfile
http://doca.internal {
    reverse_proxy 127.0.0.1:39120
}
```

Other proxies must preserve `Host` and forward HTTP and WebSocket upgrades on `/api/v1/ws`. The business environment must supply Docker, the proxy, and their installation packages beforehand; these are not in the deployment bundle.

## 3. Prepare the image

### Docker Hub is reachable

If GitHub is blocked but Docker Hub is reachable, pull the prebuilt image:

```sh
docker compose pull doca
```

### Registries are also unreachable

The supplier prepares an image archive on a machine with registry access. Confirm the target CPU architecture first. This example uses Linux x86-64 (`linux/amd64`); for ARM64, use `linux/arm64` and label the delivered files accordingly:

```sh
docker pull --platform linux/amd64 docker.io/smartdoca/doca:0.2.19
docker image inspect docker.io/smartdoca/doca:0.2.19 --format '{{.Os}}/{{.Architecture}}'
docker save -o doca-image-v0.2.19-linux-amd64.tar docker.io/smartdoca/doca:0.2.19
sha256sum doca-image-v0.2.19-linux-amd64.tar > doca-image-v0.2.19-linux-amd64.tar.sha256
```

Transfer the image `.tar` and checksum together. From their directory on the business server:

```sh
sha256sum -c doca-image-v0.2.19-linux-amd64.tar.sha256
docker load -i doca-image-v0.2.19-linux-amd64.tar
docker image inspect docker.io/smartdoca/doca:0.2.19 --format '{{.Os}}/{{.Architecture}}'
```

Confirm the loaded tag is `smartdoca/doca:0.2.19` and the architecture matches the target, then return to the deployment directory. An internal registry is another delivery option: the supplier pushes the same release image and the business team changes Compose's `image` to that internal registry address before pulling. Keep the bundle, image, and initialization scripts on the same release.

## 4. Start and initialize the database

After pulling or loading the image, run from the deployment directory:

```sh
docker compose config --quiet
docker compose up -d --pull never --no-build
docker compose ps
```

`--pull never --no-build` uses the local image and fails if it is missing, without attempting an online download or source build. The first startup creates the current database schema and file/AI data directories in the empty `doca_data` volume. No manual SQL or database installation is needed. An existing older database is not upgraded automatically.

Wait for `docker compose ps` to show `healthy`. A manual check must use the Host from `.env`, including any nonstandard port:

```sh
curl -fsS -H 'Host: docs.example.com' http://127.0.0.1:39120/health
```

Expect `{"status":"ok","version":"0.2.19"}`. For the internal example, use `Host: doca.internal`. Bare loopback requests fail Host validation. Inspect startup failures with `docker compose logs --tail=100 doca`.

## 5. Initialize the administrator

After the service is healthy, run in the same deployment directory:

```sh
bash scripts/bootstrap-admin.sh
```

Enter a login, a password of at least 12 characters, and confirm it; password input is hidden. The script starts a one-off container with the prepared image and the same persistent volume. It creates an account only when no administrator exists, and the database stores a password hash. There is no default login or password. Open the configured `DOCA_ORIGIN` and sign in.

To reset an existing administrator password later:

```sh
bash scripts/reset-admin-password.sh
```

This does not create an account. If the database is locked, run `docker compose stop`, reset the password, then `docker compose up -d --pull never --no-build`.

## Preserve data and deliver later releases

Use `docker compose restart` for ordinary restarts. Keep the deployment directory and Compose project name so the same `doca_data` volume is used; changing either can accidentally start a separate empty site. Back up all databases and file storage in the persistent volume, plus the protected `.env` and master key. `docker compose down -v` deletes the volume and must not be used for an ordinary restart or upgrade.

Review the [release requirements](releases/0.2.19.md) before upgrading and deliver a matching bundle and image. This guide initializes fresh sites and does not convert existing data. Password login and local document services need no GitHub access; configured external services for AI, external login, plugin installation, or cloud storage must still be reachable. Verify document rendering on the target host separately: application health does not establish that Chromium's sandbox works. See [Docker document rendering](docker-rendering.md).
