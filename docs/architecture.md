# Architecture and implementation boundaries

[中文](architecture.zh-CN.md)

Baseline: host 0.1.10 / SDK 0.1.9, checked against current source on 2026-10-04. This describes implemented assembly and boundaries; deployment-specific services and device behavior need separate acceptance. Start with [capabilities and limits](features.md).

## Application and modules

Doca is a TypeScript modular monolith. Development runs React/Vite and Fastify on separate ports behind one browser origin. Production serves the built Web app and API through Fastify. Cordis owns in-process services and lifecycle; the public SDK defines plugin boundaries.

```text
Browser: React + five document editors
  │ same-origin HTTP / WebSocket; host-authenticated sessions
Fastify: Host/Origin validation, routes, security, static files
  │
Host composition: accounts, documents, files, search, AI, knowledge
  │ trusted business plugins discovered in the installation directory
Core domain rules / Kysely database access
  │
SQLite single instance, or shared PostgreSQL + Redis + file backend
```

The default host contains rich text, Markdown, spreadsheets, slides, canvas, document permissions, discovery, files, knowledge curation, Q&A assistants, authentication, registration review, security audit, and raw AI usage facts. Quick notes, mail, calendar, membership, billing, business quotas, and moderation are independent business concerns; no such provider is installed by default. Templates/materials/elements expose interfaces with zero default providers.

## Directories

| Path | Responsibility |
| --- | --- |
| `apps/server/src/main.ts` | Startup, listening, shutdown |
| `apps/server/src/bootstrap/config.ts` | Origin, database, proxy, Redis configuration |
| `apps/server/src/app/create-app.ts` | HTTP routes, session and security boundaries |
| `apps/server/src/plugins/composition.ts` | Built-in services and installed plugin assembly |
| `apps/server/src/routes` | Host HTTP endpoints |
| `apps/server/src/services` | Realtime, search, AI and other application services |
| `apps/web/src/app/app.tsx` | Workspace routing and feature assembly |
| `apps/web/src/features/documents/document-editor.tsx` | Dispatch to the five installed editor packages |
| `packages/core/src` | Domain rules, authorization and transactions |
| `packages/db/src/create-schema.ts` | Current empty-database baseline |
| `packages/plugin-sdk` | Public server/Web/plugin interfaces |
| `tests` | Isolated unit and integration checks |

Web code calls HTTP DTOs rather than importing database or password internals. Business plugins consume published SDK services and never import host source or create global runtime bridges. See [plugin architecture](plugin-architecture.md) and [implementation inventory](plugin-sdk-contract.md).

## Identity and security

One deployment has one account system, without organization/space/tenant tables. Registration and external providers start disabled; no default administrator exists. Passwords use scrypt and random salts; the database stores session digests. Site sessions last eight hours. Password changes and account disabling revoke sessions.

Every request checks configured Host. Mutations also check same-origin Origin. Site cookies are HttpOnly, SameSite=Strict, and Secure over HTTPS. Authentication adapters support external OIDC and social providers; contact verification and recovery are implemented, with verification gateways required. Registration approval has a dedicated review workflow. Doca as an OIDC provider, SAML, and IdP-wide logout are unavailable. See [authentication](authentication.md).

Administration does not grant access to private content. Missing read access generally returns 404; an authorized reader lacking an action gets 403. ACLs, inherited grants, publication, collections, and sharing have separate rules. Hidden ancestors are not disclosed. See [permissions](permission-inheritance.md) and [discovery](public-resource-discovery.md).

## Persistence and collaboration

Document metadata uses HTTP and version checks. All five editor formats use one host WebSocket lifecycle with format-specific Yjs codecs. The server validates content, rechecks authorization and commits before acknowledging; metadata version, content sequence, epoch, schema and history IDs are distinct. History is available for all formats, but restore currently supports rich text and Markdown only. See [collaboration](collaboration.md) and [document history](document-experience.md).

SQLite, AI and Webhook stores plus local files fit a single instance. PostgreSQL uses a separate Webhook database and an AI schema. Multiple replicas require a shared database, file backend and Redis for events, presence and limits. Without Redis, those implementations are process-local. Configured Redis failures do not silently fall back. Database jobs use leases/outboxes, not only process memory. See [configuration](configuration.md) and [horizontal scaling](horizontal-scaling.md).

Objects retain stable store IDs and object references. Environment configuration selects physical stores; the storage administration page is read-only. Private downloads recheck access. A CDN supplies expiring authorized URLs and never replaces storage. Backups include every database, referenced backend, plugin archive and protected configuration. See [file storage](storage.md).

Installed plugins use shared registry records and immutable archives, plus a writable per-instance cache restored on startup. Manual restart activates desired releases. Managed private SQL, objects and credentials are implemented; task draining, temporary workspaces and stronger process isolation remain gaps. Exact-version validation rejects unsupported baselines or structures; no migration or compatibility adapter is added here. Existing data must be preserved. See [release requirements](releases/0.1.10.md).

## Current limits and acceptance

Comment threads and notifications have dedicated paginated endpoints; document detail is not a complete comment export. Persistent offline outboxes, native device integration, live identity/AI providers, production S3/CDN, and target-infrastructure failover require separate work or acceptance. Automated isolated tests demonstrate their stated scope; a build does not prove all external services are operational.
