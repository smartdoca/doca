# Documents, sharing, and history

[中文](document-experience.zh-CN.md)

Checked against current host 0.1.10 source. Early development and temporary package records are in [research](research.md).

## Create and edit

The creation menu provides rich text, Markdown, spreadsheets, slides, and canvas. All five have editors and independent collaboration codecs. Templates require installed providers; blank-document creation is available by default. Personal documents are independent pages; library documents use their library tree.

Images and attachments use host uploads, asset IDs, and authorized downloads. Editing requires editor permission or above, and save confirmation follows database commit. Disconnecting retains pending edits in the current page; closing it creates no offline backup. Tools, find/replace, presence, and comments vary by format; see [editor integration](editor-integration.md).

## Sharing and permissions

The sharing panel manages visibility, invitations, member authorization sources, and links. Changes check a version or revision; refresh after a 409 conflict. Management and ownership operations follow their own authorization rules; see [permissions](permission-inheritance.md).

Links use `#/s/{token}` for signed-in preview and acceptance. The global link switch, individual link disable/expiry, and member-source revocation are distinct actions; removing one source leaves other valid sources intact. Public reading, discovery, collections, and favorites are separate; collecting grants no access, and system administrators do not automatically gain private-content access.

## History and restore

- The document menu provides history, snapshot previews, and manual snapshots. History normally requires editor permission; enabling reader history allows access according to resource reading permission.
- Recent recovery points remain detailed; long-term history retains one point per ten older snapshots. The same list and preview/restore actions serve every retained point, without exposing its storage location. Sampling deliberately removes the other nine points; see [storage operations](storage.md#history-storage-and-offline-upgrade).
- Restorable rich-text and Markdown snapshots offer restore to managers or owners. `expectedSeq` checks current content. Refresh after a conflict so an old preview cannot overwrite newer edits.
- Spreadsheets, slides, and canvas have snapshots and readonly previews. They currently return `canRestore: false` and show no restore action.
- Business history and collaboration checkpoints are persisted separately. Restore uses the snapshot's format, lineage, and assets; missing history is never replaced with current content.
- Visit and action records recheck current permissions. They are not backups and cannot reconstruct unsaved history.

## Move, copy, and trash

Check destination and descendant permissions before moving, and confirm the authorization reset. Ownership transfer requires the owner. Copy creates an independent resource and content identity, rebinds assets, and excludes grants, comments, and undo history. Deletion enters trash; restoration respects deletion batches and parent state. Permanent deletion is an explicit authorized cleanup and does not mean deleting every shared storage object.

## Routes and source

These paths have the `/api/v1` prefix:

| Route | Purpose |
| --- | --- |
| `GET /resources/:id/versions` | History list |
| `POST /resources/:id/versions` | Manual snapshot |
| `GET /resources/:id/versions/:versionId` | Preview and current content sequence |
| `POST /resources/:id/versions/:versionId/restore` | `{expectedSeq}`, restore a supported format |
| `POST /share/redeem` | `{token, accept?, consume?}`, preview/accept a link |
| `GET /resources/:id/info` | Statistics, visits, or action records |

See [experience.ts](../apps/server/src/routes/experience.ts), [history service](../packages/core/src/modules/history/service.ts), and [editor dispatch](../apps/web/src/features/documents/document-editor.tsx). The running `/api/openapi.json` and server validation define the complete deployed API.
