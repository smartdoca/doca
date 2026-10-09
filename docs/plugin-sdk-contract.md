# Plugin SDK and core boundary

[中文](plugin-sdk-contract.zh-CN.md)

Status: updated 2026-10-10 (source host 0.1.15 / SDK source 0.1.10; npm publication and production deployment not verified). All plugin persistence is host-managed; plugins own business models and authorization. This document is the acceptance standard for the refactor. It does not mean every interface is implemented. The gap is in section 12. A development tutorial must not present a target interface as an export that exists today.

The [public capabilities and UI extension refactor plan](plugin-sdk-expansion.md) records the agreed additive direction, current implementation inventory, proposed interfaces and acceptance batches. A–D are now implemented; the [implemented methods and slots](plugin-extensions.md) record exact exports and limits. E/F remain future work.

## Implemented storage revision (2026-10-03, SDK source 0.1.7)

`@smartdoca/plugin-sdk/storage` now exports installation-bound `pluginDatabaseToken` (`storage.sql.v1`) and `pluginObjectStorageToken` (`storage.objects.v1`). The database subset is explicit schema version 1, text/int32/double columns, primary/unique constraints, structured select/insert/update/remove and transactions with callbacks executed once. `pluginCredentialToken` (`storage.credentials.v1`, SDK source 0.1.8) provides server-only encrypted credentials with revision-checked refresh and deletion. Joins, foreign keys, generic SQL, upsert and workspaces are not exported. See [credential API and deployment](plugin-credentials.md). Current SDK isolation is enforced by host-compiled queries over namespaced tables on the host connection; separate PostgreSQL roles/process isolation remain a stronger future boundary.

Logical databases use `plugin:<pluginId>`, user-file attribution and private objects use `plugins/<pluginId>`, and release ZIPs use `host/plugin-releases/<sha256>.zip`. Complete immutable ZIP bytes live in environment-configured file storage; the shared database holds registry version 2, archive references and trusted file-hash indexes. Verified cache hits do not download ZIPs again. All instances are restarted manually. The new host baseline rejects older databases/formats/SDK packages and preserves their data, with no migration or fallback. See [exact implementation and limitations](unified-storage-implementation.md).

## 1. Decisions

The approved [horizontal scaling and managed storage contract](plugin-horizontal-scaling.md) defines database ownership, namespace isolation, user/private/temporary storage and multi-instance execution. Packages must declare `doca.storage: "host"`; other or missing declarations are rejected before code import. The host alone chooses local/remote storage. Managed SQL and private objects are exported in SDK source 0.1.7; credentials are exported in SDK source 0.1.9; workspaces remain a gap.

Doca keeps the document product core and generic platform services. Independent business is discovered from the installation directory. Mail, calendar, membership, billing, usage control, and content moderation are not required host products.

A plugin depends on a separately published SDK and capability contract. The host injects the implementation at runtime. Do not depend on a Doca workspace path, a private host module, a global bridge, or a private host table. The host does not import business plugin source or require a particular business plugin id to finish a public flow.

Plugins run inside a trusted server process. This is an extension boundary, not a Node.js sandbox. The install directory is separate from the program directory. The host loads only plugins that declare the current SDK range and whose database matches the current baseline.

## 2. What the core owns

| Area                 | Host                                                                                                                           | Plugin                                                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Identity             | Stable user id, authentication, sessions, enable and disable, basic profile, field visibility                                  | External business accounts, profile extensions, identity-provider adapters                                                |
| Permissions          | The unified grant entry, default deny, directory policy, intersection                                                          | Register business resource types, map roles and actions, provide grant and intersection facts                             |
| Files                | Folders, files, attachment bindings, upload and download, object storage, permissions                                          | Business attachment references, importers, previewers, extractors                                                         |
| Documents            | Editor host, persistence, collaboration, history, comments, document permissions                                               | New editor adapters, templates, import and export, document actions                                                       |
| AI                   | Model execution, tool and skill registration, call context, raw usage ledger, token usage rated by model                       | Domain tools, skills, flows, membership quotas, prices, and charges                                                       |
| Search and knowledge | Unified search and the global entry. Explicit subscriptions, scheduling, block fingerprints and derived-content access control | Register content.v1 list/read/resolve and optional search, current permission checks; external accounts and business sync |
| Jobs and events      | Host fact events, lifecycle hooks and managed persistence                                                                      | Business job logic, retry, idempotence and state through host services                                                    |
| Interface            | Shell, routes, navigation slots, theme, language, error boundaries                                                             | Business trees, pages, settings, admin, AI result cards                                                                   |
| Commercial policy    | Generic operation policy extension and fact statistics                                                                         | Levels, membership, points, plans, quotas, payment                                                                        |
| Moderation           | Generic resource limits, operation events, security audit                                                                      | Reports, review queues, detection, decisions, vendors                                                                     |

