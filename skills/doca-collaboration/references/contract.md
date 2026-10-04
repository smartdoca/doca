# Editor collaboration contract

Applies to rich text, spreadsheets, and later document types. Dated 2026-09-11.

The platform owns one connection, permission, increment storage, commit acknowledgement, reconnect, and online session. Each component owns its data model and rendering. Shared behavior does not mean converting a spreadsheet into a rich text structure.

The current service protocol is also described in [collaboration and search](collaboration.md). This document is the next shared contract. A field here is not automatically a published API.

## 1. Layers and versions

| Layer or field | Shared duty | Component difference |
| --- | --- | --- |
| Transport | Same-origin WebSocket, one envelope, server authentication | None |
| Save | Local increment, outbox, database commit, ACK | None |
| format / codec / schemaVersion | Identifies the type and whether the structure is compatible | Rich text node CRDT; spreadsheet stable row, column, and cell commands |
| epochId | One CRDT lineage. It changes only when an incompatible rebuild happens | A spreadsheet also needs an immutable workbook baseline bound to the epoch |
| seq | Monotonic number of valid commits in the current epoch | None |
| checkpointSeq | The commit seq a full Yjs checkpoint already covers | Do not delete logical commands the component still needs to replay |
| resource.version | Optimistic lock for business metadata | Not used to merge Yjs |
| History version id | A business snapshot the user views or rolls back | Not every network update |
| state vector | A summary of the sync difference | Not a full save acknowledgement, especially not for delete-set confirmation |

Each format uses epochId as the lineage. A periodic Yjs checkpoint does not change the epoch. A spreadsheet uses the current Yjs session and checkpoint sequence.

## 2. Platform and component

The platform has one realtime session per page: socket, ACL, increment queue, ACK, reconnect, business snapshots, comments, notifications, and asset permissions. A component does not open a second HTTP autosave or socket.

A component creates the Y.Doc and the editor once per document session. Local edits map to Yjs. Remote transactions project onto the view. It exposes readiness, errors, format state, selection, and anchors. Changing props, readonly, cursors, size, or the save hint must not rebuild the shared document.

The server may hide format differences behind a codec plugin: initialize, validate a merge, build the business projection, import and export, and roll back history. The generic room, permission, and storage path does not understand a toolbar or a cell DOM.

## 3. Messages and lifecycle

Suggested envelope: protocolVersion 1, type, id, room (resource UUID), and epochId. The first join may omit epochId. After the server returns it, later writes must carry it. Identity, sessionId, name, and color are decided by the server.

1. join sends supported codec and schemaVersion, the known epoch, and the vector.
2. sync-response returns epochId, codec, schemaVersion, seq, checkpointSeq, rank, update, and vector. A spreadsheet also returns the immutable baseline bound to that response.
3. The view becomes ready only after the baseline is checked, Yjs is caught up, and the projection is done. Do not show an editable empty document and then replace it.
4. update carries id, room, epochId, and Yjs bytes (base64 on the current JSON channel). Send only the real local content increment.
5. ack uses the same id and epochId and the seq after commit, optionally with changed and business metadata. It is sent after the transaction commits.
6. A valid update is broadcast to other sessions that still have permission. Applying a remote update must not create a local write.
7. sync-request and sync-response only fill in the difference. They are not an ACK. They must not clear the unacknowledged queue or upload unconditionally after every catch-up.
8. leave and disconnect clear this session's selection. Authorization, epoch, and schema errors are distinct. They are not all ordinary network retries.

A retry of the same unacknowledged write keeps the original bytes and message id. Yjs merge is idempotent. A duplicate delivery does not increase seq, audit, notifications, or history. Doca deduplicates with editor and markdown receipts keyed by resourceId, epochId, and messageId. The same id with a different payload is rejected.

## 4. Save state

Connection state moves loading, syncing, ready, and on failure disconnected or error. Save state is separate: clean, dirty, saving, error.

