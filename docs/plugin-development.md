# Plugin development

Updated 2026-10-01 for host image 0.1.1 and public SDK 0.1.2. This is the primary development guide, including current content, native and installation contracts. Linked documents provide full protocols and historical acceptance records. Any compatibility adapter, old-format conversion or database migration requires prior agreement with the project owner.

[中文](plugin-development.zh-CN.md)

The full target, including parts that are not implemented, is the [SDK contract](plugin-sdk-contract.md). Do not keep obsolete membership, moderation, or source-loading compatibility layers.

## License

Doca and the public plugin SDK are [MIT](../LICENSE). A plugin may be open source or proprietary. See [Licensing](../LICENSING.md).

Do not ship a dependency whose license is unknown, forbids redistribution, or conflicts with how you publish the plugin. Third-party notices stay the plugin author's obligation. Doca's license does not cover third-party material the author cannot license.

## Install and start

Install a complete prebuilt ZIP through Admin → Plugins, or drop a `<plugin-id>/` release directory into `DOCA_PLUGINS_DIR` while stopped. Restart each instance. The shared database holds desired selection and full archives; instance-local caches synchronize automatically at startup. There is no npm installation-directory compatibility path. See the [store protocol](plugin-store-protocol.md) and [deployment guide](plugin-deployment.md).

```json
{
  "name": "@example/attachments",
  "version": "1.0.0",
  "type": "module",
  "doca": {
    "dataVersion": "1",
    "manifest": "./manifest.json",
    "server": "./dist/server.js",
    "web": { "directory": "./web", "entry": "./index.js" }
  }
}
```

`manifest.json` is static JSON. Its version matches `package.json`:

```json
{
  "schemaVersion": 1,
  "id": "example.attachments",
  "version": "1.0.0",
  "displayName": "Attachments",
  "sdkRange": "^0.1.2",
  "dependencies": [{ "id": "doca.files", "range": "^0.1.0" }]
}
```

Only compiled JavaScript is loaded. Bundle or vendor the complete dependency closure as real files. No install scripts, registry fetching or host compilation run. Paths stay inside the package root. `doca.dataVersion` is required and stays identical for v1 upgrades; plugin initialization checks the actual business schema.

## SDK and host services

Depend on the public contract. Do not import `@server/*`, `@core/*`, `@web/*`, `@db/*`, sibling Doca source, or a global bridge. Service ids are stable across installations. The host injects the implementation.

```ts
import { definePlugin } from "@smartdoca/plugin-sdk";
import { filesServiceToken } from "@smartdoca/plugin-sdk/files";
import { httpServiceToken, usersServiceToken } from "@smartdoca/plugin-sdk/platform";
import manifest from "../manifest.json" with { type: "json" };

export default () =>
  definePlugin({
    manifest,
    injections: {
      required: [filesServiceToken, httpServiceToken, usersServiceToken],
    },
    async mount(context) {
      const files = context.inject(filesServiceToken);
      const users = context.inject(usersServiceToken);
      await context.inject(httpServiceToken).register(manifest.id, [
        {
          method: "GET",
          path: "/folders",
          async handle(request) {
            const user = await users.get(request, request.principal.id);
            const folders = await files.folders.list(
              { principalId: request.principal.id, signal: request.signal },
              { parentId: null },
            );
            return { user, folders };
          },
        },
      ]);
    },
  });
```

That route is `/api/v1/plugins/example.attachments/folders`. Identity comes from the host session. File operations check permission again. Store a stable file id and an owner binding, not a local disk path. `users.get` returns the signed-in user, or a user an administrator is allowed to read, including contact information and custom profile fields. It does not return a password hash or authentication secrets. Trim the browser response to what the screen needs.

## Public services