Do not remove a core capability only because it could be a plugin. Documents, files, users, and grants must run with no business plugin installed. Files and documents using an internal plugin lifecycle is a core implementation detail. It is not the business plugin install channel.

## 3. Installation and discovery

The shared host database holds the desired registry and archive metadata; complete immutable ZIPs are held in the configured host file store. Each instance synchronizes a private `DOCA_PLUGINS_DIR` (default `<data-root>/plugins`) before loading. It checks all cached files and repairs missing or corrupt files from the shared archive. Startup does not contact the store, run npm install or compile TypeScript.

Admin → Plugins installs from the official HTTPS store or local uploads, stages upgrades, enables, disables and uninstalls. The default store is `https://store.smartdoca.cc`, overridden by `DOCA_PLUGIN_STORE_URL`. Operations use revision-checked writes and take effect after each instance restarts. The UI distinguishes global desired selection from the answering instance's running selection. No hot removal of Fastify routes is promised.

Prebuilt releases declare `doca.manifest`, `doca.server`, optional `doca.web`, mandatory `doca.dataVersion` and `doca.storage: "host"` in package.json. Static storage validation precedes server entry resolution/import for every installation source and startup restoration. Missing or different storage declarations fail without conversion. SDK range, paths, graph, hash and exact structure are also checked. Installed upgrades require unchanged dataVersion. Current uninstall invokes the required business cleanup hook and clears the marker on success; host-owned private database/object cleanup fences the generation in the registry transaction; cluster task draining remains pending.

Offline folders `<install-root>/<plugin-id>/` are published to the shared registry at startup and moved into `.imports/`. Runtime files live in `.releases/<sha256>/`. No root npm manifest, source links or legacy discovery path is supported. Program files and plugin business data stay separate. Host source, package.json and Vite configuration are never changed by installation.

The [store protocol](plugin-store-protocol.md) defines package layout, remote endpoints, limits and multi-instance semantics. See [deployment](plugin-deployment.md) for restart and failure recovery.

## 4. Lifecycle

```text
scan static metadata → check dependencies → import code
→ discover → required service check → initialize → mount → ready
→ stop accepting work → dispose in reverse dependency order
```

Services are identified by a stable string id and version, not by token object identity. The host provides platform services first. A business plugin registers services only in its own namespace. It cannot inject private host services such as `doca.server.*`. Each service id has one provider. Multi-contribution capabilities use a registry.

Each registration returns a disposer owned by a context effect. Services, jobs, event subscriptions, and UI registrations belong to one host instance. Do not store them on `globalThis` or `Symbol.for`. Two test apps in one process must not affect each other.

Target capabilities, some of which are not exported yet: files.v1, documents.v1, users.v1, permissions.v1, http.v1, ai.v1, ai-usage.v1, search.v1, content.v1, activity.v1, notifications.v1 (exported), events.v1, host-managed plugin relational storage (exported in SDK 0.1.7), and policies.v1. Actual ids follow the current exports. A rename must be versioned. This table is not permission to pass an unimplemented interface to an existing plugin.

## 5. User information and request context

HTTP requests, AI tools, and background jobs share one trusted execution context: requestId, principal, pluginId, signal, and optionally sessionId, turnId, jobId, and callId. Identity comes from host authentication or a persisted job authorization. A plugin cannot build a user identity from its HTTP body.

A full user record available on the server is the stable id, public id, login, display name, avatar, status, administrator flag, verified contacts, profile fields, custom business fields, and identity-link metadata the caller may read. Ordinary search results stay a minimal projection. The object does not contain a password hash, session token, verification code, OAuth token, model API key, or storage secret. Do not return a full server profile to the browser or add it to a model prompt automatically.

Persist user create, profile update, and status change events. There is no user-delete entry yet. A background job rechecks user status and resource permission. A disabled user cannot keep access from an old job snapshot.

