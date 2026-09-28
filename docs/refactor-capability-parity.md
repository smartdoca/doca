# Refactor capability parity inventory

This inventory records core behavior to verify during plugin-host integration.
Membership, commercial quotas and content moderation are intentionally removed;
old parity requirements for those features no longer apply. Mail server code,
UI, database tables, global bridges and sibling-package imports are removed;
future mail verification belongs to its independent plugin.
The new composition is active; each section remains a release gate until its
focused tests pass in the final verification run.

Baseline reviewed: current routes, web shell, and tests on 2026-09-25.

## Current composition baseline

`apps/server/src/app/create-app.ts` establishes Fastify/OpenAPI, Host and Origin
checks, cookie/bearer sessions, profile-completion gates, error normalization,
and close hooks. Domain routes are composed by
`apps/server/src/plugins/composition.ts` through PluginHost. Existing route
implementations are retained behind adapters while capability ownership moves
to files, documents, AI, and Search providers.

Registered route/service modules include:

- runtime settings, accounts, identity, registration review, and
  profiles;
- tickets/access requests, workspace/discovery, page state, experience, and
  templates;
- realtime collaboration, search/embeddings, knowledge, AI/MCP, and quick
  notes;
- assets, files, static delivery, and the file-processing
  worker.

The browser shell policy remains in `apps/web/src/app/app.tsx`, while typed
runtime plugin registries now contribute domain routes, navigation, admin
panels and renderers. Its
hash-route surface includes authentication completion, desktop/mobile document
shells, tickets, admin/account/preferences, home and document collections,
libraries and library settings/system pages, AI, quick notes, files/shared
files, trash, sharing, and resource/editor views.

Mobile retains only core built-in client manifests. No host mail routes or
source-package imports remain.

## Cross-cutting invariants

No route or UI extraction is parity-safe unless it keeps all of these:

- configured Host validation and same-Origin enforcement for browser writes;
- cookie and mobile bearer session behavior, profile-completion gates, and
  administrator checks;
- request schemas/body limits, public-vs-authenticated route distinctions, and
  normalized error statuses;
- resource authorization before disclosure or pagination;
- optimistic versions, transaction boundaries, audit/outbox behavior, and
  close-time cleanup;
- interface locale handling, entitlement checks, and current hash/deep-link
  behavior;
- collaboration epoch/schema/ACK, readonly, presence, recovery, and anchor
  contracts.

Plugin registration is not permission. A contribution consumer must pass the
same host-owned guards as first-party code.

## Capability inventory and evidence

### Identity, accounts, and admission

Baseline: password and external identity flows, contact verification,
registration review, profile completion, account security, admin user
management and mobile sessions.

Primary routes: `accounts.ts`, `identity.ts`, `registration-reviews.ts`,
`profiles.ts`, plus account/bootstrap routes in
`create-app.ts`.

Parity evidence includes `accounts-memberships.test.ts`, `identity.test.ts`,
`mobile-session.test.ts`, `service-credentials.test.ts`, and
`access-roles.test.ts`.

Potential seams: identity-provider, verification-delivery,
and admin-settings-section contributions. Session parsing, admission gates, and
account merging remain host policy.

### Resources, permissions, discovery, and experience

Baseline: personal documents and libraries, resource trees, ownership,
inheritance and direct grants, invitations/access requests, links, transfer,
move/copy/order, reactions, comments, notifications, trash, history, page
state, templates, and discovery.

Primary routes: content routes in `create-app.ts`, `workspace.ts`,
`discovery.ts`, `experience.ts`, `access-requests.ts`, `page-state.ts`, and
`templates.ts`.

Parity evidence includes `permissions-v2.test.ts`,
`permission-inheritance.test.ts`, `access-requests.test.ts`,
`document-default-permissions.test.ts`, `document-author.test.ts`,
`document-integration.test.ts`, `tree-order.test.ts`, `trash.test.ts`,
`history-retention.test.ts`, `comment-position.test.ts`, and
`experience.test.ts`.

Potential seams: template providers, metadata side panels, resource actions,
and reaction/comment renderers. Authoritative access queries and resource
transactions stay host-owned.

### Editors and realtime collaboration

Baseline: rich text, spreadsheet, Markdown, canvas, and presentation surfaces;
WebSocket persistence; selections/presence; comments and anchors; import/export;
history/rollback; and readonly behavior.

Primary integration points:
`apps/server/src/services/realtime/gateway.ts`,
`packages/core/src/modules/collaboration`,
`apps/web/src/features/documents/document-editor.tsx`, and the format-specific
editor components.

Parity evidence includes `collaboration.test.ts`, `editor-sessions.test.ts`,
`editor-presence.test.ts`, `document-integration.test.ts`, `markdown.test.ts`,
`sheet-collection.test.ts`, `canvas-native-elements.test.ts`,
`presentation.test.ts`, `comment-scroll.test.ts`, and
`package-upgrade.test.ts`.