| Import | Service | Use |
| --- | --- | --- |
| plugin-sdk/files | filesServiceToken | Folders, files, upload, content, bindings, and access |
| plugin-sdk/platform | usersServiceToken | The authorized user's profile and unified user search |
| plugin-sdk/platform | permissionsServiceToken | Register business-resource authorization and relationship sources |
| plugin-sdk/platform | httpServiceToken | Authenticated routes in the plugin's own namespace |
| plugin-sdk/platform | policiesServiceToken | Admission before create, store, share, transfer, and AI calls |
| plugin-sdk/platform | eventsServiceToken | Read the durable event stream, including `ai.usage.recorded` |
| plugin-sdk/platform | notificationsServiceToken | Publish and withdraw notifications idempotently |
| plugin-sdk/ai | aiServiceToken | Register AI tools with a JSON Schema and skill manuals |
| plugin-sdk/content | contentServiceToken | Unified inventory, read, resolve, optional search and knowledge sources |
| plugin-sdk/platform | activityServiceToken | Plugin-owned recent visits, host aggregation and authorization |
| plugin-sdk/search | searchServiceToken | Projection, rebuild and authorized index queries |

A registration id starts with the plugin id and a dot. The route namespace equals the plugin id. These registrations follow the plugin lifecycle and are released if the plugin stops or fails to start. Timers and connections you create yourself still use `context.effect` or `effectAsync`. Stopping does not delete persisted data.

A directory source returns relationships that are currently valid. The host applies the administrator's all, related, or none policy and filters to valid users. A source error does not widen visibility. Searchable does not mean readable. Sources use `schemaVersion: 1`, paged `related`, and a current-fact `verify`. The plugin maintains its own relationship index. Paging, timeouts, and candidate rechecks are in the [mail handoff](plugin-mail-handoff.md).

Register an AI tool with `aiServiceToken.registerTool`: id, description, inputSchema, and execute. execute receives the authenticated user, sessionId, turnId, jobId, callId, and signal. It cannot bypass file permissions. `registerSkill` takes id, name, description, content, and formats. The manual enters the host skill library. A business tool checks its own resource permissions and stores a stable operation id in the plugin database so a retry does not repeat a side effect. callId correlates a call. Do not assume a new call reuses an old callId. Creating a file or folder passes a stable `idempotencyKey`. An upload also passes the `contentIdentity` returned by `uploads.complete`. Read a durable receipt with `files.receipts.get`. pending can be retried. Different parameters are 409. A deleted result cannot be rebuilt by replaying. The full protocol is section 7.1 of the [SDK contract](plugin-sdk-contract.md).

Doca does not include membership, prices, points, or business quotas. Model input and output rates, and tokens per image, convert a vendor's raw usage into tokens. They are not a price. Usage distinguishes an unconfirmed call from actual metrics. `ai.usage.recorded` is written inside the settlement transaction. Top-level `metrics` are the rated usage. `provider.metrics` keeps the vendor's raw facts. A plugin pulls events with `events.read(cursor, limit)`, stores its cursor, and handles each event id once. A policy check can refuse a call. Cross-plugin reservation, failure compensation, and money consistency do not yet have a full transaction protocol. One check is not a billing implementation.

The plugin owns its database, credentials, business jobs, and outbox. The host does not offer data.v1 or data.v2. Use initialize, mount, ready, and dispose. The database must match the declared data version; compatible existing data is accepted. A mismatched schema refuses to start.

## Web

The optional web build default-exports `async host => bundle`. `host` provides React, apiBase, useEnvironment, navigate, toast, confirm, request, and FilePicker. React comes from the host so there is one renderer. Other dependencies are bundled. The host does not resolve bare npm imports. The bundle follows `WebPluginBundle` exported by `@smartdoca/plugin-sdk/web`. `manifest.pluginId` and version match the server. Pages, navigation, admin, and settings contributions are supported.

The host serves the declared directory at `/api/v1/plugin-assets/{id}/{version}/` and loads registrations before startup. Load errors are isolated and logged. Server package files are not exposed. Contribution render has an error boundary. A generic tree slot is not finished.

## Build and verify

In the host repository, `pnpm build:plugin-sdk` builds the SDK, contracts, and file capability JavaScript and `.d.ts`. The published packages are `@smartdoca/plugin-sdk` and the contract packages it re-exports. `publishConfig` points at `dist`. Plugin installs depend on those npm artifacts, not on this repository's source.

