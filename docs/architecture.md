# Architecture and implementation boundaries

[中文](architecture.zh-CN.md)

This is the entry point for the current module layout, queries, and consistency rules. The database and each module follow the source and the current schema.

Version 0.1.0. This page describes the code as it is. Desktop and DSH remain product designs. There is no runtime adapter for them.

## 1. Decisions

The sidebar order is search, home, AI assistant, quick notes, libraries, and trash. Inside a library the sidebar becomes that library's table of contents. A personal document opens as its own page without that sidebar. A library document keeps the library contents. Home has four tabs: recent, owned by me, shared with me, and favorites, with type and time sorting. A creation calendar is not part of the core. A plugin may add that page later.

A profile has a display name, a preset or uploaded avatar, and a password change. A library can have a cover. The document body and the admin pages share attachment upload and download. Admin navigation is separate: overview, users, sign-in and registration, file storage, document search, and Hook. Hook registers callback URLs for background delivery. Admin statistics are aggregate counts. An administrator does not gain the right to read private documents.

Doca is a TypeScript modular monolith, not a set of microservices. The web app and the server live in one repository with separate directories and builds. Development uses two ports. The browser always uses one origin. In production the server can serve the built web app. Cordis owns the in-process context, services, effects, and lifecycle. The Doca SDK owns the stable contract.

```text
Browser (React / Vite)
    │ same-origin HTTP JSON / WebSocket + HttpOnly session cookie
    ▼
apps/server — Host/Origin checks, sign-in, validation, HTTP routes, static files
    ▼
PluginHost — discover, initialize, mount, ready, dispose in reverse order
    ├── AIHost / SearchHost
    ├── plugin-files (files.v1)
    ├── plugin-documents (documents.v1 / knowledge source aggregation)
    ▼
packages/core — accounts, permissions, domain rules, transaction boundaries
    ▼
packages/db — Kysely types, the current schema, SQLite / PostgreSQL drivers
```

The server is the HTTP handler and middleware layer. Core is the domain layer. The db package is the model and access layer. TypeScript checks compile time. TypeBox schemas check requests at runtime. Do not trust the browser alone.

## 2. Directories

| Path | Responsibility |
| --- | --- |
| apps/server/src/main.ts | Assemble services, the dev proxy, and shutdown |
| apps/server/src/bootstrap/config.ts | Validate configuration and connect the database |
| apps/server/src/app/create-app.ts | API, session, and security boundary; tests can inject it without listening |
| apps/server/src/bootstrap/admin.ts | Create the first administrator explicitly |
| apps/web/src/app/main.tsx | Mount the root component |
| apps/web/src/app/app.tsx | Routes, global state, and cross-feature assembly |
| apps/web/src/features/documents/tree.tsx | The permission-filtered tree |
| apps/web/src/features/documents/dialogs.tsx | Grants, transfer, and move confirmation |
| apps/web/src/features/admin/admin.tsx | Users, site settings, and the registration switch |
| packages/core/src/modules/identity/passwords.ts | Password derivation and account creation |
| packages/core/src/workflows/resources.ts | Resource rules, ACL, transactions, and audit |
| packages/db/src/create-schema.ts | The current baseline schema for a new database |
| tests/cloud.test.ts | API integration tests on a temporary database |

The web app does not import the server database or password modules. It uses HTTP DTOs. Web, core, and db imports use the `@web/*`, `@core/*`, and `@db/*` aliases. `apps/*` and `packages/*` are workspace packages, built and tested by the root scripts.

```text
apps/web/src/
  app/       entry and global assembly
  features/  product pages and local styles
  shared/    API, components, hooks, utils
  styles/    global theme

apps/server/src/
  app/       Fastify, request context, security
  routes/    HTTP routes
  services/  AI, search, notes, collaboration
  adapters/  storage, identity, messaging
  jobs/      background work
  bootstrap/ startup configuration and the administrator
```

## 3. Identity, security, and permissions

- One deployment has one account system. There are no app, space, tenant, or organization tables.
- The first start does not create a default account. An administrator is created by a server command. Registration is closed by default.
- Passwords use a random salt and scrypt. The session cookie is a random credential. The database stores a SHA-256 digest. A session lasts 8 hours.
- Changing the password revokes every session. Disabling a user revokes sessions and blocks later access.
- Every request checks the configured Host. Mutations also require the same Origin. Cookies are HttpOnly and SameSite=Strict, and Secure on HTTPS.
- The body cannot set `owner_id`, a role, or arbitrary fields. Identity comes from the session. The server decides who created a resource.
- An administrator does not automatically receive content access. No read right is a uniform 404. A read right without the requested action is 403.
- Sharing one document does not reveal its ancestors. `parent_id` and `library_id` are null when the caller cannot read the ancestor. Search filters by permission before paging.
- A notification stores the event type and the resource reference, not a title or comment body that might leak. Opening the resource checks access again.

