# Doca

[Documentation](https://smartdoca.github.io/doca/#/en/) · [简体中文](README.zh-CN.md)

Doca is an open-source document and knowledge workspace for individuals and small teams. One deployment has one account system.

## Features

- Rich text, Markdown, spreadsheets, slides, and canvas documents, with realtime collaboration and history.
- Knowledge libraries, source curation, Q&A assistants, and a personal AI assistant.
- Personal files and shared folders, with local or S3-compatible storage.
- Invitations, permissions, sharing, comments, notifications, search, and trash.
- Password, OIDC, Google, GitHub, WeChat QR, and QQ sign-in; Chinese and English interface text.
- SQLite for one server; shared PostgreSQL, Redis, and file storage for multiple replicas.
- Business plugins built against the public `@smartdoca/plugin-sdk`.

The default image installs no quick-notes, mail, calendar, membership, or moderation plugins. Templates and materials need a separately installed provider. See [capabilities and limits](https://smartdoca.github.io/doca/#/en/getting-started/features).

## Quick start with Docker

Requires Git, Docker Engine, Docker Compose, and an HTTPS domain served by a reverse proxy. This installs the published 0.1.11 image into a fresh database. Existing installations must read the [release requirements](https://smartdoca.github.io/doca/#/en/releases/0.1.11) and preserve their data before changing versions.

```sh
# 1. Clone the matching release
git clone --branch v0.1.11 --depth 1 https://github.com/smartdoca/doca.git
cd doca

# 2. Configure the environment
cp docker.env.example .env
# Edit .env: set DOCA_ORIGIN to your HTTPS origin.
# Keep the example local file-store configuration for a single server.

# 3. Pull the image
docker compose pull

# 4. Start and check health
docker compose up -d
docker compose ps
# Wait for healthy before initializing the administrator

# 5. Initialize the administrator login and password
bash scripts/bootstrap-admin.sh
```

The password must be at least 12 characters. There is no default account. Compose binds to `127.0.0.1:39120`; configure the HTTPS reverse proxy before browser access. SQLite, files, plugins, and the AI database persist in `doca_data`.

The [complete quick start](https://smartdoca.github.io/doca/#/en/getting-started/quickstart) includes `.env`, the reverse proxy, health checks, administrator recovery, and data preservation.

## Development

Node.js 22.12 or newer and pnpm 11.25.0:

```sh
pnpm install --frozen-lockfile
cp .env.example .env
pnpm dev
```

Open `http://127.0.0.1:39130`. Initialize the administrator with `bash scripts/bootstrap-admin-local.sh`. `pnpm check` runs TypeScript, tests, and the Web build. See [development](https://smartdoca.github.io/doca/#/en/development/development).

## Documentation

- [User guide](https://smartdoca.github.io/doca/#/en/getting-started/user-guide)
- [Deployment and configuration](https://smartdoca.github.io/doca/#/en/operations/deployment)
- [Plugin development](https://smartdoca.github.io/doca/#/en/plugins/plugin-development)
- [HTTP API](https://smartdoca.github.io/doca/#/en/reference/api); the running application also provides `/api/openapi.json`.
- [Release notes](https://smartdoca.github.io/doca/#/en/releases/0.1.11)
- [Documentation source](docs/README.md)

For a documentation preview, run `pnpm docs:dev` and open `http://127.0.0.1:39140/#/en/`. `pnpm docs:check` verifies bilingual coverage and local links. GitHub Pages setup is in [documentation maintenance](docs/documentation.md).

## License

[MIT](LICENSE). The separately published rich text, spreadsheet, Markdown, canvas, and slides editors use the same license.