At least verify a standalone install, startup with no plugins, dependency conflicts, cross-user denial, version conflicts, idempotent calls, revoked relationships, isolation of two host instances, and cleanup on shutdown. Tests use their own database, users, and documents. Interface copy follows [interface languages](i18n.md). Editors follow [editor integration](editor-integration.md) and the [collaboration contract](collaboration-sdk-contract.md).

HTTP callbacks, attachment binding, user calibration, search and knowledge, and the mobile boundary are in the [mail handoff](plugin-mail-handoff.md).

## Scope and delivery

`search.v1` provides projection and authorized index queries. New unified content, global content retrieval and knowledge subscriptions use `content.v1` below. Plugins own business data and current permissions; the host owns explicit subscriptions, scheduling, block fingerprints and derived-content access checks.

Acceptance installs a real host build, the SDK, and the business plugin tarball outside this repository. Prepare the full dependency closure. Do not depend on a source link, an undeclared cache, or a registry fetch during install or startup. Verify web assets, the business flow, revocation, retry, and restart. Building the SDK is not end-to-end acceptance.

Disable, uninstall, and data retention are fixed at first delivery. A plugin database must match its declared data version. A mismatch refuses startup. There is no upgrade or downgrade script. A user-deletion protocol is not available. The dynamic mobile WebView contract is documented in the mail integration v1 guide. The default data directory and job status do not let the host read the plugin database.

## Background identity checks and notifications

`users.status(userId)` returns `{id, status}` or null for a trusted server job. Stop business work when the status is not active. An active account does not mean the user can read a business resource.

`notificationsServiceToken` exports `notifications.v1`: `publish(pluginId, {recipientId, key, title, body, path, resource: {type, id}})` and `withdraw(pluginId, {recipientId, key})`. The host allows only the plugin's own pluginId. `key` is non-empty and at most 200 characters, isolated per plugin and recipient. Replaying the same parameters returns the same `{id}`. Different parameters return 409. A withdrawn key returns 410. The plugin's outbox publishes before it withdraws.

The resource type is registered in permissions.v1 and implements `notification.read`. Publish, list, unread count, and click recheck current permission. A missing, disabled, failed, or timed-out source is denied. Title and body are plain text, at most 200 and 2000 characters. `path` is an in-app path such as `/mail/<id>?message=...`, with no origin and no hash. The link passes a host authorization endpoint before navigation. The plugin page and API still authorize themselves.

Publishing on this instance refreshes the web app immediately. The web app reconciles other instances every 30 seconds. These are in-app notifications. They are not SMTP, mobile push, or desktop notifications.

HTTP registration limits the body to 1 MiB by default. A route that needs a larger body, such as an attachment, may set `bodyLimit` in bytes, at most 32 MiB. The plugin still checks attachment count, decoded size, and business totals.

## Recent activity

`activityServiceToken` from `@smartdoca/plugin-sdk/platform` exposes `activity.v1`. Plugins register paginated recent-activity sources and own visit storage, deletion cleanup, and business authorization. The host merges sources, renders their labels/icons, and rechecks `activity.read` before display and opening. Declare the required service; an older host without it refuses the plugin instead of adapting private storage. See the [integration contract and example](plugin-activity.md).

## Unified content: reading, search and knowledge subscriptions

Use `@smartdoca/plugin-sdk@^0.1.2`. Import `contentServiceToken` and the `ContentSource` type from `@smartdoca/plugin-sdk/content`; declare the token in `injections.required` and register the source during mount. Sources belong to the registering plugin. Built-in documents and files use the same contract.

| Member | Contract |
| --- | --- |
| Declaration | `id`, `pluginId`, `version: 1`, localized `title`, `contentTypes`, `purposes`, `capabilities: {search}`, `configSchema` |
| `list(ctx, {config, cursor, limit})` | Required. Return `{items, nextCursor, snapshot}`. Each item contains `ref: {sourceId, resourceId, blockId}`, `fingerprint`, `title`, optional `order`, `anchor`, `excerpt`; do not return full bodies here. |
| `read(ctx, {config, ref, fingerprint})` | Required. Recheck permission and return the item plus `text`, or null when unavailable. A changed fingerprint is a conflict, never new text under an old fingerprint. |
| `resolve(ctx, ref)` | Required. Recheck access and return `{path, fingerprint}` or null. `path` is a current in-app location. |
| `search(ctx, {config, cursor, limit, query})` | Optional; declare and implement together. Return a lightweight page. Unsupported search does not fall back to a full scan. |

