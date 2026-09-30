# Mail plugin handoff

> 历史对接记录：当前开发以[插件开发指引](plugin-development.zh-CN.md)为入口（宿主 0.1.1 / SDK 0.1.2）。本文旧的 preview/pull/持久订阅游标及“尚未发布”状态不再作为新接入标准；内容使用 content.v1，原生能力使用 PluginWebHost.native。历史测试结论仅适用于当时的版本。


> 2026-09-30：npm 分发、动态 App 页面与可配置导航的新增对接说明见 [邮箱插件对接手册 v1](plugin-mail-integration-v1.md)，远端 API 以 [商城协议 v1](plugin-store-protocol.md) 为准。移动端已增加受限会话与 WebView 页面，尚待真机及独立邮箱包联调。

[中文](plugin-mail-handoff.zh-CN.md)

This note records what a mail plugin can call today and what still waits on a product promise. It is not a new SDK export. The general boundary is sections 7 and 13 of the [SDK contract](plugin-sdk-contract.md).

## Storage

The plugin owns its database, credentials, business sync cursors, and outbox. The host owns knowledge subscriptions, scheduling, subscription cursors, and derived indexes. A plugin database accepts only its current empty baseline. A mismatched schema refuses to start. Uninstall keeps data. An unknown send result is not retried automatically.

## Interfaces that exist

- HTTP, users, events, and notifications from `@smartdoca/plugin-sdk/platform`.
- Files and attachments from `@smartdoca/plugin-sdk/files`, including durable idempotent folder and file creation.
- Search from `@smartdoca/plugin-sdk/search`.
- Knowledge sources from `@smartdoca/plugin-sdk/knowledge`.
- Web from `@smartdoca/plugin-sdk/web`.
- Native mobile code still ships with the app build; dynamic plugin pages now use the scoped WebView shell (see the v1 integration guide).

`notifications.v1` publishes and withdraws idempotently. The plugin registers `notification.read`. The host rechecks permission on publish, display, unread count, and click. A click goes through an authorization endpoint to an in-app path. Background jobs can recheck `users.status(userId)`. These are in-app notifications, not system mail or mobile push. Field limits are in the [development guide](plugin-development.md).

`DOCA_PLUGINS_DIR` may be set in `.env`. A missing or blank value falls back to `${DOCA_DATA_DIR:-./data}/plugins` after a restart.

## Acceptance order

<a id="adjusted-acceptance-order"></a>

| Priority | Requirement | Done when |
| --- | --- | --- |
| Connected and verified | Durable idempotent file and folder creation | The same key under concurrency, a lost response, and a retry after restart return the first result. Different parameters conflict. Permission is rechecked. The plugin still owns send idempotence |
| State clearly | search.v1 and knowledge ownership | search.v1 is a shared base. In-plugin, global, and AI entry points are enabled separately. The host owns subscriptions and derived indexes. The plugin owns the external business and authorization facts |
| Delivery gate | Real offline tarball integration | Outside this repository, with the host build, SDK, mail plugin, and the full dependency closure. No source link, no undeclared cache, no registry access. Startup, web load, and the business flow pass |
| Delivery baseline | Disable, uninstall, retain data, current baseline | The first delivery states stopped jobs, unavailable sources, retained data, and the database baseline. A mismatched schema refuses startup. The admin UI may come later |
| If the product promises it | Automatic knowledge subscription | Durable subscription, scheduling, batch and cursor consistency, restart recovery, source deletion, and immediate unsearchability after revocation. An independent copy is defined separately |
| If the product promises it | Global federated search | Endpoint, source selection, sort and paging, timeout and partial failure, UI, and renderer fallback. AI sources are not turned on automatically |
| With account deletion | User deletion and async cleanup | The host coordinates revocation and plugin cleanup. Disabled, uninstalled, and failed plugins are covered. A timeout is not success. There is no distributed two-phase commit |
| With a no-rebuild mobile promise | Dynamic WebView shell | Implemented scoped tickets and WebView page shell; real-device acceptance remains. No general native bridge. |

Not in scope: generic plugin SQL or data.v2, a distributed transaction across plugin databases, giving every search source to AI by default, and executing npm plugin code dynamically inside the native process.

The 2026-09-27 mail 0.3.0 check installed a real mail tarball outside the repository, with third-party dependencies from a prepared offline store and no source symlink. Isolated IMAP and SMTP covered receive, body, concurrent attachment import and download, send replay, cursor and notification recovery after restart, and keeping data when an account is revoked or disabled. The browser checked opening a message from a notification, the sidebar entry, and the list. Global mail search, automatic knowledge subscription, user-deletion coordination, and dynamic mobile remain separate acceptance items. That run used host source. It is not a fully offline production-image acceptance, and it did not test a live vendor OAuth or a database failover drill.
