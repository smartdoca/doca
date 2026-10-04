# Quick notes

[中文](quick-notes.zh-CN.md)

The `#/notes` entry sits below the personal AI assistant. Desktop uses a title list on the left and an editor on the right; narrow screens show the list before opening an item. A note without text uses its creation time as its title. The title shares the workspace header layout used by folders and mail, with the floating-window action beside it. The list begins with search and creation.

Opening the floating window moves note content into it and leaves the page empty. Search/create appear above All and Deleted; a back action returns from a note to the list. Selecting Notes in the sidebar flashes the existing window. The window can be moved, resized, collapsed, and closed. Position, size, and open state are stored in `ui.notesFloat` page state and respond to Web and assistant changes. Default tools are image, task, attachment, and expanded formatting. Formatting includes bold, italic, strikethrough, two list types, and links. Content preserves images/attachments and supports search, multi-selection compilation, deletion, and restore.

## Saving and permissions

- `quick_notes` stores ordinary JSON separately from document trees, public search, Yjs rooms, comments, and collaborative presence.
- Every read/write checks the signed-in owner. Administrators cannot read others' notes through ordinary APIs; audit download routes cannot bypass private attachment ownership.
- Creation uses a client UUID and idempotent PUT. Editing uses version-checked PATCH, a 900 ms debounce, and actual content changes only. Closing the editor submits pending content. Duplicate receipts do not increment versions twice. Conflicts retain the local draft for merging with cloud content.
- Browser drafts are isolated by account and note and restored after refresh. They are not an offline synchronization queue and are not guaranteed after browser-data cleanup. Attachments require online uploads.
- Each note is at most 30,000 characters / 128 KB with at most 12 image/attachment references. Each file follows platform upload and account limits, up to 20 MB. Native slatetsx editing/readonly rendering retains paragraphs, rich text, links, tasks, code, images, and attachments. Complex pasted tables, columns, and charts degrade to text.
- `assets.purpose = note_attachment`; an upload is owner-private and saving binds `note_id`. Download always authenticates, uses private/no-store, and never redirects to a CDN. Deletion is soft; the owner can read and restore deleted notes.

## Compile into a document

1. Select 1–20 notes, an instruction, and an available AI model.
2. The server checks ownership and versions, freezes the selected snapshots, and runs one bounded generation under existing model quotas/rating. It supplies no other notes, network tools, or attachment bytes.
3. Preview and edit the result before saving. Original notes remain. The latest 30 compilations can be reopened.
4. Existing document creation/native import creates a private rich-text document, disables access requests/share links, and does not inherit the deployment's public defaults. The initial version does not choose a library target.
5. Image attachments remain with the document without claiming to analyze their contents. The document receives independent asset records/permissions; original private attachments keep their grants. Immutable objects may be reused. Future physical cleanup must check every reference to the same `profile_id/object_key`, rather than deleting by one asset row.

`quick_note_compilations` persists input snapshots, state, and results. Repeated request IDs do not call the model twice; repeated save requests do not create duplicate documents. Generation is limited to 90 seconds. History reports interruption after restart/timeout; users select notes again to start another compilation. There is no automatic background recovery. Preview edits remain a page draft until document saving persists the result. Failure does not alter original notes.

Generated Markdown is converted only into supported native paragraphs, headings, lists, and safe links. HTML, generated image URLs, and internal resource links are not imported as trusted nodes. Private source provenance remains in compilation records and is not embedded in a document that might later be shared.

## API

`quick_notes`, `quick_note_compilations`, and `assets.note_id` belong to the current database baseline.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/v1/quick-notes?q=&trash=0&offset=0` | Owner list, 30 items per page, newest creation first |
| `GET /api/v1/quick-notes/:id` | Read a note, including the owner's deleted notes |
| `PUT /api/v1/quick-notes/:id` | Idempotent creation with `content`, `assetIds` |
| `PATCH /api/v1/quick-notes/:id` | Save those fields plus optimistic-lock `version` |
| `POST /api/v1/quick-notes/:id/trash` | Delete/restore with `version`, `deleted` |
| `POST /api/v1/assets?purpose=note_attachment&filename=…` | Private attachment upload |
| `POST /api/v1/quick-notes/compilations` | `id`, `notes: [{id, version}]`, `instruction`, `modelId` |
| `GET /api/v1/quick-notes/compilations` | Current user's latest compilations |
| `GET /api/v1/quick-notes/compilations/:id` | State, preview, frozen inputs |
| `POST /api/v1/quick-notes/compilations/:id/document` | Save preview `markdown` |

## Verification

- `tests/quick-notes.test.ts` uses isolated databases to cover ownership/admin isolation, authorized attachments, restoration, validation, idempotency, conflicts, selected snapshots, usage rating, failure recovery, private native documents, and attachment copies.
- `scripts/qa-quick-notes-server.mts` uses an in-memory database, temporary attachments, a simulated model, port 39252, and requires `DOCA_QA_ISOLATED=1`.
- `scripts/qa-quick-notes-ui.cjs` checks layout, collapsed formatting, rich content/attachments, autosave, conflict merging, AI preview/creation, deletion/restore, narrow-screen overflow, and absence of collaborative writes. `PLAYWRIGHT_MODULE` selects the browser library.
- Write acceptance uses neither user documents nor real model keys. Real output quality depends on the configured provider/model.

## Lightweight editor integration (2026-09-16)

`RichTextEditor` uses standalone `initialValue`, without `value` or `collaboration`. Save receipts are not fed back into the editor, preserving selection and undo. Stable independent `resources` and `plugins` use SDK upload commands/callbacks. The host owns asset metadata; body content stores resource UUIDs. The server checks that every reference belongs to the owner and is in the note's asset set.

`insertMenu?: readonly BlockType[]` controls slash/block insertion and `ariaLabel` labels the region. Formatting, floating tools, dragging, and undo use the current SDK. Doca allows body text, headings, lists, quotes, tasks, code, dividers, images, and attachments. A host plugin converts complex paste to text. Strict save validation blocks invalid content and incomplete/failed uploads instead of saving only the last valid projection.

The right editor fills remaining height and scrolls internally. Minimum-height/spacing overrides are scoped to notes. Readonly display trims leading/trailing empty paragraphs without rewriting persistence. Clicking a title edits it on the right; changes autosave. New notes save once they have content. Save failures/conflicts preserve edit state and local drafts. Per-line floating controls and reserved left-toolbar space are hidden, while selection formatting remains.

Bulk selection supports at most 20 notes, select-all/clear, compilation, and deletion. Single/bulk deletion confirms restorability and checks each version. Partial failure removes only successful items, keeps failed ones, reports the count, and permits retry after refresh.