`ctx` contains the authenticated `principalId`, `purpose` (`knowledge`, `analysis`, or `search`) and cancellation `signal`. The provider enforces current business permission on every call. A source supporting analysis can serve a future to-do plugin without a mail-specific API. Consumers use `sources(ctx, purpose)`, then service `list/read/search` with `sourceId` and `purpose`; service `resolve` takes `{ref, purpose}`. Only request a purpose declared by that source.

Pagination starts and ends with null. All pages in a traversal must share a consistent snapshot; fail on expiry rather than silently continuing with different data. This cursor is for paginating the full authorized inventory, not a durable change log. `listChanges` and `readChanges` are not required or exported by this contract. The source may sync its business system internally, but Doca does not require that implementation.

Knowledge uses the existing subscription and scheduling system. A user explicitly selects the source, library and configuration. The host stores references and block fingerprints, compares the complete inventory, and reads/analyzes only new or changed blocks. It does not keep an extra full source-body mirror. Unchanged blocks do not need to be read again. Only a complete, consistent inventory may establish removal; failed or partial runs do not acknowledge it. Stable block identity must not depend on a document's whole revision or positional paragraph index.

On deletion, unbinding, revocation or an unavailable source, derived knowledge is withheld from new normal reads, lists, search and answer retrieval; content is retained for administrator handling, including manually edited results. Already delivered content and an already open collaboration connection are not retroactively revoked by this check. The configuration UI supports primitive fields, enums and string arrays; complex configuration belongs in the plugin's own UI. This integration adds no database schema migration, dual read/write or old-source adapter. The SDK still exports `knowledge.sources.v1`, but it is not the subscription entry for new integrations and is not automatically adapted to `content.v1`.

Limits: 100 inventory items/page, 100,000 items/traversal, 2 million characters/body, 120,000 changed-body characters/analysis run and a 20-second source-call deadline. Oversized or incomplete work fails explicitly; do not truncate it and call it complete. HTTP endpoints are `/api/v1/content/sources` and `/api/v1/content/{list,read,resolve,search}`. See [exact protocol and limits](plugin-content.md) for request shapes and subscription routes.

## Native cache and attachments

Use the same Web bundle on Web and in the scoped mobile WebView. `PluginWebHost` from `@smartdoca/plugin-sdk/web` exposes `native`, which is null on Web. Native types are exported from `@smartdoca/plugin-sdk/native`.

- `native.storage` supplies `get`, `set`, `remove`, `clear`; string values are isolated by server, signed-in user and plugin. Limits are 2 million characters/value and 20 million/plugin. Logout or account removal clears the account's cache. Plugins opt in; IndexedDB is not migrated and offline cold start is not promised.
- `native.attachments.save/share({path, name, mime})` downloads a relative plugin-API path through authenticated native dispatch. Native credentials never enter the WebView. Redirects are refused and size is limited to 32 MiB; temporary files are cleaned up.
- Android save returns completed/canceled. iOS save and system sharing may report presented, which does not prove a user completed the action. Account switching or page disposal cancels outstanding requests.
- Mail account binding belongs on Web. Native OAuth is outside this delivery.

SDK 0.1.2 is published. Host tests and builds do not replace independent mail-package integration or iOS/Android device acceptance; those remain pending. See [native protocol](plugin-native.md).

## Distribution and navigation

A complete npm tgz is used for store publication or exact package/version installation in Plugins → Settings. Local upload takes a ZIP with package.json at its root, not a tgz. Both contain compiled artifacts and the full runtime dependency closure; the host does not run npm install or package scripts. Install, upgrade, disable and uninstall take effect after each instance restarts; uninstall retains business data.

Global navigation has Web user, App user and Web administrator scopes. Declare page purpose and platforms; never offer a user page as an administrator page. Plugin pages are labeled by origin, and an entry should not appear in both the sidebar and More. See [distribution, WebView and navigation](plugin-mail-integration-v1.md) and [store protocol](plugin-store-protocol.md).