A future delete flow is recorded by the host: mark deleting and revoke access, plugins clean up idempotently and confirm, then the host completes the delete. It must cover disabled, uninstalled, and unavailable plugins, with retry and an audited manual path. A timeout is not success. It does not use a cross-database two-phase commit. It must be accepted before a user-delete entry is opened.

## 6. Permissions and user intersection

A resource reference is `(pluginId, resourceType, resourceId)`. The plugin registers its authorizer. The host calls it. File and document services keep their own ACLs. Registering a plugin does not grant the right to read a user's files.

The plugin defines business actions and role maps, such as mailbox.read. Plugin actions are not forced to equal document editor. A missing authorizer, a disabled plugin, or an uncertain result denies access. Body reads, attachment downloads, AI tools, and search hydrate recheck.

The host keeps the administrator's all, related, and none rules and per-user overrides. related candidates are the union of built-in document and file sources and active plugin intersection sources. The host still filters user status, field visibility, and paging. none does not ask a plugin to widen the rule.

An intersection source states which site users can be discovered because of an authorized business relationship. Shared mailbox or calendar members can be an intersection. A stranger's mail, the same email domain, or a name in a message body is not. The plugin does not write the administrator directory policy.

The source protocol supports a source id, schema version, candidate batches and cursors, relationship id and version, and a current-fact recheck. The plugin maintains large relationship indexes and its outbox. User search does not scan the plugin database. Expired candidates are rechecked before they are returned. A source failure does not widen search. Disabling a plugin removes its source immediately. Enabling it again calibrates versions and valid relationships first.

Being searchable grants no business permission and does not expose the full profile. Duplicate users from several sources are deduplicated before paging. A pre-filter total must not leak hidden users.

## 7. Files, plugin data, and transactions

Plugins use injected files.v1 and store stable ids. An attachment binding is `(ownerPlugin, ownerType, ownerId, role)`. Do not build a private attachment store or save a temporary signed URL as a permanent reference. An owner binding is ownership, not access. Reading an attachment through mail rechecks the mailbox and the binding. Opening the original file still follows that file's ACL.

All business persistence is host-managed. Plugins define tables, indexes, job/outbox semantics and authorization, but never select a storage backend, connect directly to a database or persist to system directories. The logical database is `plugin:<pluginId>`, bound to the installation identity. User files use files.v1; private binaries, credentials and temporary work use their respective host capabilities. Managed database/private-object APIs are exported through plugin-sdk/storage; credentials are exported in SDK source 0.1.9; workspace APIs and data.v1/data.v2 are not available. Missing capabilities cannot be replaced with self-managed storage. Structures match exactly; no implicit conversion or old-data fallback. The host owns managed-store cleanup, coordinated across instances, rather than plugin filesystem deletion.

Across databases and the file service, use idempotence, compensation, and calibration. There is no shared transaction.

### 7.1 Durable file creation

`files.v1.folders.create` and `files.v1.files.create` accept an optional `idempotencyKey`, non-empty, at most 200 characters, no control characters. The scope is the injected plugin id, the current user, and the operation type. The same key and the same parameters return the first result. The same key and different parameters throw 409. The file or folder row and the completed receipt commit together. Receipts do not expire. Disable and uninstall do not delete them. Replaying after the result was deleted returns 404 and does not recreate the file. Replay and query recheck the account and write permission.

Upload completion returns `contentIdentity: {sha256, size, mime}`. An idempotent upload must pass it. The host checks the uploaded bytes. The request fingerprint includes the destination directory, name, and content identity, not the temporary uploadId. Copy uses sourceFileId and does not need contentIdentity. The plugin stores the operation key, business parameters, and content identity in its own outbox.

`files.receipts.get(context, {operation, key})` returns null or `{status: "pending" | "completed", operation, result}`. pending means the original parameters may be retried. It does not mean a job is still running. completed returns the historical snapshot. If the response is unknown, read the receipt, then replay the original create. A failure is not forged into a success receipt.

The host reserves the object id and storage configuration, then writes bytes. Local writes use an atomic replace. S3 writes a complete object. Startup and an hourly sweep reclaim spare objects from completed intents, bytes from intents unfinished for more than 24 hours, and temporary files. Reclaim and upload retry share a database user lock and check object references. A registered object is not deleted as garbage.

