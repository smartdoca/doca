# Comments, user visibility, and notifications

[中文](comments-and-community.zh-CN.md)

## Data

The current baseline supports SQLite and PostgreSQL:

- `users.public_id` is a unique user id separate from the internal UUID. It is normalized to lowercase on create, 3–160 characters, letters, digits, and `._@+-`. A unique index enforces it. Registration and administrator creation may set `publicId`. If omitted, the login is used. It does not change when the display name changes.
- SSO uses `preferred_username` from a verified OIDC identity, or `login` from GitHub, otherwise the subject. If that value is invalid or already taken, an identifier is generated in the provider namespace. Accounts are never merged because of the same name, email, or public id. The authentication link remains provider plus subject. Linking a new sign-in method does not change the original user id.
- `users.directory_mode` may be null, which follows the site `settings.directory_mode`.
- `comments.body_json` is the rich comment JSON. `body` is derived plain text for search, summaries, and notifications. A comment that is not deleted must have valid `body_json`.
- `notifications` add `actor_id`, `comment_id`, and `dedupe_key`. The event and the business change commit together. The unique `dedupe_key` index stops duplicate events.

A rich comment is version 1, with paragraph blocks of text and mention children, and image blocks. The server fills mention names and ids from the user table and does not trust the client label. One comment is at most 5,000 characters, 9 images, and 50 blocks. An image must belong to the current resource and be a valid `comment_image` or image attachment. Upload still uses private storage, image cleaning, and authorized download. A commenter may upload a comment image and cannot use that to upload or change a body attachment.

## Who can be found

Administrators set user visibility, with a site default and a per-user override:

| Mode | New-user candidates |
| --- | --- |
| all | Active users of the site |
| related | Users who currently share an explicit permission on a document or library, including inheritance, library ownership, and valid link members |
| none | No candidates. A user UUID cannot be typed in to add a permission or a mention |

Public and signed-in visibility do not create a relationship. Revoking permission removes the relationship. Existing permissions can still be changed or revoked. Existing comments and body mentions do not disappear because the policy tightened. The administrator user list is not limited by this search policy.

Routes are under `/api/v1`:

- `GET /users/lookup?q=` searches active users in the caller's scope and returns id, public_id, display_name, and avatar fields. Account and id prefix match. Display name is a fuzzy match. At most 20 items. Search wildcards are ordinary text.
- `GET /admin/directory-policy` returns `{mode, revision}`.
- `PUT /admin/directory-policy` takes `{mode, revision}`. A version conflict is 409.
- `PUT /admin/users/:id/directory` takes `{mode: "all" | "related" | "none" | null}`. null follows the site again.
- `GET /me`, `GET /users/:id/profile`, and the administrator user list include `public_id`.

## Comment interaction

Edit mode appends a comment icon at the end of the editor's floating selection toolbar. Readonly mode shows the comment icon alone, without formatting tools. Submitting requires commenter or higher.

The browser selection maps to a Slate range, then to the editor's Yjs relative-position anchor. The current anchor is inside one paragraph or block. A selection that crosses blocks asks the user to select again. It is not silently truncated.

Each unresolved root thread whose original text still exists is its own card. The default mark is a yellow underline. Clicking the text or the card highlights both. Position is measured again on scroll, zoom, and collaboration updates.

If the original text is deleted, the anchor is invalid, or the root comment is deleted or resolved, the card and highlight hide. The database keeps the comment for history and audit. Undoing the deletion can show an unresolved comment again when the anchor is valid.

Full-document comments and selection comments share the rich composer: @ search, image upload, edit, reply, delete, and resolve. The edit version check remains. A failed submit does not clear the input.

- `POST /resources/:id/comments` takes `{richBody, parentId, anchor?}`. A reply stays in the root comment's thread.
- `PATCH /resources/:id/comments/:commentId` takes `{version, richBody?, deleted?, resolved?}`.
- `POST /assets?purpose=comment_image&resourceId=...&filename=...` uploads bytes, at most 5 MB. The server validates the image and access.

An @ in the document body uses the editor mentions extension. Candidates come from the same scoped lookup. A mention node stores the user UUID, not only the display name.

## Notifications

Events include `comment.created`, `comment.mentioned`, `document.mentioned`, `resource.permissions_changed` for a new invitation, `like.added`, `favorite.added`, and ownership transfer.

- The actor is not notified. Someone mentioned in the same comment who is also the owner or the person being replied to receives only the mention, not an extra ordinary comment notification.
- A mention does not grant access. The recipient must be an active user and must be able to read the document when the comment is submitted. Otherwise the notification is skipped.
- A new body mention is detected by the stable mention node id. Mentioning the same user on another new node notifies again. Replaying an old update or editing ordinary text does not.
- Listing notifications checks document permission again. After revocation or deletion, related notifications are hidden and do not count as unread.
- WebSocket sends `notifications.changed` as an invalidation. The client refetches its own list. The body is not broadcast. Offline events are already in the database and are fetched after reconnect.
- `GET /notifications?offset=0` returns `{items, unread, nextOffset}`, 50 items per page, including the actor and document title.
- `POST /notifications/read` takes `{ids:[]}`, at most 100, and updates only the caller's notifications.
- `POST /notifications/read-all` takes `{}` and marks all of the caller's notifications read.

These are in-app notifications. They do not send email, SMS, or a third-party push. A single-instance WebSocket deployment does not add a multi-instance bus by itself. Several replicas use the setup in [horizontal scaling](horizontal-scaling.md).

## Verification

Tests cover public-id conflicts, SSO identifiers, visibility and per-user overrides, public documents that are not related, permission bypass, structured comments, image isolation and commenter upload, notification deduplication, skipping users without access, hiding notifications after revocation, updating only one's own read state, collaboration replay, and a repeated @.

Browser checks use an in-memory document and simulated users. They do not write test comments into a real document. They confirm the toolbar button, the readonly button, rich mentions, yellow highlight in both directions, hiding on resolve, and hiding when the original text is deleted.
