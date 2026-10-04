# Capabilities and limits

[中文](features.zh-CN.md)

This page was checked against current source for host **0.1.10** and plugin SDK **0.1.9** on 2026-10-04. Before installing business plugins, the host provides the core capabilities below. Each independent plugin documents its own features, versions, and acceptance results.

## Core capabilities

| Capability | Current status and requirements | Guide |
| --- | --- | --- |
| Rich text, Markdown, spreadsheets, slides, canvas | All five editors are integrated; editing requires resource permission | [Documents and sharing](document-experience.md) |
| Collaboration and save confirmation | All five formats use host WebSocket transport and durable receipts; replicas require shared PostgreSQL, Redis, and file storage | [Collaboration](collaboration.md) |
| History, manual snapshots, restore | History is available for all five formats; only rich text/Markdown restore, with manager permission, current sequence, and a restorable snapshot | [Document history](document-experience.md#history-and-restore) |
| Libraries and permissions | Trees, invitations, inheritance, share links, transfer, move, independent copy, and trash | [Permissions](permission-inheritance.md) |
| Discovery, collections, recent activity | Implemented; visibility in a list and resource access are checked separately | [Discovery and collections](public-resource-discovery.md) |
| Files and attachments | Personal files, shared folders, authorized upload/download; local or S3 storage is required | [File storage](storage.md) |
| Comments and in-app notifications | Implemented across five formats, including stable spreadsheet row/column anchors | [Comments and notifications](comments-and-community.md) |
| Document search | Basic database search is available; full-text, vector, and Q&A indexes require Meilisearch and suitable models | [HTTP API](api.md#search) |
| Personal AI assistant | Sessions, tools, approvals, and raw usage records are implemented; requires available models and credentials | [User guide](user-guide.md) |
| Knowledge curation and independent Q&A | Remain core features; sources, curation sessions, publication, bot sharing, API/MCP are implemented and require model/index configuration | [Knowledge curation](knowledge-studio.md) |
| Local accounts and external login | Passwords, contact verification codes, recovery, registration review, OIDC/OAuth, and social adapters are implemented; external services need real credentials | [Authentication](authentication.md) |
| Webhooks | Asynchronous delivery, retries, and records are implemented; requires a configured receiver | [Webhooks](webhooks.md) |
| Plugin installation and public SDK | Trusted prebuilt packages, installation-directory discovery, restart activation; managed SQL, objects, and encrypted credentials are implemented | [Plugin deployment](plugin-deployment.md) |

## Independent plugins and removed features

- **Quick notes** have been removed from the host. It has no `#/notes` page, `/api/v1/quick-notes` API, `quick_notes` table, or `quick_note_compilations` table. The former guide is retained only in [research records](research.md); its interfaces cannot be used with the current host. This repository supplies no quick-notes plugin release or current feature guarantee.
- Mail, calendar, membership, points, billing, business quotas, and content moderation belong to independent business plugins. The default image installs none of these businesses. Registration review and security audit remain core features.
- Templates, materials, material collections, and plugin document elements have host interfaces and pickers, with **zero default providers**. Install a provider matching the SDK separately. The former host template-management CRUD page is absent. Blank-document creation remains available without providers.
- [Examples](../examples) support development and isolated acceptance. The default image does not install them, and their results do not verify independent business plugins.

## Unavailable or requiring separate verification

- Persistent offline editing queues, a complete desktop offline runtime, Doca as an OIDC provider, SAML are unavailable.
- Plugin temporary workspaces, cluster-wide business-task draining, arbitrary SQL, and distributed cross-service transactions are unavailable. Target SDK contracts do not establish existing exports; see [implementation status](plugin-sdk-contract.md).
- A native plugin WebView container has a source protocol. iOS/Android builds, device behavior, and independent plugin integration require their own acceptance. Server installation does not download and execute native JavaScript.
- Real AI, SSO, verification gateways, Webhook, S3/CDN, and other services depend on deployment configuration. Historical release tests each have a defined scope; they do not verify every external service or device.

## Evidence

The audit covers [service composition](../apps/server/src/plugins/composition.ts), [page routes](../apps/web/src/app/app.tsx), [five-editor dispatch](../apps/web/src/features/documents/document-editor.tsx), [history routes](../apps/server/src/routes/experience.ts), [account routes](../apps/server/src/routes/accounts.ts), [current schema](../packages/db/src/create-schema.ts), and [SDK exports](../packages/plugin-sdk/package.json). `bootstrap.capabilities` and `bootstrap.plugins` identify host capabilities and loaded plugins in a deployment; the former is not a complete business-feature inventory.