### 7.2 Search and external knowledge

Use `@smartdoca/plugin-sdk@^0.1.9`. Import `contentServiceToken` and the `ContentSource` type from `@smartdoca/plugin-sdk/content`; declare the token in `injections.required` and register the source during mount. Sources belong to the registering plugin. Built-in documents and files use the same contract.

| Member                                        | Contract                                                                                                                                                                                                    |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Declaration                                   | `id`, `pluginId`, `version: 1`, localized `title`, `contentTypes`, `purposes`, `capabilities: {search}`, `configSchema`                                                                                     |
| `list(ctx, {config, cursor, limit})`          | Required. Return `{items, nextCursor, snapshot}`. Each item contains `ref: {sourceId, resourceId, blockId}`, `fingerprint`, `title`, optional `order`, `anchor`, `excerpt`; do not return full bodies here. |
| `read(ctx, {config, ref, fingerprint})`       | Required. Recheck permission and return the item plus `text`, or null when unavailable. A changed fingerprint is a conflict, never new text under an old fingerprint.                                       |
| `resolve(ctx, ref)`                           | Required. Recheck access and return `{path, fingerprint}` or null. `path` is a current in-app location.                                                                                                     |
| `search(ctx, {config, cursor, limit, query})` | Optional; declare and implement together. Return a lightweight page. Unsupported search does not fall back to a full scan.                                                                                  |

`ctx` contains the authenticated `principalId`, `purpose` (`knowledge`, `analysis`, or `search`) and cancellation `signal`. The provider enforces current business permission on every call. A source supporting analysis can serve a future to-do plugin without a mail-specific API. Consumers use `sources(ctx, purpose)`, then service `list/read/search` with `sourceId` and `purpose`; service `resolve` takes `{ref, purpose}`. Only request a purpose declared by that source.

Pagination starts and ends with null. All pages in a traversal must share a consistent snapshot; fail on expiry rather than silently continuing with different data. This cursor is for paginating the full authorized inventory, not a durable change log. `listChanges` and `readChanges` are not required or exported by this contract. The source may sync its business system internally, but Doca does not require that implementation.

Knowledge uses the existing subscription and scheduling system. A user explicitly selects the source, library and configuration. The host stores references and block fingerprints, compares the complete inventory, and reads/analyzes only new or changed blocks. It does not keep an extra full source-body mirror. Unchanged blocks do not need to be read again. Only a complete, consistent inventory may establish removal; failed or partial runs do not acknowledge it. Stable block identity must not depend on a document's whole revision or positional paragraph index.

On deletion, unbinding, revocation or an unavailable source, derived knowledge is withheld from new normal reads, lists, search and answer retrieval; content is retained for administrator handling, including manually edited results. Already delivered content and an already open collaboration connection are not retroactively revoked by this check. The configuration UI supports primitive fields, enums and string arrays; complex configuration belongs in the plugin's own UI. This integration adds no database schema migration, dual read/write or old-source adapter. The SDK still exports `knowledge.sources.v1`, but it is not the subscription entry for new integrations and is not automatically adapted to `content.v1`.

Limits: 100 inventory items/page, 100,000 items/traversal, 2 million characters/body, 120,000 changed-body characters/analysis run and a 20-second source-call deadline. Oversized or incomplete work fails explicitly; do not truncate it and call it complete. HTTP endpoints are `/api/v1/content/sources` and `/api/v1/content/{list,read,resolve,search}`. See [exact protocol and limits](plugin-content.md) for request shapes and subscription routes.

## 8. AI tools, skills, and usage

SDK source 0.1.10 exports server `ai.continuations.v1`: installation-scoped source registration, authenticated tool waits, durable checkpoints, deduplicated wake notifications and restart reconciliation. Business jobs and authorization remain plugin-owned; the host releases model execution while waiting. Only explicit new v1 waits participate; no database migration or historical conversion. See the [continuation contract](plugin-ai-continuations.md).

The current source Web SDK exports `PluginWebHost.ai.open` for personal-assistant launch with prompt/context, authorized documents/files, an optional owned session/model and explicit auto-send. It uses existing host session/message and execution-policy flows without a storage migration or old-host adapter. See [the launch contract](plugin-assistant.md). This is a client UI capability, not a server AI-execution service; npm/native production availability remains unverified.

