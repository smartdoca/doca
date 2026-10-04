# Document interaction, sharing, and history

[中文](document-experience.zh-CN.md)

## Editing and navigation

Choosing document, spreadsheet, or slides from "+" creates it immediately. A new document is named "Untitled" and the rich text title is empty. `firstLineTitle` is enabled. After a valid Yjs update the server takes the title from the first line, at most 160 characters, and falls back to "Untitled" when it is blank. The top bar updates immediately. The tree name refreshes 1.5 seconds after the title changes. Spreadsheet and slides entries can be created. Their editors are connected through the published packages. Treat an older note that says they are not connected as outdated where the current package is installed.

The editing area is at least 540 px and grows with the available height. Empty space restores the caret at the end. There is no separate attachment upload strip. Images and attachments are inserted from the editor menu. Opening a document expands the next level and the ancestors. The fixed top bar limits the title width and shows an ellipsis. Last-edited information is underneath. Avatar, notification, and more menus close on outside click, blur, and Esc.

Like avatars show 8 people by default. The rest is an ellipsis that pages through everyone. Existing likes and comments are unchanged.

## Revocable link grants

The share switch, link role, inviting a collaborator, collaborator role, and removing a collaborator save immediately. There is no extra confirm at the bottom. Repeated submits are disabled while saving. The server version check prevents overwriting a concurrent edit. Failure restores the last confirmed server state and shows the error. Removing a link grant does not remove an explicit invitation.

Direct invitations and people who redeemed a link are both rows in `grants`, distinguished by `source_type` and `source_id`. `share_links` stores only the public link configuration. A person who redeemed a link keeps the link source and share id. The public link configuration is not mixed with one user's grant adjustment. The design record for the unified grant table is kept with the Chinese permission notes.

- A link is `#/s/{token}`. The token is 32 random bytes in the URL fragment, not an HTTP query parameter. After sign-in it is redeemed with a same-origin POST.
- The current link requires sign-in and supports reader, commenter, editor, and manager. Anonymous public reading still comes from visibility.
- The link table stores the token and a SHA-256 index. Only a manager API returns the token. Do not put the token in a resource projection, audit log, or search index. Database backups are sensitive.
- A permission change applies immediately to people who already redeemed. Turning the link off revokes permissions derived from it. Turning it on creates a new token and generation. Old links and old redemptions stop working. `revision` is independent of generation so concurrent configuration does not overwrite itself. A conflict is 409.
- Turning a link off does not change ownership, direct invitations, or parent inheritance. Revoking a link deletes the grant source for that share id and records one revocation. The user can receive access again from a new share id. A manager can change collaborator permissions. Transferring ownership is still owner-only. Moving a document subtree closes related links, matching the older reset-to-private behavior.
- Body, tree, search, and attachments query effective permissions together. WebSocket writes and pushes recheck access. A connection with no other access is closed when the link is turned off. Bytes already downloaded cannot be recalled.

## Information and history

- Visit count, likes, favorites, and comment count are visible to anyone who can read.
- Visit and operation records are visible to managers and the owner, 100 rows per page. Visit events start from this upgrade. Old recent-visit data is not presented as a complete history.
- `document_versions` stores a full Yjs checkpoint that incremental compaction does not overwrite. One is created every 50 valid updates, or on the next valid update more than 5 minutes later. An editor can also save manually. The operation log is aggregated with automatic snapshots. It is not written on every keystroke.
- Viewing history uses the current document permission and shows a readonly text preview of the body at that time. It does not replace the document that is being collaborated on. Restore is not offered yet. Snapshots that were not kept before the upgrade cannot be reconstructed.

Presentation mode uses the browser fullscreen API, hides the admin bar, tree, and comments, and makes the editor readonly. Esc leaves it.

## HTTP

Writes use the same origin and a valid sign-in. The prefix is `/api/v1`.

| Route | Purpose |
| --- | --- |
| GET /resources/:id/likes?cursor= | People who liked, first-page total, nextCursor |
| GET /resources/:id/share-link | A manager reads the link configuration and current token |
| PUT /resources/:id/share-link | `{enabled,role,version}` returns a new version and link configuration |
| POST /share/redeem | `{token}` returns the resource id |
| GET /resources/:id/info?tab=stats\|visits\|audit&cursor= | One tab: statistics or a paged record |
| GET /resources/:id/versions?cursor= | Snapshot metadata and nextCursor |
| POST /resources/:id/versions | An editor saves the current snapshot |
| GET /resources/:id/versions/:versionId | Readonly historical body |

Editors are the published `@smartdoca/*` packages locked in this repository. Do not follow an older checkout that pinned a private tarball.

## Immediate actions and dialogs

- A dialog closes on the backdrop or Escape. An action inside it does not close it by accident. Focus is restored and Tab stays inside.
- Choosing an avatar upload saves automatically. A preset avatar saves on click. Failure shows an error. Upload and asset permission rules are unchanged.
- Hovering a display name shows an edit icon. Enter or blur saves. Escape cancels. Enter during an input-method composition does not submit early.
- Theme, density, and sort preferences save when chosen. A profile update refreshes the avatar and name cache on the current page.
- Collaborator search runs 300 ms after typing. A stale request is cancelled so an old result cannot replace a new one.
- Delete, transfer, move that resets permissions, password change, and unlinking a third-party account keep an explicit button or confirmation. They are not silent submits.

## Verification in this round

Two pages of the same account were checked for body and code-block cursors and name colors, changing only the selection. An in-memory page checked avatar and name autosave, the share switch succeeding and rolling back on failure, and independent comment cards that do not overlap. Automation covers readonly cursor rejection, server identity that cannot be forged, cleanup on session exit, cursors that do not write the document version, and rich text and mention UTF-16 offsets that follow relative positions.

If local development still loads an old prebuilt dependency, restart once with `DOCA_REBUILD_DEPS=1 pnpm dev`. A real Chinese input method and cross-browser checks still need a person.
