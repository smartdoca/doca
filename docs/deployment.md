# Deploy Doca

[中文](deployment.zh-CN.md)

One server can run the published image `docker.io/smartdoca/doca:0.1.5`. A single container uses SQLite and does not need PostgreSQL or Redis. Use those only when you run more than one application replica. See [single instance and horizontal scaling](horizontal-scaling.md).

## Requirements

- Docker Engine and the Docker Compose plugin.
- A DNS name and a TLS certificate for the public site.
- A reverse proxy on the same machine as the container. Compose publishes Doca only on `127.0.0.1:39120`.

The proxy must forward HTTP and the WebSocket path `/api/v1/ws`. Keep the original `Host` header.

## Files

On the server, use a checkout of this repository. The image does not contain `scripts/bootstrap-admin.sh` or `scripts/reset-admin-password.sh`. Those scripts stay on the host and start a one-off container.

```sh
cp docker.env.example .env
```

Edit `.env` before the first start.

## Required setting

`DOCA_ORIGIN` is the origin users type in the browser. Production rejects any value that is not HTTPS. Do not add a path, query, or trailing slash.

```text
DOCA_ORIGIN=https://docs.example.com
```

Leave `DOCA_ASSET_BASE` empty for the published `0.1.0` image. That image was built before asset rewriting existed, so it always serves JavaScript and CSS from the container. A later image reads `DOCA_ASSET_BASE` when you set it. See [Static assets](#static-assets).

## Start

```sh
docker compose pull
docker compose up -d
```

`docker compose up -d` pulls `docker.io/smartdoca/doca:0.1.5`. Add `--build` only when you want an image built from this checkout.

Check the container:

```sh
docker compose ps
curl -fsS http://127.0.0.1:39120/health
```

A healthy process returns `{"status":"ok","version":"0.1.5"}`.

SQLite, uploaded files, and the AI database are stored in the `doca_data` volume. The database must be empty on first start. A non-empty database whose schema is not the current baseline is refused. Do not delete a database that already contains users.

## Reverse proxy

Terminate TLS in Caddy or Nginx on the same host and forward to `127.0.0.1:39120`.

```caddyfile
docs.example.com {
	reverse_proxy 127.0.0.1:39120
}
```

Caddy proxies WebSocket upgrades by default. An Nginx server needs `Upgrade` and `Connection` headers on `/api/v1/ws`.

Do not set `DOCA_TRUST_PROXY` when the proxy connects from this same machine. Requests arrive from the loopback address, which Doca already trusts for forwarded headers.

If a load balancer on another machine connects to this host, publish the container port on the private interface instead of only loopback, and set `DOCA_TRUST_PROXY` to that load balancer's IP range. Do not trust the public internet.

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

Leave it unset to serve JavaScript, CSS, and the other built files from the container at `/assets`. When you set it, use an HTTPS prefix with no userinfo, query, hash, or trailing slash:

```text
DOCA_ASSET_BASE=https://cdn.example.com/doca/0.1.0
```

A page that referenced `/assets/index-abc.js` then loads:

```text
https://cdn.example.com/doca/0.1.0/assets/index-abc.js
```

Publish the whole `apps/web/dist/assets` directory at that prefix and keep the `assets` path segment. The file names include a content hash and must match the HTML inside the same image. API requests remain on `DOCA_ORIGIN`.

An official tag such as `v1.2.3` builds the web app and attaches `doca-web-assets-v1.2.3.tar.gz` to the GitHub Release. Extract it, keep the `assets` directory, and put that directory on a CDN that sends cross-origin headers for ES modules. Do not use a `github.com/.../releases/download` URL as `DOCA_ASSET_BASE`. A push to `main`, or a prerelease tag such as `v1.2.3-rc.1`, does not create that Release.

The container keeps its own `/assets` files. Fonts and images referenced from stylesheets with a root path still load from Doca.

`index.html` is sent with `Cache-Control: no-cache`, so a new visit after a release fetches the new page. Hashed files under `/assets/` are sent with `Cache-Control: public, max-age=31536000, immutable`. Their names change when the content changes, so a year-long cache does not keep an old script after the new HTML is loaded. A CDN in front of `DOCA_ASSET_BASE` needs the same long cache on those hashed files.