A plugin may register tools, skills, intents, workflows, result renderers, and checkers. A tool has a namespaced id, input and output schemas, an executor, and a permission requirement. A skill is versioned content in the package. It is not a way around tool authorization.

A plugin tool receives the authorized user profile and the AI call context: session, turn, job, tool call, model id, parameters, cancel signal, and allowed material references. Arbitrary history and every prompt are not the default tool context. Chat and MCP share authorization and tool execution.

The core does not have membership levels, points, prices, gift quotas, or model filtering by level. The host keeps model configuration, technical timeouts, concurrency, context limits, and raw usage queryable by user, model, plugin, job, and call. Each model has input and output token rates. Image generation has tokens per successful image. Those rates convert vendor usage into cumulative tokens. They are not a currency or a final price.

Each provider attempt has its own callId and attemptId. Unknown values are null. Do not invent 0. Cache or reasoning tokens may already be included in input or output totals. Do not add them twice. Settlement freezes the rate snapshot from the start of the call. The UI and `ai.usage.recorded` show rated usage. The ledger keeps raw vendor metrics. Estimates and actuals stay separate. Replay does not meter twice.

Only calls that go through the host AI executor are in the unified meter. A plugin that calls a provider directly is outside that promise.

A control plugin must reserve atomically in its own transaction and return an idempotent reservation id. Completion or failure releases or settles through a durable event retry. Check balance, call, then deduct is not concurrent quota control. A failed usage event does not erase the host ledger. Replay deduplicates by callId and attemptId.

policies.v1 also covers document create, file upload, and share. It returns allow or deny and a stable reason code. The default has no commercial constraint. A policy plugin cannot widen a resource ACL, account status, request size, or execution safety limit. A policy exception is not swallowed into allow. If a required control plugin is missing, the operation is unavailable and the error is explicit.

## 9. Pages, navigation, and HTTP

A business plugin may contribute global navigation, its own tree or sidebar, pages, admin, personal settings, document menu actions, search results, and AI result display. Position uses a stable slot, order, and id. Do not edit a host route branch to add a business.

The web target is a browser ESM, styles, and assets built by the plugin. The host loads a versioned URL from the active manifest. The build must not import `@web/*`, local host source, or unresolved bare imports. The host serves the declared static directory, not the whole npm package. A server and client version mismatch makes that plugin's page unavailable. A missing renderer keeps a generic historical display. A web registration error stays inside the plugin boundary.

http.v1 registers `/api/v1/plugins/<plugin-id>/...` and reuses host authentication, Origin and Host checks, request schema, error format, rate limit, and cancellation. A public webhook must declare how external identity is verified. Native code still ships with the App build. Mobile-capable plugins now use the scoped WebView shell described in the mail integration v1 guide.

## 10. Removing membership and moderation

Removing membership includes admin pages, level display, plan and grant APIs, identity-provider level maps, resource quotas, AI points, and model filtering by level. Hiding a page while keeping a level limit is not enough. Raw AI usage records stay. The project is not carrying old commercial fields or a migration layer.

Removing content moderation includes report entry points, the review admin, vendors, scan jobs, and dedicated review calls in host flows. Administrator approval of registration is account policy. Security audit is core. Neither is deleted because content moderation is removed.

Mail, calendar, membership, and moderation are business plugins. Quick notes have been removed from the core and may return as a future independent plugin. Tickets, third-party sync, recognizers, and notification channels are candidates to split later, only after the same SDK, data, and client acceptance. Do not leave a wrapper that still imports a private host implementation.

## 11. Development and acceptance

- Public ids, tables, events, and tools have a plugin namespace. The SDK version range is explicit.
- The package provides JavaScript, `.d.ts`, a static manifest, and declared client artifacts. It does not depend on Doca repository aliases.
- Unit tests use capability fakes. Integration tests use a separate Doca, an isolated database, and a temporary install directory.
- Acceptance uses a real host build, the SDK, and the plugin tarball outside the repository, with the dependency closure. Install and startup do not fetch a registry or follow a source link.
- Verify an empty plugin directory, one plugin, several plugins, a missing dependency, a duplicate id, a version conflict, a mismatched database baseline, and cleanup on shutdown.
- Verify two host instances do not share plugin services, user events, or tool registrations.
- Verify related and none policy, relationship revocation, plugin disable, source failure, file binding, and the same permission in search and AI.
- Verify concurrent AI calls, failure and cancel, missing usage, settlement replay, and a failed control plugin, without double metering.
- Verify a host upgrade does not change the plugin registry or immutable archives, business data, or attachments. With plugins disabled, core documents and files still run.
- Interface copy follows [interface languages](i18n.md). Editor extensions follow the collaboration and editor integration documents.

