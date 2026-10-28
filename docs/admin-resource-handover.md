# Administrator resource handover

[中文](admin-resource-handover.zh-CN.md)

In **Administration → Users**, an active system administrator opens **Hand over resources** for a disabled account, selects an active recipient and resource entries, then reviews and confirms the actual changes. The source account stays disabled. Ordinary users cannot use any of the three endpoints.

## Scope

The inventory reads management metadata from existing resource, folder, file and permission records. It does not read document bodies or private credentials.

- Documents, libraries and knowledge books: transfer selected resources and source-owned descendants. Other people retain ownership; related content is listed separately. Existing library-owner authority applies to the recipient.
- Document images and attachments: transfer linked assets and directory items with their document. They cannot be selected independently. Original uploaders and history authors remain unchanged.
- Ordinary folders/files: transfer source-owned descendants and files. A selected nested folder or independent file is moved to the recipient's personal root when its parent is neither transferred nor recipient-owned. The preview shows this relocation.
- Retained document/library grants: explicitly selected active local grant sources become a recipient direct grant and are removed from the source. Descendant scope is preserved; link tokens are not copied.
- Shared-folder grants: merge into the recipient's folder grant without downgrading an existing higher role, then remove the selected source grant.
- Trashed resources: ownership may transfer while the deleted state stays intact.

Personal AI files, private conversations, credentials and plugin business records are excluded. Existing AI/knowledge-session file bindings, ordinary locked files and unrecognized metadata remain protected. A document attachment's file-manager lock does not prevent transfer with its document. Protected entries explain why they cannot be selected; protected files inside a selected directory block the entire batch.

## Preview and permission checks

The preview lists ownership, permission and attachment changes, relocations, and related items whose ownership remains unchanged. Selecting a parent expands its eligible descendants. Each batch permits up to 500 selected inventory entries; expansion may include more descendants. Inventory and changes use 50-row pages.

Existing higher recipient permissions remain. Incomparable node/descendant roles, source child restrictions that would broaden access, and explicit recipient restrictions produce conflicts and disable confirmation. Review those permissions through the existing permission workflow or change the selection. Handover does not override such restrictions or copy unrelated inherited rights.

Pending invitations to the source or recipient on selected documents/folders are cancelled so a later acceptance cannot overwrite the handover. Document invitations are archived with tickets; folder invitations retain their cancelled rows and tickets. Other people's invitations stay intact. The preview shows the cancellation count. Public visibility, link definitions and other collaborators retain their existing settings; public access does not become a user block list.

## Consistency and audit

Inventory and preview use consistent database snapshots. Execution recalculates a fingerprint covering relevant accounts, resources, grants, attachments and directory contents. Changed state makes the confirmation stale and returns 409. Refresh and preview again. Concurrent confirmations of the same batch succeed only once.

A single transaction commits ownership, grants, invitation decisions, index jobs and security audit. Existing recipient admission/quota policies still run. Any failure rolls the entire batch back. Stored objects are neither moved nor deleted. Document content, history, uploaders and original authors remain intact. After commit, active permissions are refreshed and the involved accounts are notified.

The `user.resources_handed_over` security audit records the actual administrator, source, recipient, fingerprint, changes and related previous metadata. It excludes unrelated private recipient grants. Execution is synchronous; it is not a resumable background job. After a browser disconnect or lost response, rescan the inventory before trying another batch.

This feature uses existing tables and persisted formats, without schema changes or historical conversion. There is no automatic reverse handover or permission rollback. Corrections to a confirmed business decision require reviewing the audit and current ownership/permissions.

## API and verification

- `GET /api/v1/admin/users/:id/resource-handover`: inventory.
- `POST /api/v1/admin/users/:id/resource-handover/preview`: `targetUserId`, `keys`.
- `POST /api/v1/admin/users/:id/resource-handover/execute`: the same selection plus the preview `fingerprint`.

Run `pnpm exec vitest run tests/resource-handover.test.ts` for service/API regression. Run `pnpm exec tsx scripts/qa-resource-handover.mts` for the actual admin UI against isolated SQLite/accounts/documents/storage. Results belong in `artifacts/verification/resource-handover/`. These checks do not establish PostgreSQL runtime verification.