Roles are reader < commenter < editor < manager < owner. Visibility grants at most reader. A library document with inherit takes the parent document or library permission. An owner above the document is at most manager on the child. A direct invitation can be added. A personal document is always custom and does not inherit ordinary members. The document owner always has full rights. The library owner always keeps management inside that library. Named grants, parent and child calculation, and share revocation are in [permission inheritance](permission-inheritance.md).

Transferring a document does not transfer ownership of other documents in the tree. Transferring a library changes library governance and does not rewrite each document's `owner_id`.

## 4. Consistency

- Metadata changes carry `version`. The server compares it and then updates. A stale write returns 409 and does not overwrite silently.
- The resource tree, ACL, and batch delete or restore finish in one transaction. Audit and notifications commit or roll back with the change.
- Business transactions do not use the settings row as a mutex. PostgreSQL uses serializable transactions and retries conflicts. SQLite uses a connection transaction. A document acknowledgement is sent after a durable commit.
- A single-document operation loads the target and the ancestors it needs. A tree change loads the affected subtree. Lists filter permissions in SQL and then page. Discovery and recent visits are separate from access rights.
- Likes and favorites use a composite primary key and a target-state API, so a repeated request does not double-count.
- A move requires management of every affected child, and cycles are rejected. The current behavior resets sharing on the moved subtree to private, clears direct invitations, and keeps each owner and the destination library's governance. The user must confirm.
- Delete moves the document to the trash. `delete_batch` records that batch. Restore does not revive a child that was deleted earlier on its own.
- An ordinary copy creates new resource ids, remaps structure and asset ids, belongs to the copier, and is private. The body gets a new Yjs identity. Grants, comments, reactions, and revocation history are not copied.

## 5. What exists, and what does not

Real data is wired for local accounts, sign-in and sign-out, password change, the registration switch, and enabling or disabling users; personal document lists, the library tree, title search, and type filters; permissions, transfer, move, independent copy, and trash; comments, a single reply level, resolution, likes, and favorites; the notification list and read state; and system configuration.

Still needs deployment or an external integration:

- A full desktop offline runtime. Rich text, Markdown, spreadsheets, canvas, and their collaboration protocols are connected.
- Acting as an OIDC provider, SAML, and account recovery. External OIDC and social sign-in adapters exist. Live vendor credentials and deployment checks are still required.
- Production AI providers, external MCP clients, and a Meilisearch cluster. AI, MCP, session events, import and export, attachments, and database search fallback exist in code.
- Desktop, DSH, and device binding.

Comment detail currently returns at most the earliest 200 comments. The notification API is paged. The UI shows the latest 50. The tree pages through resources the caller can access. These are current capacity limits, not the final product limits.

## 6. Later work

Production acceptance of the editor packages, account recovery, live SSO, hardening, and comment paging come first. Desktop, DSH, and backups wait until the cloud deployment has been tested.

## Uploads, sign-in, and collaboration

`apps/server/src/routes/assets.ts` validates uploads, checks the resource ACL, and records assets. `storage.ts` reads and writes local files or S3 and signs CDN URLs. The current configuration chooses where new uploads go. Each asset keeps an immutable `storage_profile`. Switching configuration does not move old objects. Avatars, covers, and document images use the same entry. Private objects are read through the backend. A CDN is an optional short-lived signed cache, not a public directory. See [file storage](storage.md).

SSO has two directions. The current external identity key is `provider_id` plus `subject`. A provider is an immutable type, issuer, and client id. Accounts are not merged by email. OIDC is validated with `openid-client`. The site keeps its Strict session and same-origin completion. Doca is not an OIDC provider. Identity sources, approval policy, and deployment are in [authentication](authentication.md).

`#/admin`, `#/account`, and `#/preferences` use their own settings shell and do not render the document tree. Identity adapters are in `apps/server/src/adapters/identity-providers.ts`. Policy is in `packages/core/src/modules/identity`. Pages are in `apps/web/src/features/auth/authentication.tsx`.

Document collaboration uses WebSocket. Metadata stays on HTTP. The server validates updates, checks access, broadcasts, persists, and builds recovery state. Each editor package parses its own anchors. Metadata `version` is not a Yjs state vector. See [collaboration and search](collaboration.md).

The default deployment is one process without Redis. Broadcast, presence, and limits stay in that process. With Redis, the same interfaces use a cross-instance bus, presence, and global limits. Document updates are still committed in the database. Several replicas also require PostgreSQL and shared object storage. Schema creation and replica startup are separate. See [horizontal scaling](horizontal-scaling.md).

Webhooks use a separate database for subscriptions and deliveries. The business transaction only appends the existing outbox. After commit, a background worker posts matching events with the headers configured for that callback, then retries and records the result. Callback URLs may be public or on the same machine and private network. The business transaction does not call the network.