## 12. What exists

Updated 2026-10-03 against current exports and host implementation. Future targets above remain subject to the gaps below.

| Item                   | Present                                                                                                                                                                                                                                                             | Still to do                                                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Discovery              | Shared registry, archive references and shared file-store ZIPs, instance cache synchronization, directory/ZIP import, admin store, static manifest checks                                                                                                           | Acceptance of an independent package set                                                                                                    |
| Injection              | Services, effects, public SDK build, public service catalog                                                                                                                                                                                                         | More business capabilities as services                                                                                                      |
| Managed plugin storage | Required declaration, installation-bound SQL transactions/schema, private immutable objects, server-only encrypted credentials, generation fencing and durable object cleanup                                                                                                                          | Workspaces, cluster business-task draining and stronger process isolation; see [storage contract](plugin-horizontal-scaling.md) |
| Files and documents    | Public native snapshot and library traversal reads, permission-aware resource pagination, public file contract, binding download authorization, durable create idempotence, SDK package build                                                                       | Full acceptance of an independent document capability package. Spare file objects are reclaimed on a schedule                               |
| Users                  | Policy-aware directory search/resolve/selection validation and self reads, paged calibration, user-create events in a transaction, status and some profile events                                                                                                   | User deletion and async cleanup before a delete entry is opened. More profile entry checks                                                  |
| Intersection           | Shared internal/plugin relationship registry, paged relationship sources, current-fact recheck, timeout and sign-out denial                                                                                                                                         | The plugin maintains its own incremental relationship index                                                                                 |
| Client                 | Optional commands/views/placements, typed public client, dialogs/drawers/sidebar and Web home/document/library/file slots, dynamic Web loading, scoped mobile WebView, configurable navigation, render isolation, persistent native cache and attachment save/share | Selection/insertion/theme contracts; independent client and real-device acceptance                                                          |
| Document elements      | Optional Web registry, public SDK types, rich atomic inline codec/configuration, sheet whole-cell canvas/native commands, opaque unknown-version placeholders, independent countdown/news example                                                                   | General blocks, arbitrary editor mutation API, lossless cross-format export and native-device acceptance                                    |
| AI                     | Public tools and skills, server `ai.continuations.v1`, parameterized `host.ai.open` on Web/native, raw usage, model-rate conversion, admission policy, durable settlement events                                                                                                                  | MCP alignment, reservation and failure compensation, more usage dimensions; native launch device acceptance                                 |
| Recent activity        | activity.v1 source registration, plugin-owned visits, merged cursor paging, permission-checked opening                                                                                                                                                              | Plugin-specific visit storage and cleanup belong to the plugin; see [integration](plugin-activity.md)                                       |
| Search and knowledge   | content.v1 sources, global content retrieval, existing knowledge subscriptions/scheduling, block fingerprints, source configuration UI and derived-content guards                                                                                                   | Independent mail-source integration and acceptance; already open collaboration connections are outside immediate revocation                 |
| Mail                   | Host source, bridge, database, tools, web and mobile entry, and business tests removed                                                                                                                                                                              | A future mail plugin is developed and accepted on its own                                                                                   |
| Membership             | Backend, UI, and commercial data definitions removed                                                                                                                                                                                                                | Combined verification                                                                                                                       |
| Moderation             | Routes, worker, business fields, and read restrictions removed                                                                                                                                                                                                      | A future business plugin                                                                                                                    |

Order: public SDK and the install directory, web runtime loading and independent package verification, user, permission, and AI extensions, mail on public interfaces, membership and moderation removal, then combined upgrade acceptance. Update this table each stage. An unimplemented capability must not appear in a tutorial example that claims to run.

The [mail handoff](plugin-mail-handoff.md) records historical interfaces and acceptance. Its old self-managed storage guidance is superseded by the approved managed-storage contract.

## 13. Delivery grades

