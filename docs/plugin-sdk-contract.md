# Plugin SDK and core boundary


> 2026-09-30：npm 分发、动态 App 页面与可配置导航的新增对接说明见 [邮箱插件对接手册 v1](plugin-mail-integration-v1.md)，远端 API 以 [商城协议 v1](plugin-store-protocol.md) 为准。移动端已增加受限会话与 WebView 页面，尚待真机及独立邮箱包联调。

[中文](plugin-sdk-contract.zh-CN.md)

Status: updated 2026-09-27. Plugins store their own business data. This document is the acceptance standard for the refactor. It does not mean every interface is implemented. The gap is in section 12. A development tutorial must not present a target interface as an export that exists today.

## 1. Decisions

Doca keeps the document product core and generic platform services. Independent business is discovered from the installation directory. Mail, calendar, membership, billing, usage control, and content moderation are not required host products.

A plugin depends on a separately published SDK and capability contract. The host injects the implementation at runtime. Do not depend on a Doca workspace path, a private host module, a global bridge, or a private host table. The host does not import business plugin source or require a particular business plugin id to finish a public flow.

Plugins run inside a trusted server process. This is an extension boundary, not a Node.js sandbox. The install directory is separate from the program directory. The host loads only plugins that declare the current SDK range and whose database matches the current baseline.

## 2. What the core owns

| Area | Host | Plugin |
| --- | --- | --- |
| Identity | Stable user id, authentication, sessions, enable and disable, basic profile, field visibility | External business accounts, profile extensions, identity-provider adapters |
| Permissions | The unified grant entry, default deny, directory policy, intersection | Register business resource types, map roles and actions, provide grant and intersection facts |
| Files | Folders, files, attachment bindings, upload and download, object storage, permissions | Business attachment references, importers, previewers, extractors |
| Documents | Editor host, persistence, collaboration, history, comments, document permissions | New editor adapters, templates, import and export, document actions |
| AI | Model execution, tool and skill registration, call context, raw usage ledger, token usage rated by model | Domain tools, skills, flows, membership quotas, prices, and charges |
| Search and knowledge | Unified search and the global entry. Subscription model, scheduling, cursor commit, and derived-index cleanup. See section 12 for what exists | Register sources, projections and delete facts, current permission recheck, preview and pull. External accounts and business sync |
| Jobs and events | Host fact events and plugin start and stop hooks | The plugin manages business jobs, its database, retry, and idempotence |
| Interface | Shell, routes, navigation slots, theme, language, error boundaries | Business trees, pages, settings, admin, AI result cards |
| Commercial policy | Generic operation policy extension and fact statistics | Levels, membership, points, plans, quotas, payment |
| Moderation | Generic resource limits, operation events, security audit | Reports, review queues, detection, decisions, vendors |

Do not remove a core capability only because it could be a plugin. Documents, files, users, and grants must run with no business plugin installed. Files and documents using an internal plugin lifecycle is a core implementation detail. It is not the business plugin install channel.

## 3. Installation and discovery

The shared host database holds the global desired plugin registry and complete immutable ZIP archives. Each instance synchronizes a private `DOCA_PLUGINS_DIR` (default `<data-root>/plugins`) before loading. It checks all cached files and repairs missing or corrupt files from the shared archive. Startup does not contact the store, run npm install or compile TypeScript.

Admin → Plugins installs from the official HTTPS store or local uploads, stages upgrades, enables, disables and uninstalls. The default store is `https://store.smartdoca.cc`, overridden by `DOCA_PLUGIN_STORE_URL`. Operations use revision-checked writes and take effect after each instance restarts. The UI distinguishes global desired selection from the answering instance's running selection. No hot removal of Fastify routes is promised.

Prebuilt releases declare `doca.manifest`, `doca.server`, optional `doca.web` and mandatory `doca.dataVersion` in package.json. The static manifest declares an SDK range. Package-relative entry paths, dependency graph, SDK, archive hash and data version are validated before code runs. V1 upgrades require an unchanged data version; private business schema verification remains the plugin's responsibility. Uninstall preserves business data and the data version marker.

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

Target capabilities, some of which are not exported yet: files.v1, documents.v1, users.v1, permissions.v1, http.v1, ai.v1, ai-usage.v1, search.v1, knowledge.sources.v1, notifications.v1 (exported), events.v1, the plugin's private database, and policies.v1. Actual ids follow the current exports. A rename must be versioned. This table is not permission to pass an unimplemented interface to an existing plugin.

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

Business data, credentials, jobs, and the outbox live in the plugin database. Doca does not offer business storage, SQL, or data.v1 or data.v2. initialize, mount, ready, and dispose are the lifecycle. A plugin accepts its declared data structure, including existing compatible data. Another structure refuses startup. Uninstall does not delete the plugin database. The package directory and the data directory are separate.

Across databases and the file service, use idempotence, compensation, and calibration. There is no shared transaction.

### 7.1 Durable file creation

`files.v1.folders.create` and `files.v1.files.create` accept an optional `idempotencyKey`, non-empty, at most 200 characters, no control characters. The scope is the injected plugin id, the current user, and the operation type. The same key and the same parameters return the first result. The same key and different parameters throw 409. The file or folder row and the completed receipt commit together. Receipts do not expire. Disable and uninstall do not delete them. Replaying after the result was deleted returns 404 and does not recreate the file. Replay and query recheck the account and write permission.

