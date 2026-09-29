# Doca

**[Official documentation](https://d.smartdoca.cc/#/r/d23f269a-2726-4565-9b7d-51655625ee7e)**

[简体中文](README.zh-CN.md)

Doca is a document and knowledge workspace for a person or a small team. One deployment has one account system. It does not include spaces, organizations, or a parent/child app split.

The published container image is [docker.io/smartdoca/doca](https://hub.docker.com/r/smartdoca/doca).

## Features

- Documents and knowledge libraries, with a library table of contents, private / signed-in / public reading, inherited or custom permissions, invitations, and ownership transfer.
- Editors for rich text ([@smartdoca/slate](https://www.npmjs.com/package/@smartdoca/slate)), Markdown ([@smartdoca/markdown](https://www.npmjs.com/package/@smartdoca/markdown)), spreadsheets ([@smartdoca/sheet](https://www.npmjs.com/package/@smartdoca/sheet)), slides ([@smartdoca/slides](https://www.npmjs.com/package/@smartdoca/slides)), and canvas ([@smartdoca/canvas](https://www.npmjs.com/package/@smartdoca/canvas)). Collaboration uses Yjs, with persistence acknowledgements, snapshots, and reconnect.
- Knowledge curation and knowledge Q&A assistants bound to libraries.
- An AI assistant that can read documents and files the current user is allowed to see, plus quick notes.
- Personal files and shared folders, with local disk or S3-compatible storage and an optional CloudFront URL.
- Comments, likes, favorites, notifications, move, copy, and a trash that restores by batch.
- Search. An administrator can configure Meilisearch; otherwise Doca matches titles and body text in the database.
- Sign-in with a password, OIDC, Google, GitHub, WeChat QR, or QQ. Registration can be closed, automatic, or held for an administrator. There is no default account.
- Chinese and English interface text.
- SQLite for one container. PostgreSQL and Redis are used only when more than one application replica is running. See [horizontal scaling](docs/horizontal-scaling.md).

## Run locally

Node.js 22 or newer and pnpm 11.25.0.

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Open http://127.0.0.1:39130. The API listens on port 39120 and the dev server proxies it. Use `127.0.0.1`, not `localhost`. The first start creates `data/v1/doca.db`.

There is no default administrator. In the project directory:

```sh
bash scripts/bootstrap-admin-local.sh
```

The password must be at least 12 characters. The database stores only a hash.

`pnpm check` runs the typecheck, tests, and web build. `pnpm start` serves the built web app and the API without Vite. Copy `.env.example` to `.env` when the defaults need to change. Do not commit secrets.

## Run with Docker

[Deployment guide](docs/deployment.md) · [中文](docs/deployment.zh-CN.md)

```sh
cp docker.env.example .env
docker compose pull
docker compose up -d
```

Set `DOCA_ORIGIN` in `.env` to the public HTTPS origin, with no path and no trailing slash. Compose publishes the container on `127.0.0.1:39120`. Terminate TLS in a reverse proxy on the same machine and forward HTTP and the WebSocket path `/api/v1/ws`.

```sh
curl -fsS http://127.0.0.1:39120/health
bash scripts/bootstrap-admin.sh
```

A healthy process returns `{"status":"ok","version":"0.1.0"}`. SQLite, uploads, and the AI database stay in the `doca_data` volume. The first database must be empty. Doca refuses a non-empty database whose schema is not the current baseline.

`DOCA_ASSET_BASE` is optional. Leave it empty to serve JavaScript and CSS from the container. When it is set, Doca still returns the HTML and only rewrites `/assets/` URLs in that HTML. The prefix must be HTTPS in production and must allow cross-origin reads of ES modules.

## Plugin development

Business behavior that is not part of the core is a plugin. Doca loads plugins only from `DOCA_PLUGINS_DIR`. When that variable is unset, the directory is `${DOCA_DATA_DIR:-./data}/plugins`. Install built packages there as direct dependencies of that directory's own `package.json`, then restart Doca. The host does not install packages at startup, does not scan transitive dependencies, and does not load plugins from this source tree.

A plugin package points at a static manifest, compiled server JavaScript, and an optional browser bundle:

```json
{
  "name": "@example/attachments",
  "version": "1.0.0",
  "type": "module",
  "doca": {
    "manifest": "./manifest.json",
    "server": "./dist/server.js",
    "web": { "directory": "./web", "entry": "./index.js" }
  }
}
```

```json
{
  "schemaVersion": 1,
  "id": "example.attachments",
  "version": "1.0.0",
  "displayName": "Attachments",
  "sdkRange": "^0.1.0"
}
```

Depend on `@smartdoca/plugin-sdk` and the public service tokens. Do not import `@server/*`, `@core/*`, `@web/*`, `@db/*`, or other host source. The host injects the implementation at runtime.

```ts
import { definePlugin } from "@smartdoca/plugin-sdk";
import { httpServiceToken } from "@smartdoca/plugin-sdk/platform";
import manifest from "../manifest.json" with { type: "json" };

export default () =>
  definePlugin({
    manifest,
    injections: { required: [httpServiceToken] },
    async mount(context) {
      await context.inject(httpServiceToken).register(manifest.id, [
        {
          method: "GET",
          path: "/items",
          async handle() {
            return { items: [] };
          },
        },
      ]);
    },
  });
```

That route is served at `/api/v1/plugins/example.attachments/items` and uses the host session. Register ids under the plugin id. Keep plugin data in the plugin's own database. Disabling a plugin releases runtime resources and does not delete stored user data.

The specification, public services, and verification requirements are in [plugin development](docs/plugin-development.md) and the [plugin SDK contract](docs/plugin-sdk-contract.md). Installation layout is in [plugin deployment](docs/plugin-deployment.md).

## More documentation

- [Architecture](docs/architecture.md)
- [Authentication](docs/authentication.md)
- [Collaboration and search](docs/collaboration.md)
- [Editor integration](docs/editor-integration.md)
- [Storage](docs/storage.md)
- [API](docs/api.md). The running service also publishes `/api/openapi.json`.
- [Development setup](docs/development.md)

## License

Doca is [MIT](LICENSE). You may use, modify, and distribute it, including in commercial products and network services. Copies and substantial portions must keep the copyright notice and the MIT permission notice.

The rich text, spreadsheet, Markdown, canvas, and slides editors use the same license and are published separately on npm.