- Host content, file services and public integration hooks retain their existing boundaries. Business models, permissions, retries and outbox semantics remain plugin-owned; persistence is always host-managed.
- Required package declaration `doca.storage: "host"` is checked before server-code import for ZIP/npm/store installs, offline directory import and startup restoration. Missing/different values fail. No plugin data-directory environment variable, backend selector, legacy adapter or implicit data migration is supported.
- Managed relational storage and private objects are exported in SDK 0.1.7. Credentials are exported in SDK source 0.1.9; temporary work remains to implement. Backend choice and shared deployment belong to the host; plugins never distinguish local/remote. Their exact export status is in the storage contract and section 12.
- New managed stores accept only the declared structure; mismatches refuse startup. Do not open empty stores for existing self-managed installations or use uninstall to bypass a migration plan. Old packages/data remain untouched; any conversion needs separate agreement.
  Managed private database/object cleanup belongs to the host. On successful business uninstall, the registry transaction fences the current generation, drops declared private tables and queues object deletion with durable retries. Credential cleanup and generation fencing are implemented; cluster business-task draining remains unavailable. User files and other business references are preserved. Hook failure leaves the installation intact; external hook effects cannot be rolled back. All instances still require manual restart.
- Health, redacted logs, recent job errors and backlog are summarized through public status interfaces, not by plugins reading host storage paths.

Not provided: arbitrary SQL, cross-plugin/host distributed transactions, automatic old-store import/dual writes, default AI access to every source, or npm plugin code dynamically executed by the native process.

## 14. Plugin-owned recent activity

`activity.v1` is exported through `activityServiceToken` in `plugin-sdk/platform`. A source supplies `list` and `get`, localized type labels, and a supported icon. The host does not persist plugin visits. Existing core visit stores stay in place. Registration is instance-scoped and disposed with the plugin; list and open require current `activity.read` authorization. The [activity contract](plugin-activity.md) defines strict keyset ordering, bounded queries, failure isolation, cursor behavior, and rollback without data migration.

## 15. Content and native implementation

The source SDK exports `content.v1` through `plugin-sdk/content`: required list/read/resolve, optional search, complete inventory validation, and built-in document/file readers. Knowledge subscriptions reuse existing storage and scheduling, compare block fingerprints and read/analyze changed bodies only. Configuration UI and live derived-content guards cover new reads, lists and answer retrieval. No knowledge.sources.v1 adapter, database conversion or schema migration is added. Independent mail integration and native-device acceptance remain required. [Contract and implementation limits](plugin-content.md).

The native container now provides per-origin/user/plugin persistent storage and authenticated attachment save/share through `PluginWebHost.native`. Native verification and an independently rebuilt mail client are still required. [Native contract](plugin-native.md).

## Creation resources (SDK 0.1.5)

[Template/material contract](creation-resources.md) defines the implemented zero-default provider registries, versioned consumer matching, tags/search/pagination, material import, document initialization, public clients and injected pickers. The retired template table is retained without migration or default registration; old template APIs and templateId creation are removed under the agreed plan. External providers and store resource management remain separate work.

The 0.1.6 source revision adds named source descriptions, multi-source `providerIds`, bounded provider-owned `retrieve`, source metadata in results and picker callbacks, and AI source-discovery/retrieval tools. The agreed query change rejects the former singular `providerId`; resource references retain their `providerId` and stored data is unchanged. Unsupported retrieval never scans browse pages. See the current [resource protocol](creation-resources.md); source verification does not imply npm publication.

## Plugin document elements (2026-10-02, SDK 0.1.6 source)

The optional Web bundle `elements` registry and `@smartdoca/plugin-sdk/editor-elements` are implemented for rich atomic inline elements and spreadsheet whole-cell canvas views. Configuration forms submit through host-owned native operations and undo; there is no public arbitrary editor handle. Exact unknown types/versions show an error placeholder and preserve opaque JSON, with no conversion, migration or cleanup. Zero providers are installed by default. See [the exact element contract](plugin-editor-elements.md) and [the independent countdown/news example](../examples/plugin-elements/README.md). npm publication, production installation and native-device acceptance are not implied.


Material collections are implemented in SDK source 0.1.9: materials.v2 / version 2 providers, separate material/collection result groups, paging, tags and indexed retrieval. Collection metadata never embeds members. The agreed revision has no materials.v1 adapter and no existing-file/document migration. Collection management belongs to providers using public host-managed persistence. See the [resource protocol](creation-resources.md).
