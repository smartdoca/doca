# HTTP API v0.1

[中文](api.zh-CN.md)

AI sessions, model rates, and external MCP follow the current API routes, runtime configuration, and the web settings.

Document statistics, people who liked a document, revocable share links, and history snapshots are in [document interaction](document-experience.md#http).

Base URL is the same origin, `/api/v1`. The live request contract is `GET /api/openapi.json`, generated from the real route TypeBox schemas. It includes paths, parameters, and bodies. Responses and business rules are supplemented here. It is not yet a complete generated SDK.

## Conventions

- Except bootstrap, login, register, and public resource detail, a cookie session is required. Some handwritten OpenAPI GET operations do not mark security yet. The permissions below and the server checks win.
- The cookie name is `doca_session`. Same-origin browser requests send it. Do not put it in the URL or local storage.
- Every request Host must match `DOCA_ORIGIN`. Mutations also require an exact Origin match.
- JSON uses `application/json`. Uploads use `application/octet-stream`. Unknown fields are rejected. Names are 1–160 characters and not blank. A new password is 12–128 characters.
- Success is usually HTTP 200. Upload success is 201. A CDN read is 302. Failure is `{message, requestId}`.
- 400 is a bad parameter. 401 is signed out. 403 is missing permission or a bad origin. 404 is missing, unreadable, or deleted. 409 is a version or status conflict. 421 is a Host mismatch. 429 is rate limited. 500 is unexpected.
- Resources use UUIDs. Growing lists use an opaque `cursor`. `nextCursor=null` is the end. Bounded data such as body slices and external search results may still use offset.

## Accounts

| Method and path | Who | Request and response |
| --- | --- | --- |
| GET /bootstrap | Public | siteName, registrationEnabled, initialized, user, capabilities |
| POST /auth/login | Public | `{login,password}` to `{user}`, sets the cookie |
| POST /auth/register | Open registration | `{login,password,displayName}` to User. Does not sign in |
| POST /auth/logout | Signed in | No body. `{ok:true}`, revokes the session and clears the cookie |
| POST /auth/password | Signed in | `{currentPassword,newPassword}` to `{ok:true}`, revokes every session |
| GET /users/lookup?q= | Signed in | q at least 2 characters. Fuzzy name or exact account. At most 20 `{id,display_name}` |
| GET /admin/users?q=&cursor= | Administrator | Name filter, 100-row cursor page |
| POST /admin/users | Administrator | `{login,password,displayName}` creates an ordinary user |
| PATCH /admin/users/:id | Administrator | `{status:"active" or "disabled"}`. Cannot change yourself or another administrator |
| GET /admin/settings | Administrator | `{id:"system",site_name,registration:0 or 1,revision}` |
| PUT /admin/settings | Administrator | `{siteName,registrationEnabled,revision}` |

User is `{id, display_name, admin}`. The admin list also has login, status, and created_at. admin is 0 or 1. Passwords are not returned. Creating or enabling a user can also change the settings revision. After 409, fetch again. Do not replay automatically.

Sign-in providers, identities, and registration approval are in [authentication](authentication.md#http).

## Reading resources

`GET /resources` accepts `scope=mine|libraries|shared|favorites|all|trash`. Omitting it is all. `q` is a title substring. `format` is rich_text, spreadsheet, or presentation. `libraryId` limits documents inside a library. `cursor` is opaque. Pages are 100.

The resource list is for management and the tree. A non-empty `q` matches documents only, not library names. Content search uses the document search API below.

`GET /search/documents` returns documents only. A library is never a result item.

- `q` is a keyword or description, at most 500 characters. It does not match library titles. `mode=keyword|ai`, default keyword. AI uses the vector configuration from the last successful apply. Meilisearch builds the query vector and mixes retrieval with semanticRatio 0.8. If AI is unavailable the response is 503 with an explicit message. It does not silently switch to keywords. AI queries use the administrator minimum relevance, default 0.70, and may adjust a close semantic score by how well concrete words in the current body are covered. Word coverage cannot bypass the threshold.
- `scope=all|owned|shared|favorites|recent`.
- `location=personal|library`.
- `libraryIds` repeats, 1–50 readable libraries, as a union, intersected with scope, location, format, and q. It cannot be combined with `location=personal`.
- `format=rich_text|markdown|spreadsheet|presentation|canvas`. `offset` pages of 100.
- `ownerIds` repeats, at most 10, and only matches documents whose owner the current user may see.
- `visitedWithinDays` is 1–3650. `likedOnly=true` and `favoritesOnly=true` intersect with the other filters. The database candidate filter and the check after Meilisearch use the same conditions.
- The response is `{items,total,nextCursor?,nextOffset?,engine,mode,notice?}`. Database results use a cursor. A bounded external ranking uses offset. Every item is `kind=document`. `summary` is a hit excerpt from body text the caller can read. `summaryMatches` and `titleMatches` are `{start,length}` in JavaScript UTF-16 indexes. `inLibrary` says whether it is in a library. A document shared on its own can be found. If the caller cannot read the library, `library_id` and `libraryName` stay null. A private library id cannot be probed.

Library choices in the UI come from the accessible library list, not from search results. After entering a library, sidebar search defaults to that library and can be cleared. With no keyword and no filter, the dialog shows recent documents. After a filter, an empty keyword still applies the chosen conditions.

`GET /resources/:id` returns `{resource,ownerName,lastEditorName,lastEditedAt,comments,commentsNextCursor,grants,likes,liked,favorite}`. Last editor fields are null when history cannot confirm them. The owner is not substituted. Public resources allow anonymous access. Directory lists still require sign-in. Comments are oldest first, at most 200 per page. Grants are visible to managers and the owner.

A resource adds `role=reader|commenter|editor|manager|owner`. `parent_id` and `library_id` are null when the ancestor is not readable. Requests use camelCase. Current resource responses use snake_case.

Also `scope=recent|owned` and `kind=document|library`. `sort=created_at|updated_at|visited_at` and `order=asc|desc` are applied before paging. Lists add ownerName, libraryName, and visited_at. A library name is omitted when the library is not visible. Home tabs use `kind=document`. The library admin page still uses `scope=libraries`. `scope=libraries` returns libraries you own or where you were granted edit or manage on the whole library. A grant on one document does not return the parent library. That document is still available from `scope=shared&kind=document`. Commenting on a library returns 400.

`POST /resources/:id/visit` records a visit after rechecking read permission. `{ok:true}` does not change the resource version or `updated_at`.

## Create and lifecycle

| Method and path | Minimum permission | Request |
| --- | --- | --- |
| POST /resources | Signed in, and editor on the target | `{title,kind,format,parentId?,libraryId?}` |
| PATCH /resources/:id | editor | `{title,version}` |
| POST /resources/:id/move | manager of the whole subtree, editor on the target | `{version,parentId,libraryId}` |
| POST /resources/:id/copy | reader of the whole subtree. `includeChildren=false` requires manager of the current document | `{parentId,libraryId,includeChildren?}` returns `{id}` |
| POST /resources/:id/trash | manager of every child that is not deleted | `{version}` |
| POST /resources/:id/restore | manager of the restore batch | `{version}` |

`kind` is document or library. Libraries do not nest. A personal document requires `libraryId=null` and `parentId=null`. `parentId` points at a document in the same library. The create response has no role. GET the detail afterward.

A move inside a library clears direct grants on the moved subtree, sets custom plus invited, keeps each owner and the destination library's governance, and forbids cycles. Moving across libraries or out of a library also requires ownership of the current document and every child, plus management of the whole subtree. A personal document can be moved only by its owner into a library root or node where that owner is manager. Moving a library document back to personal is done by the document owner and flattens the subtree into independent personal documents. Copying only the current document does not copy children. Restore follows `delete_batch` and does not revive a child deleted earlier on its own. Restore the parent first. Copy creates independent ids and copies metadata, the tree, the body, and attachment references. It does not copy comments, permissions, or revocation history.

## Permissions and ownership

`PUT /resources/:id/permissions` requires manager. The body is `{version, accessMode, visibility, grants:[{userId, role}]}`. Grants replace the set, at most 100 distinct active users. Roles are reader, commenter, editor, and manager. Owner is not a grant. A directly invited manager cannot remove their own manager grant here.

`PUT /resources/:id/permission-sources/:userId` adjusts or deletes one source: `{revision, sourceType, sourceId, action, role, includeDescendants}`. `sourceType` is direct, link, or parent_override. `sourceId` is required for link. `action` is update or delete. One user can have one direct grant, one parent override, and several link grants. The list shows the highest combined permission. Deleting a direct grant on a library document keeps a disabled parent override so permission does not fall back. Deleting that override restores inheritance. Deleting a link source affects only that share link.

`POST /share/redeem` takes `{token, accept?, consume?}`. The server checks expiry, revocation, the member cap, and the caller's existing permission. If the caller already has at least the link's permission, `consume=false` returns `alreadyHasAccess:true`. `consume=true` uses a seat and records the source. After a link is revoked it cannot be used, but a new link can grant access again.

`accessMode` is inherit or custom. `visibility` is invited, authenticated, or public. A root cannot inherit. custom plus invited with no invitations is private. The library owner still governs documents in the library.

`POST /resources/:id/transfer` is owner only: `{version, userId, retainAccess}`. For a personal document the target must already be a collaborator. Success is `{ok:true}`. `retainAccess=true` leaves the previous owner as manager. `false` removes their direct grant and does not cancel access that comes from inheritance, public scope, or library ownership.

## Comments and reactions

| Method and path | Minimum permission | Body |
| --- | --- | --- |
| PUT /resources/:id/reaction | reader | `{kind:"like" or "favorite", enabled}` |
| POST /resources/:id/comments | commenter | `{body, parentId}` or rich body. Optional anchor on a selection root, JSON at most 12000 characters, fields blockId, quote, start, end |
| PATCH /resources/:id/comments/:commentId | commenter, then author or manager | `{version, body?, deleted?, resolved?}` |

A new comment returns `{id}`. Other calls return `{ok:true}`. Plain text is 1–5000 characters with one reply level. Only the author changes the body. The author or a manager deletes or resolves. You cannot reply to a reply or to a deleted or resolved thread. PATCH uses the comment version, not the resource version. Send one action at a time. A reaction is a target state, not a toggle. The list of people who favorited a document is not public.

Rich comments, public ids, directory policy, and notification fields are in [comments and community](comments-and-community.md). The older plain-text comment body remains compatible.

## Notifications

`GET /notifications?offset=` returns the latest 50: `{items, unread, nextOffset}`. `POST /notifications/read` takes `{ids}` of 1–100 UUIDs and changes only the current user's notifications. A durable notification pushes `notifications.changed` on the WebSocket, then HTTP reads the list the user may see. Read state is persisted. Reconnect refetches. The socket event is not the only source.

## Workspace

- `GET /me` returns `{user, preferences}`. Preferences include avatar, theme, density, default_sort, sort_order, and version, default 0.
- `PUT /me/profile` takes `{version, displayName, avatar, avatarAssetId?}`. avatar is initials or a preset id. avatarAssetId is an avatar asset the user uploaded, null clears it, and omitting it keeps it. External image URLs are rejected.
- `PUT /me/preferences` takes `{version, theme, density, defaultSort, sortOrder}`. theme is light or soft. density is comfortable or compact. A stale version is 409.
- `POST /me/heartbeat` every 60 seconds while the page is visible.
- `GET /admin/stats` is administrators only: documents, libraries, users, online, and onlineWindowSeconds 0. Counts exclude trash. online deduplicates user ids on real WebSocket connections. An HTTP heartbeat is not online.

`GET /users/:id/profile` returns id, display_name, avatar, and avatar_asset_id. It does not return a password, session, or email.

## Search administration

`GET /admin/search` returns configuration and index status, not the API key. It includes image recognition flags, reconcile interval, and reconciliation progress. `PUT /admin/search` takes `{enabled, endpoint, indexName, imageRecognitionEnabled?, reconcileIntervalHours?}`. Image recognition defaults off and does not run a recognition pipeline yet. The interval defaults to 6 hours, range 1–168. The endpoint must be in `MEILI_ALLOWED_ORIGINS`. The index name is letters, digits, underscore, and hyphen. Enabling or changing the connection probes health and builds the index in the background. Changing the connection while indexing returns 409.

`POST /admin/search/reindex` and `POST /admin/search/reconcile` return `{accepted:true}`. Reconcile returns 409 when search is off. Scan state is stored in the business database and continues after restart.

Embedding routes let an administrator choose an enabled vector model, apply or delete a named embedder, and set `minScore` from 0 to 1. Secrets, custom REST requests, and headers are not returned. Apply and delete are asynchronous Meilisearch tasks. `needsApply` is shown when the model address, key, or dimensions change. Nothing is recomputed automatically. Details of generation and task status match the Chinese API page and the OpenAPI document.

Keyword search may fall back to the database and say so in `notice`. AI mode needs an available vector model. Meilisearch order is kept. Snippets come from the current body after the permission check. Candidate ids are loaded from the database and passed as a Meilisearch filter. Above 1,000 candidates, keyword mode degrades and AI mode asks for a smaller library scope.

Agent and MCP `knowledge_search` uses the same search, with query, mode auto, keyword, or ai, libraryId, and offset. auto prefers AI and uses keywords with a notice when vectors are not configured. Authorization applies before retrieval and paging. Full content uses document read, not the snippet.

## Files

| Method and path | Who | Contract |
| --- | --- | --- |
| POST /assets?purpose=&filename=&resourceId= | Signed in. Attachment requires editor. Cover requires manager | purpose is avatar, cover, or attachment. Avatar omits resourceId. Others require it. Binary body. 201 returns `{id,url,filename,mime,size}` |
| GET /assets/:id/content | Asset permission | Streams the file, or 302 to a 60-second signed URL when a CDN is configured |
| GET /resources/:id/assets | reader, anonymous if public | Latest 200 document attachments |
| PUT /resources/:id/cover | library manager | `{version, assetId}` uuid or null. 409 if stale |
| GET /admin/storage | system administrator | `{id,config,managedBy,credentialRefs,cdnSigningReady,maxUploadBytes}` without secrets; managedBy is environment |
| PUT /admin/storage | system administrator | 405: storage is configured through deployment environment variables |

Set `DOCA_FILE_STORE_ID` and versioned `DOCA_FILE_STORES_JSON` in the deployment environment. The read-only response excludes local root and private signing material. The database stores stable IDs and object references. See [file storage](storage.md) for local/S3 configuration and optional CloudFront signing.

Avatar and cover uploads accept PNG, JPEG, WebP, and GIF, at most 5 MB. Attachments are at most 20 MiB. Avatar/cover images are normalized to WebP with metadata removed; ordinary attachments preserve their original bytes. A successful upload does not bind an avatar or cover. That needs the matching PUT. An attachment belongs to the resource immediately. 413 is the body limit. 429 is the upload limit. An asset id is not a public file URL. Copying a resource creates new asset ids and permission links and reuses the immutable stored object.

## Operations

`GET /health` is not under `/api/v1`. It checks the database and returns `{status:"ok", version:"0.1.10"}`, and it also checks Host.

The edit flow is GET the latest object, submit with version, and refresh on success. 409 asks the user to refresh. It does not overwrite. `version` is metadata only. It is not the Yjs state or a backup version. Rich text collaboration and external OIDC sign-in exist. Administrators register webhook URLs and request headers from Hook. The POST body is documented in [Webhook delivery](webhooks.md). Backup and acting as an OIDC provider do not. `bootstrap.capabilities` reports actual capabilities.

WebSocket `/api/v1/ws` is specified in [collaboration](collaboration.md). Only document editing bytes use the socket. Management stays on HTTP.

User cards: `GET /api/v1/user-card-settings` reads the site card. `PUT /api/v1/admin/user-card-settings` accepts `{enabled, text, style, url, revision}`. style is primary, secondary, or link. A conflict is 409. `{userId}` is the public id and `{uid}` is the internal UUID. Both are URL-encoded. Only HTTP(S) or an in-app relative path is allowed.

Distribution, invitations, references, and forced download are in [editor integration](editor-integration.md#api).

## AI sessions and approval

`POST /api/v1/ai/sessions/:id/messages` may pass `currentResourceId`. `references` are only what the user attached. `scope=document` allows the current document, documents previously mentioned in the session, and approved documents. `scope=all` is still limited by the user's ACL. A retry keeps the server's original task scope.

`POST /api/v1/ai/jobs/:id/approval` accepts `{approvalId, approved}`. Only the job's user may decide. A repeated identical decision is idempotent. A cancelled job or a conflicting decision is 409. Another user is 404. Actions include create, move, session document access, and requesting permission from a document manager. Create and move are bound to the original parameter summary. A session approval does not change the user's own permissions.

`document_request_access(resourceId, role:reader|editor, reason)` requests session authorization when the user already has that permission. Otherwise, after the user confirms, it calls the platform access request. `pending_document_owner` is not approval. There is no AI tool that deletes a resource.