Upload completion returns `contentIdentity: {sha256, size, mime}`. An idempotent upload must pass it. The host checks the uploaded bytes. The request fingerprint includes the destination directory, name, and content identity, not the temporary uploadId. Copy uses sourceFileId and does not need contentIdentity. The plugin stores the operation key, business parameters, and content identity in its own outbox.

`files.receipts.get(context, {operation, key})` returns null or `{status: "pending" | "completed", operation, result}`. pending means the original parameters may be retried. It does not mean a job is still running. completed returns the historical snapshot. If the response is unknown, read the receipt, then replay the original create. A failure is not forged into a success receipt.

The host reserves the object id and storage configuration, then writes bytes. Local writes use an atomic replace. S3 writes a complete object. Startup and an hourly sweep reclaim spare objects from completed intents, bytes from intents unfinished for more than 24 hours, and temporary files. Reclaim and upload retry share a database user lock and check object references. A registered object is not deleted as garbage.

### 7.2 Search and external knowledge

`search.v1` is the shared search base for in-plugin search and global federated search. Those entries and AI retrieval enable sources separately. Registering a source does not turn on global display or AI. A public query capability does not mean those entries are connected.

The host persists the subscription, target library, source configuration reference, plugin, source, and record ids and versions, sync cursor, job status, and last error. It schedules pull and owns the derived index lifecycle. That is host knowledge data, not plugin database hosting. The plugin keeps external accounts, credentials, business data, its own sync cursor, and outbox, and provides preview, pull, delete facts, and a current authorization recheck.

The host advances the subscription cursor only after a batch is persisted. It supports replay, cancel, retry, and restart. A subscription constrained by source permission stops retrieval and AI use immediately when access is revoked, the source is disabled, or permission cannot be confirmed. Physical cleanup of derived content may retry asynchronously. Deleting a source propagates to derived records. An independent copy the user imported explicitly has its own authorization and lifecycle. This orchestration is not implied by a register call.

## 8. AI tools, skills, and usage

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

Installation updated on 2026-09-30; other capability rows retain their previous verification dates. This is not a claim that the target above has landed.

| Item | Present | Still to do |
| --- | --- | --- |
| Discovery | Shared registry and full archives, instance cache synchronization, directory/ZIP import, admin store, static manifest checks | Acceptance of an independent package set |
| Injection | Services, effects, public SDK build, public service catalog | More business capabilities as services |
| Files and documents | Public file contract, binding download authorization, durable create idempotence, SDK package build | Full acceptance of an independent document capability package. Spare file objects are reclaimed on a schedule |
| Users | Paged calibration, user-create events in a transaction, status and some profile events | User deletion and async cleanup before a delete entry is opened. More profile entry checks |
| Intersection | Paged relationship sources, current-fact recheck, timeout and sign-out denial | The plugin maintains its own incremental relationship index |
| Client | Dynamic Web loading, scoped mobile WebView, configurable navigation, render error isolation | Generic tree slot; real-device mobile integration acceptance |
| AI | Public tools and skills, raw usage, model-rate conversion, admission policy, durable settlement events | MCP alignment, reservation and failure compensation, more usage dimensions |
| Search and knowledge | search.v1 projection, rebuild, and authorization query. Knowledge registration contract is packaged | Global retrieval, durable knowledge subscription, scheduling, and revocation cleanup |
| Mail | Host source, bridge, database, tools, web and mobile entry, and business tests removed | A future mail plugin is developed and accepted on its own |
| Membership | Backend, UI, and commercial data definitions removed | Combined verification |
| Moderation | Routes, worker, business fields, and read restrictions removed | A future business plugin |

Order: public SDK and the install directory, web runtime loading and independent package verification, user, permission, and AI extensions, mail on public interfaces, membership and moderation removal, then combined upgrade acceptance. Update this table each stage. An unimplemented capability must not appear in a tutorial example that claims to run.

Interface increments and storage ownership on 2026-09-26 follow the [mail handoff](plugin-mail-handoff.md).

## 13. Delivery grades

- Near term: file-create idempotence the mail integration already has, and a real offline tarball acceptance. Search and knowledge follow section 7.2. The first delivery states disable, uninstall, data retention, and the current database baseline.
- When the product promises it: automatic mail sync into a library needs the full host subscription orchestration. Global search needs the full global entry. Do not claim them before they exist, and do not treat them as unconditional blockers for a basic mail connection.
- As the feature arrives: user deletion with the account-delete entry. Dynamic WebView with a mobile promise that does not require an app release.
- Later operations: a default plugin data directory, redacted structured logs, health, recent job errors, and a backlog page for jobs and the outbox. The host summarizes through a public status interface. It does not query the plugin database. The default directory is a path convention. It does not host the database, credentials, or backups.

After disable, jobs are stopped and drained, sources unregister, and business access is denied. The first version stages changes through administration and applies them on each instance restart. Uninstall keeps business data. An explicit wipe is a separate operation with a stated scope and a confirmation. Attachment cleanup rechecks ownership and other live references.

The SDK range check stays. A plugin database accepts only the current structure. A mismatch refuses startup. There is no upgrade or downgrade script.

Explicitly not done: generic plugin SQL or data.v2, a distributed transaction across plugin databases, giving every plugin search source to AI by default, and executing npm plugin code dynamically in the native process.
