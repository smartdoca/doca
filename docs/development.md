# Development, deployment, and checks

[中文](development.zh-CN.md)

## Start locally

Node.js 22.12 or newer, or Node.js 24 LTS, and pnpm 11. Versions are locked in `pnpm-lock.yaml`. The `better-sqlite3` native build is allowed in `pnpm-workspace.yaml`.

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Open http://127.0.0.1:39130. The API listens on 39120 and the dev server proxies it on the same origin. Opening 39120 directly, or using `localhost` instead of `127.0.0.1`, does not match the configuration.

The defaults run as they are. Copy `.env.example` to `.env` when you need to change them. Do not commit secrets.

## Create the administrator

There is no default account. In the project directory:

```sh
bash scripts/bootstrap-admin-local.sh
```

The script passes the login and password only to that command. The database stores a hash.

Container deployment is in [Deploy Doca](deployment.md), including the reverse proxy, `DOCA_ORIGIN`, the first administrator, and password reset.

## Reset an administrator password

If the administrator still has a verified phone or email, use the code on the sign-in page. Otherwise use the local recovery command on the deployment machine. It accepts only an existing administrator. It does not create one, and it is not exposed over HTTP:

```zsh
read "DOCA_RESET_ADMIN_LOGIN?Administrator login: "
read -s "DOCA_RESET_ADMIN_PASSWORD?New password (at least 12 characters): "
export DOCA_RESET_ADMIN_LOGIN DOCA_RESET_ADMIN_PASSWORD
pnpm admin:reset-password
unset DOCA_RESET_ADMIN_LOGIN DOCA_RESET_ADMIN_PASSWORD
```

The command checks that the account is an enabled administrator, updates the password, and revokes every session. PostgreSQL needs `DOCA_DATABASE_URL` in the same environment. SQLite uses `DOCA_SQLITE_PATH`. Do not write the recovery secret into `.env`, shell history, or the image.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| DOCA_ORIGIN | http://127.0.0.1:39130 | The only browser origin. Production uses an HTTPS name |
| DOCA_HOST | 127.0.0.1 | Bind address |
| DOCA_PORT | 39120 | API and published server port |
| DOCA_WEB_PORT | 39130 | Dev web port |
| DOCA_DATABASE | sqlite | sqlite or postgres |
| DOCA_SQLITE_PATH | ./data/v1/doca.db | The current database file |
| DOCA_DATABASE_URL | none | PostgreSQL URL for a dedicated new database |
| NODE_ENV | unset | production requires an HTTPS origin and disables dev |
| DOCA_ASSET_BASE | empty | HTTPS prefix for built assets. Empty serves `/assets` locally |

## Static asset URLs

Production HTML always comes from Doca, and the API uses that same origin. `DOCA_ASSET_BASE` only rewrites `/assets/...` URLs inside the HTML.

When it is unset, the container serves JS, CSS, and other build files from `/assets`. When it is set, those HTML URLs use the prefix, for example `https://cdn.example.com/doca/0.1.0/assets/index-abc.js`. The prefix is an HTTP(S) URL with no userinfo, query, or hash. Production requires HTTPS. `/assets` remains in the container. Fonts and images referenced from CSS with a root path still come back to Doca.

An official tag such as `v1.2.3` makes GitHub Actions build the web app and create a Release. The attachment is `doca-web-assets-v1.2.3.tar.gz`. Keep the `assets` directory after unpacking, and set `DOCA_ASSET_BASE` to an HTTPS prefix that contains it. A prerelease tag such as `v1.2.3-rc.1` does not create a Release. A push to `main` does not either. Do not use `github.com/.../releases/download` as `DOCA_ASSET_BASE`. That URL redirects and does not send cross-origin headers for ES modules. Put the unpacked `assets` directory on a CDN or object store that allows cross-origin script reads.

## Production process

```sh
pnpm check
NODE_ENV=production DOCA_ORIGIN=https://docs.example.com pnpm start
```

`check` runs the typecheck, tests, and web build. `start` serves the built web app and the API without Vite. Replace the example name, terminate TLS in a reverse proxy, keep Host and Origin, and forward `DOCA_PORT`.

The server does not trust arbitrary `X-Forwarded-*` headers. Loopback is trusted by default. Authentication rate limits use the connection IP, so users behind one proxy can share a quota. A production proxy must be configured as trusted. Do not turn on `trustProxy` for the public internet.

## AI job logs

The production container writes Fastify access logs and background AI job errors to stdout:

```sh
docker compose ps
docker compose logs -f --tail=200 doca
```

To keep AI failures:

```sh
docker compose logs --since=30m doca | grep -E "AI job failed|AI 工作流|模型|图片"
```

With Docker alone, replace `doca` with the container name. On Kubernetes, read the pod stdout with `kubectl logs`. The browser session API returns `jobs[].id`, `jobs[].status`, and `jobs[].error`. Match that job id to `AI job failed`. Logs record a redacted error class. They do not print model keys or the full prompt.

This is a runnable development baseline, not a finished production acceptance. Account recovery, acting as an OIDC provider, full security audit and monitoring, and large-query tuning are still open. External OIDC and social sign-in adapters exist. Live credentials are in [authentication](authentication.md). Boundaries are in [architecture](architecture.md).

## Data protection

- The database is created from the current baseline. The default path is `data/v1/doca.db`.
- Static files are only `apps/web/dist`. `.archive`, `data`, and `.env` are not public.
- Startup creates the current schema. If that fails, the server does not listen. Back up and test restore before production.
- An offline SQLite backup stops every writer, then copies the whole directory. An online backup uses the backup API. Copying the main file and skipping the WAL is not a backup.
- PostgreSQL uses its own backup and restore. Disaster recovery is the operator's job.
- SIGINT and SIGTERM close HTTP, Vite, and the database. Production uses a process manager to restart.

## Checks

Collaboration work starts from `skills/doca-collaboration/SKILL.md`. `AGENTS.md` states when it applies. Interface language is `docs/i18n.md`.

`docs/collaboration-sdk-contract.md` is the contract source. Publishing the skill refreshes `references/contract.md`. A proposed API in the contract is not an export the current package already has. After a package update, install the new artifact, check exports and schema, and verify save acknowledgement, reconnect, recovery of existing data, and live selections. Changing the version number is not enough.

```sh
pnpm typecheck
pnpm test
pnpm build
```

`tests/cloud.test.ts` uses a temporary SQLite database and temporary accounts, then deletes that directory. It does not touch a real user database.

Coverage includes private isolation, including administrators, public reading, inheritance and hidden ancestors, version conflicts, ownership transfer, tree cycles, move resetting grants, batch restore, independent copy, comment permissions, idempotent reactions, notification isolation, Host and Origin, registration and disable, session revocation, restart persistence, and OpenAPI routes.

Login, home, opening a document from search, visit records, and admin statistics have been checked in a local browser. A full browser end-to-end suite, real PostgreSQL, keyboard accessibility, HTTPS rate limits, load, and long-running acceptance are still required. Passing on SQLite does not replace them.