Potential seams: editor-surface descriptors, toolbar commands, import/export
codecs, and readonly viewers. Any such extraction must continue to satisfy the
collaboration and editor-integration contracts; generic plugin lifecycle
success is not sufficient evidence.

### Search and knowledge

Baseline: permission-filtered keyword and semantic document search, filters and
excerpts, embedding configuration/application status, reconciliation/reindex,
knowledge records/subscriptions/graph, and AI/MCP search reuse.

Primary routes: `search.ts`, `search-embeddings.ts`, and `knowledge.ts`.

Parity evidence includes `search-engine.test.ts`, `search-filters.test.ts`,
`search-excerpts.test.ts`, `search-embeddings.test.ts`,
`search-reconciliation.test.ts`, `search-intent.test.ts`,
`knowledge-records.test.ts`, and `ai-embeddings.test.ts`.

Potential seams: search engines, embedders, rerankers, and knowledge
projectors. Candidate generation may be pluggable; authorization and
post-filtering remain host-owned.

### Files, assets, and storage

Baseline: authenticated uploads/downloads, immutable storage profiles, local
and S3 adapters, shared folders and permissions, Office/PDF/archive processing,
file search, thumbnails/previews, trash, and background extraction.

Primary routes/services: `assets.ts`, `files.ts`,
`runtime-settings.ts`, `stored-objects.ts`, and
`file-processing-worker.ts`.

Parity evidence includes `files.test.ts`, `file-import.test.ts`,
`file-interactions.test.ts`, `upload-storage.test.ts`, `storage.test.ts`,
`dwg-preview.test.ts`, and `ai-office-files.test.ts`.

Potential seams: storage backends, file recognizers/extractors, previewers, and
import handlers. Path safety, ACL, upload limits, SSRF boundaries, and stored
object identity remain host policy.

### AI, tools, and MCP

Baseline: provider/model configuration, secrets and quotas, streaming sessions,
history and attachments, web request/fetch/search, image insertion, document
read/edit tools, office-file generation, and the authenticated MCP endpoint.

Primary routes/services: `ai.ts`, `ai-mcp.ts`, and
`apps/server/src/services/ai`.

Parity evidence includes `ai.test.ts`, `ai-providers.test.ts`,
`ai-secrets.test.ts`, `ai-history.test.ts`, `ai-delivery.test.ts`,
`ai-attachments.test.ts`, `ai-edit-tools.test.ts`,
`ai-document-read.test.ts`, `ai-web-fetch.test.ts`,
`ai-web-request.test.ts`, and `ai-context-budget.test.ts`.

Potential seams: AI providers, tools, skills, and MCP tool contributions.
Credential lookup, raw usage accounting, tool authorization, and redaction remain
host-owned.

### Quick notes, tickets, and community

Baseline: quick-note CRUD and
compilation, public and authenticated tickets,
comments, and community notifications.

Primary routes: `quick-notes.ts`, `tickets.ts`,
and community routes in `create-app.ts`.

Parity evidence includes `quick-notes.test.ts`,
`quick-note-content.test.ts`, `tickets.test.ts`,
`community.test.ts`, and `online-users.test.ts`.

Potential seams: note processors, ticket handlers, and notification presentation. Access, retention, and
delivery guarantees remain host-owned.

### Web shell and settings

Baseline: hash/deep-link parsing, authenticated/public/mobile shells, global and
library navigation, account/admin settings, document modes, lazy editor and
quick-note loading, realtime invalidation, and entitlement-aware visibility.

Primary UI composition: `apps/web/src/app/app.tsx` and feature modules under
`apps/web/src/features`.

Parity evidence includes `header-layout.test.ts`,
`platform-polish.test.ts`, `page-state.test.ts`, `document-mode.test.ts`,
`document-scroll.test.ts`, `markdown-scroll.test.ts`,
`file-interactions.test.ts`, `ai-side-open.test.ts`, and `i18n.test.ts`.

Potential seams: navigation items, settings sections, document header actions,
editor toolbar commands, and route surfaces. The shell must retain one owner for
route precedence, authentication redirects, accessibility, locale, and layout.

## Extraction gates

A capability can move behind a plugin contribution only when:

1. a typed contribution point has one host owner and collision semantics;
2. its existing focused tests pass unchanged or are replaced by stronger
   equivalent tests;
3. startup failure and disposal leave no routes, timers, workers, handlers,
   providers, or UI registrations behind;
4. plugin dependency and required-service failures occur before serving
   traffic;
5. plugin-owned data starts from the current empty database baseline and a
   mismatched schema prevents startup;
6. application bootstrap still owns security and authorization policy;
7. the extracted contribution completely replaces the first-party registration.

The plugin foundation tests cover contracts, graph ordering, lifecycle,
injection, contribution collisions, dispatch, and cleanup. They do not count as
capability parity tests for any application feature listed above.