- Only a local content transaction enters the outbox. Initialization, selection, scroll, focus, size, online count, heartbeat, remote replay, and the readonly switch do not create a content update.
- "Saved to the cloud" requires an empty outbox and a finished sync. "Saving" requires a write waiting for acknowledgement.
- The queue sends serially. Only an ACK that matches the head id may dequeue. An unknown, late, or duplicate ACK must not drop later input.
- Disconnect keeps the bytes and the id. Reconnect catches up from the remote, then retries unacknowledged increments.
- Do not treat `encodeStateAsUpdate(doc, vector).length` as dirty. The same state can still return a historical delete set. A length greater than 2 is not a new write.
- An epoch mismatch pauses the old queue. Export or a separate recovery copy is allowed. Old increments are not forced onto the new document.
- There is no IndexedDB outbox yet. Disconnect keeps only this page's memory. Closing the page can lose unacknowledged content. Do not claim offline-safe save.

Both hosts use `apps/web/src/features/documents/update-outbox.ts`. The queue does not depend on the document type. It keeps the real local transaction increment. A sync-response does not trigger an unconditional upload.

## 5. Suggested component API

Every component provides connect, setReadOnly, dispose, onSelectionChange, renderRemoteSelections, clearRemoteSelections, and onError with distinguishable error codes. Rich text also provides format state: marks, block type, alignment, canUndo, and canRedo. Fixed and floating toolbars share that state. Do not guess format from the DOM.

Transaction origins are local, remote, and bootstrap. Only local is a user write. Do not wrap commands again while applying a remote transaction and mint a new operation id.

## 6. Live selections

The selection union is text (relative anchor and focus), cells (sheetId, zero-based closed row and column range, and editing), or null.

sessionId is per connection. Online count deduplicates userId. Drawing excludes only the current session, not other pages of the same account. editing true means the user is typing. A selection that is not typing is false. Sheet changes and edit start or end send an event. Cell values, formulas, and keystrokes are not sent. Publish is throttled to 100–150 ms and deduplicated. It does not write the database, bump a version, or affect undo. Publish and draw only in edit mode. Leaving the editor, leaving the document, disconnect, and revocation clear the selection. The server checks the ACL on every message. Switching browser tabs keeps the last edit position of a session that is still online. A background tab is not "left the document". Spreadsheets draw a colored border and a name label on the current sheet only. Numeric coordinates are temporary presence and can be briefly stale while rows and columns are inserted. A long-lived comment anchor uses stable row and column ids, not an A1 coordinate.

The spreadsheet editor publishes, receives, and draws presence through its selection state and the realtime API. If that capability moves into a separate spreadsheet package, keep this selection union and lifecycle. The host should not depend on facade details forever.

## 7. Snapshots, rollback, and region comments

A Yjs checkpoint stores the original CRDT encoding. Do not rebuild from a JSON projection and drop identity. A spreadsheet stores an immutable baseline plus commands in the same epoch. Do not take the latest workbook save as a baseline and replay old commands on it again.

A periodic checkpoint keeps the epoch. User history is created at meaningful points. A history record stores its own format, codec, epoch, baseline, and asset dependencies. Do not interpret an old version with the current baseline. Rollback prefers a new change in the current epoch and keeps the history from before the rollback. If a component can only rebuild, it must switch epoch explicitly, handle unacknowledged writes, and then load the new lineage.

The core keeps snapshots of successful writes. Membership level does not limit or expire history. Automatic, manual, AI, and pre-rollback snapshots share persistence and the transaction boundary. A failed write rolls back. A business policy may refuse a new snapshot. It cannot implicitly delete an existing snapshot, a collaboration checkpoint, an uncovered increment, or an attachment.

Comment author, body, replies, and resolution live in the platform database. The component provides captureAnchor, resolveAnchor, renderAnchors, and onAnchorClick. Rich text uses a relative text position. A spreadsheet should use a stable row and column range that transforms with insert and delete. A fully deleted or resolved anchor is not highlighted.

The current spreadsheet package and host implement region comments with stable row/column identities, capture/resolve/reveal APIs, marker rendering, epoch validation and deleted-target handling. Supported row/column insertion, sorting and sheet changes are covered by isolated tests in `tests/editor-sessions.test.ts`, `tests/sheet-axis-sizes.test.ts` and `tests/sheet-collection.test.ts`. This permanent protocol is separate from temporary cell presence.

