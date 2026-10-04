# HTTP API

[中文](api.zh-CN.md)

This is an index of principal host 0.1.10 routes. The running `/api/openapi.json` describes registered routes and schemas; server code defines authorization, unannotated fields, and behavior limits. Former interfaces are retained in [research](research.md) and cannot be assumed available today.

## Conventions

Table paths have the `/api/v1` prefix. Browsers use HttpOnly session cookies; writes require the configured Host and same-origin Origin. Native clients use host-authenticated Bearer sessions; plugin WebViews use scoped plugin sessions. Public resources expose only their authorized read paths.

Metadata `version`, configuration `revision`, and content `seq`/`epochId` have different roles. Read current values before writing. A 409 indicates a conflict or unsupported protocol/state, never permission to overwrite. Pagination varies by route; follow `nextCursor` or `nextOffset`. Missing content access generally returns 404; system administration grants no private-content access.

## Accounts and administration

| Route | Purpose and permission |
| --- | --- |
| `GET /bootstrap` | Current user, site, capabilities, loaded plugins; no secrets |
| `POST /auth/login`, `POST /auth/logout` | Password login / logout |
| `POST /auth/register` | Registration under admission policy; pending receives no session |
| `GET /me` | Own profile and preferences |
| `GET /auth/providers` | Available identity providers |
| `GET /admin/users` | Administrator user query with status/q/cursor |
| `PATCH /admin/users/:id` | `{status:active\|disabled}`, ordinary user enable/disable; pending requires registration review |
| `GET /admin/registration-reviews` | Administrator review list |
| `POST /admin/registration-reviews/:id` | `{decision:approved\|rejected,message?}`, dedicated review |
| `GET /admin/stats` | Aggregate statistics without content permission |

Contact verification, recovery, identity linking, security verification, account policy, and callbacks are in [authentication](authentication.md). Platform credentials use [service settings](service-credentials.md); plugins use a separate [encrypted credential service](plugin-credentials.md).

## Documents, permissions, and history

| Route | Purpose |
| --- | --- |
| `GET /resources`, `GET /resources/:id` | Authorized list / detail |
| `POST /resources` | Create document/library; document format is rich_text/markdown/spreadsheet/presentation/canvas |
| `PATCH /resources/:id` | Metadata update with version |
| `PUT /resources/:id/permissions` | Permission configuration with version |
| `POST /resources/:id/transfer`, `POST /resources/:id/move` | Ownership transfer / move |
| `POST /resources/:id/copy` | Independent copy |
| `POST /resources/:id/trash`, `POST /resources/:id/restore` | Trash / restore |
| `GET /resources/:id/versions`, `POST /resources/:id/versions` | History / manual snapshot |
| `GET /resources/:id/versions/:versionId` | Preview; spreadsheet/slide/canvas canRestore is false |
| `POST /resources/:id/versions/:versionId/restore` | `{expectedSeq}`, manager restore for rich text/Markdown |
| `POST /share/redeem` | Signed-in preview or acceptance of a document/Q&A link |

Content editing uses `/api/v1/ws`; see [collaboration](collaboration.md). Fields, grant sources, and inheritance are in [permissions](permission-inheritance.md). Sharing and history are in the [document guide](document-experience.md).

## Comments, notifications, and discovery

Create a comment with `POST /resources/:id/comments` and `{richBody,parentId,anchor?}`. `richBody` is a version 1 structured comment; the former plain-text `body` request is rejected. Update with `PATCH /resources/:id/comments/:commentId`, supplying comment version and richBody/deleted/resolved. Single-level replies, images, mentions, and anchors are described in [comments and notifications](comments-and-community.md).

Notifications use `GET /notifications`, `POST /notifications/read`, and `POST /notifications/read-all`. WebSocket invalidations trigger a fresh authorized read. Discovery, collections, recent activity, and invitations are in [discovery](public-resource-discovery.md); references and asset downloads are in [editor integration](editor-integration.md).

## Search

`GET /search/documents` searches currently readable documents. Keyword mode may fall back to the database with a notice; vector mode requires available Meilisearch and models. Results recheck current access; index inclusion grants no permission.

Administration uses `GET/PUT /admin/search`, `POST /admin/search/reindex`, `POST /admin/search/reconcile`, `/admin/search/embeddings`, `/admin/search/embeddings/status`, and `/admin/search/relevance`. A 202 configuration result means queued; query task completion. Model or credential changes require applying the settings again. The image-recognition policy currently saves configuration only; enabling it does not activate an OCR pipeline for search.

## Files and storage

Asset upload uses `POST /assets?purpose=&filename=&resourceId=` with avatar/cover/attachment/comment_image and purpose-specific authorization. Download uses `GET /assets/:id/content`, with `?download=1` for attachment disposition. Avatar/cover/comment images allow 5 MiB; document attachments allow 20 MiB. Ordinary platform files use `/files` routes with separate limits and multipart workflows.

`GET /admin/storage` reports the deployment backend; `PUT /admin/storage` returns 405. Environment variables configure backends and credentials; see [file storage](storage.md).

## AI, knowledge, and plugins

AI sessions and jobs use `/ai`. Tools honor session scope, actual resource permissions, and approval. `POST /ai/jobs/:id/approval` takes `{approvalId,approved}` from the job's owner; approval does not change resource ACLs.

Curation, bot API/MCP, independent keys, and streamed answers are in [knowledge curation](knowledge-studio.md). Unified sources use `/content`; see the [content protocol](plugin-content.md). Installed plugin business routes use `/plugins/:pluginId/...` and depend on the loaded release. The host has no quick-notes or mail business API; see [capabilities and limits](features.md).

## Health and source

`GET /health`, `GET /live`, and `GET /ready` omit the `/api/v1` prefix and report host version. Readiness checks the database and configured Redis; it does not verify every external service.

Source: [application](../apps/server/src/app/create-app.ts), [route directory](../apps/server/src/routes), [history](../apps/server/src/routes/experience.ts), [realtime gateway](../apps/server/src/services/realtime/gateway.ts).
