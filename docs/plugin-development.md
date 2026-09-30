# Plugin development


> 2026-09-30：npm 分发、动态 App 页面与可配置导航的新增对接说明见 [邮箱插件对接手册 v1](plugin-mail-integration-v1.md)，远端 API 以 [商城协议 v1](plugin-store-protocol.md) 为准。移动端已增加受限会话与 WebView 页面，尚待真机及独立邮箱包联调。

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
  "sdkRange": "^0.1.0",
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

A registration id starts with the plugin id and a dot. The route namespace equals the plugin id. These registrations follow the plugin lifecycle and are released if the plugin stops or fails to start. Timers and connections you create yourself still use `context.effect` or `effectAsync`. Stopping does not delete persisted data.

A directory source returns relationships that are currently valid. The host applies the administrator's all, related, or none policy and filters to valid users. A source error does not widen visibility. Searchable does not mean readable. Sources use `schemaVersion: 1`, paged `related`, and a current-fact `verify`. The plugin maintains its own relationship index. Paging, timeouts, and candidate rechecks are in the [mail handoff](plugin-mail-handoff.md).

Register an AI tool with `aiServiceToken.registerTool`: id, description, inputSchema, and execute. execute receives the authenticated user, sessionId, turnId, jobId, callId, and signal. It cannot bypass file permissions. `registerSkill` takes id, name, description, content, and formats. The manual enters the host skill library. A business tool checks its own resource permissions and stores a stable operation id in the plugin database so a retry does not repeat a side effect. callId correlates a call. Do not assume a new call reuses an old callId. Creating a file or folder passes a stable `idempotencyKey`. An upload also passes the `contentIdentity` returned by `uploads.complete`. Read a durable receipt with `files.receipts.get`. pending can be retried. Different parameters are 409. A deleted result cannot be rebuilt by replaying. The full protocol is section 7.1 of the [SDK contract](plugin-sdk-contract.md).

Doca does not include membership, prices, points, or business quotas. Model input and output rates, and tokens per image, convert a vendor's raw usage into tokens. They are not a price. Usage distinguishes an unconfirmed call from actual metrics. `ai.usage.recorded` is written inside the settlement transaction. Top-level `metrics` are the rated usage. `provider.metrics` keeps the vendor's raw facts. A plugin pulls events with `events.read(cursor, limit)`, stores its cursor, and handles each event id once. A policy check can refuse a call. Cross-plugin reservation, failure compensation, and money consistency do not yet have a full transaction protocol. One check is not a billing implementation.

The plugin owns its database, credentials, business jobs, and outbox. The host does not offer data.v1 or data.v2. Use initialize, mount, ready, and dispose. The database must match the declared data version; compatible existing data is accepted. A mismatched schema refuses to start.

## Web

The optional web build default-exports `async host => bundle`. `host` provides React, apiBase, useEnvironment, navigate, toast, confirm, request, and FilePicker. React comes from the host so there is one renderer. Other dependencies are bundled. The host does not resolve bare npm imports. The bundle follows `WebPluginBundle` from `@smartdoca/web-plugin-registry`. `manifest.pluginId` and version match the server. Pages, navigation, admin, and settings contributions are supported.

The host serves the declared directory at `/api/v1/plugin-assets/{id}/{version}/` and loads registrations before startup. Load errors are isolated and logged. Server package files are not exposed. Contribution render has an error boundary. A generic tree slot is not finished.

## Build and verify

In the host repository, `pnpm build:plugin-sdk` builds the SDK, contracts, and file capability JavaScript and `.d.ts`. The published packages are `@smartdoca/plugin-sdk` and the contract packages it re-exports. `publishConfig` points at `dist`. Plugin installs depend on those npm artifacts, not on this repository's source.

At least verify a standalone install, startup with no plugins, dependency conflicts, cross-user denial, version conflicts, idempotent calls, revoked relationships, isolation of two host instances, and cleanup on shutdown. Tests use their own database, users, and documents. Interface copy follows [interface languages](i18n.md). Editors follow [editor integration](editor-integration.md) and the [collaboration contract](collaboration-sdk-contract.md).

HTTP callbacks, attachment binding, user calibration, search and knowledge, and the mobile boundary are in the [mail handoff](plugin-mail-handoff.md).

## Scope and delivery

`search.v1` is the host's shared search capability. In-plugin search, global search, and AI retrieval enable sources separately. Registering a source does not connect a global endpoint or UI, and it does not authorize AI. Registering a knowledge source does not subscribe automatically. The host owns knowledge subscriptions, scheduling, subscription cursors, and derived indexes. The plugin owns the external business, credentials, sync, and current permission facts. Priorities are in the [mail handoff](plugin-mail-handoff.md#adjusted-acceptance-order).

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

## Unified content and native client capabilities (source implementation)

`plugin-sdk/content` exports `contentServiceToken` (`content.v1`). Sources implement `list`/`read`/`resolve` and optionally declare `search`. Calls preserve the authenticated principal and purpose. Built-in documents/files use the same registry. Knowledge subscriptions compare lightweight block inventories and read/analyze changed blocks only. The source picker supports primitive JSON-schema fields and string arrays. New document reads, lists and answer retrieval withhold derived content when its source is unavailable; administrators retain access to the knowledge entries. See the [content contract and limits](plugin-content.md).

`PluginWebHost.native` exposes scoped persistent storage and authenticated attachment save/share in the native container; it is null on Web. Plugins must explicitly use it; IndexedDB is not automatically migrated. See [native contract](plugin-native.md). SDK 0.1.2 is published on npm. Independent mail-client integration and real-device acceptance remain pending.