## 8. Shared acceptance

1. Open existing data, wait 60 seconds, select, scroll, and resize. Zero new content commits or history.
2. A edits, B receives, B does not echo a commit, and the projections match.
3. Two pages of one account have different colors and names. Text selections and cell editing state are accurate. Readonly does not publish or display.
4. Lost, duplicate, and delayed ACKs, plus typing during reconnect, lose no data and do not show saved early.
5. Repeated sync after a pure delete does not upload the delete set again.
6. A mismatched baseline, epoch, or schema is rejected. Repeated initialization does not create new content.
7. Spreadsheet row and column insert and delete, cell edit, formulas, merge, sort and filter, and undo are accepted one by one. An unsupported operation is declared or disabled. Do not claim everything converges.
8. After restart, checkpoint plus increments match the online projection, including after log compaction.
9. Revocation, disable, anonymous access, a foreign room, a forged identity, and an out-of-range selection are isolated while editing.
10. Fixed and floating toolbars agree on format. A save-state update does not rebuild the editor or drop focus.

## 9. What is implemented

Host 0.1.10 integrates rich text, Markdown, spreadsheets, canvas, and slides with a shared reliable commit queue and durable ACKs. Idle synchronization does not echo content; selections and names use format adapters. All five formats expose history reads; manager restore is supported only for rich text and Markdown. Spreadsheet, canvas, and presentation previews report `canRestore:false`. This does not establish a unified component rollback API for every format.

The platform implements epoch, protocol checks, commit receipts, and history recovery metadata. Without Redis, broadcast and presence are one process. With Redis, document updates, server refresh, permission invalidation, notifications, and presence cross instances. The database commit is still the ACK boundary and the source of document truth. After Redis reconnects, the server sends the authoritative state again to active rooms on this instance. Pub/Sub is not a durable log, and a Redis failure does not silently fall back to the local bus.

Still shared work for the component and the platform: a formal selection API, a persistent offline queue and a unified rollback across formats. A capability the component does not export is still a target contract.

## Plugin elements increment — 2026-10-02

The host now implements the optional SDK 0.1.6 Web element registry. Rich text stores an opaque JSON envelope through one permanent `custom:plugin-element` inline codec using the existing rich schema 3. Spreadsheet stores opaque JSON in native `ICellData.custom.docaElement` using existing schema 6 and the public range command path. Neither changes transport, protocol version, epoch, checkpoint identity, ACK receipts or reliable outbox. There is no second JSON autosave or business-owned content database.

Unknown types and exact envelope/data versions display an unsupported placeholder and retain their original bounded JSON. No adapter, migration, conversion or deletion is provided. Existing internal reference readers remain unchanged. Native insertion/configuration/removal participates in clipboard, undo and collaboration. Configuration forms recheck a live rich range or stable spreadsheet single-cell anchor and fail on a removed/concurrently changed target. Canvas timers are view-only, at most once per second and scheduled only after a visible timed cell is drawn; hidden pages pause. Render/selection/idle changes must not increase content seq or history.

Isolated automated acceptance covers native persistence and reload, opaque unknown payloads, rich atom delete/undo/clipboard, sheet row insertion/anchor/copy/delete/undo, duplicate ACK replay, two-replica convergence with no remote echo, readonly denial and oversized payload rollback. Tests do not edit user documents. This increment does not claim universal block support, all spreadsheet operations, cross-format lossless export, permanent offline queues or native-device acceptance. Precise element fields and limits are in the repository source `docs/plugin-editor-elements.md`.

## Markdown bootstrap correction — 2026-10-03

The host restores the authoritative checkpoint into an empty replica before calling the shipped Markdown session factory. It no longer stamps local metadata into a loading replica: those unsubmitted CRDT clocks caused the first text update to depend on items absent from the server. Session status snapshots retain the same doc/text/awareness/undo objects. No schema, epoch or persisted-format adapter changes; existing pending edits are preserved and are not silently converted or cleared. Regression acceptance includes first-edit durable restore, no remote/bootstrap echo and stable status handles; browser verification covers typing, cross-instance updates, reload and idle checks on isolated documents.
