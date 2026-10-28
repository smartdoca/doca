# Editor collaboration contract

[中文](collaboration-sdk-contract.zh-CN.md)

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
- Current host adapters persist original checkpoints and pending message IDs through `offline-replica.ts`. Offline editing requires an available authorized replica and successful browser storage; it does not provide a fully offline application shell. The cache-first refresh boundary is recorded in the 2026-10-12 increment below.

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

The core records snapshots of successful writes independently of membership. Automatic, manual, AI, and pre-rollback snapshots share persistence and the transaction boundary. A failed write rolls back. The explicitly agreed host retention policy keeps the latest 20 full snapshots in the database and, for each complete group of ten older snapshots, retains the newest one as a private file-backed recovery point. Only a verified immutable upload permits atomically recording its index and removing that group from the database; the other nine points are deliberately sampled away. Incomplete groups and storage failures retain database originals. The user receives one ordinary paginated snapshot list with unchanged IDs and no storage-location fields. Snapshot bytes, independent recovery metadata and attachments remain unchanged; live checkpoints and uncovered collaboration increments are not sampled. A business policy cannot add implicit deletion outside this agreed retention policy. Existing rollback capabilities stay format-specific. See [storage operations](storage.md#history-storage-and-offline-upgrade).

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

Still shared work for the component and the platform: a formal selection API, full offline application startup and a unified rollback across formats. The host's current persistent queue does not imply that a component exports its own offline transport. A capability the component does not export is still a target contract.

## Plugin elements increment — 2026-10-02

The host now implements the optional SDK 0.1.6 Web element registry. Rich text stores an opaque JSON envelope through one permanent `custom:plugin-element` inline codec using the existing rich schema 3. Spreadsheet stores opaque JSON in native `ICellData.custom.docaElement` using existing schema 6 and the public range command path. Neither changes transport, protocol version, epoch, checkpoint identity, ACK receipts or reliable outbox. There is no second JSON autosave or business-owned content database.

Unknown types and exact envelope/data versions display an unsupported placeholder and retain their original bounded JSON. No adapter, migration, conversion or deletion is provided. Existing internal reference readers remain unchanged. Native insertion/configuration/removal participates in clipboard, undo and collaboration. Configuration forms recheck a live rich range or stable spreadsheet single-cell anchor and fail on a removed/concurrently changed target. Canvas timers are view-only, at most once per second and scheduled only after a visible timed cell is drawn; hidden pages pause. Render/selection/idle changes must not increase content seq or history.

Isolated automated acceptance covers native persistence and reload, opaque unknown payloads, rich atom delete/undo/clipboard, sheet row insertion/anchor/copy/delete/undo, duplicate ACK replay, two-replica convergence with no remote echo, readonly denial and oversized payload rollback. Tests do not edit user documents. This increment does not claim universal block support, all spreadsheet operations, cross-format lossless export, permanent offline queues or native-device acceptance. Precise element fields and limits are in the repository source `docs/plugin-editor-elements.md`.

## Markdown bootstrap correction — 2026-10-03

The host restores the authoritative checkpoint into an empty replica before calling the shipped Markdown session factory. It no longer stamps local metadata into a loading replica: those unsubmitted CRDT clocks caused the first text update to depend on items absent from the server. Session status snapshots retain the same doc/text/awareness/undo objects. No schema, epoch or persisted-format adapter changes; existing pending edits are preserved and are not silently converted or cleared. Regression acceptance includes first-edit durable restore, no remote/bootstrap echo and stable status handles; browser verification covers typing, cross-instance updates, reload and idle checks on isolated documents.

## Rich-text diagram anchors — 2026-10-10

With the installed `@smartdoca/slate` 0.4.13, the host captures native flowcharts and mind maps using the existing whole-block anchor (`kind:"block"`, stable `blockId`, and the current `epochId`). Server quotes come from authorized node labels or the root topic. Comments and AI references target the whole diagram, remain valid after native style edits and checkpoint restore, and stop resolving after block deletion. Diagram node/edge IDs are not permanent sub-diagram comment anchors. Capture, selection, highlights and AI references are read-only with respect to document content; they use the current outbox and transport without schema or lineage changes. No stored document or historical comment conversion is introduced.

## Published spreadsheet package integration — 2026-10-10

Host 0.1.18 locks the registry artifact `@smartdoca/sheet` 0.2.0-rc.19. The data-validation toolbar action is distinct from Insert → Dropdown list. Public declarations and Yjs/model/XLSX entrypoints are byte-identical to rc.18; the host continues using the shipped menu-extension, resource, stable-anchor and collaboration APIs. The host synchronizes the shipped `session.setReadOnly` API and refreshes the capability snapshot before painting after mode changes, without rebuilding the workbook or Y.Doc. Plugin-element insertion now uses `SPREADSHEET_MENU_PATHS.toolbarEnd` through native menu extensions. This is a UI/package integration with no codec, schema, epoch, outbox, persisted-data conversion or new compatibility behavior. Existing history readers and explicit host-baseline maintenance commands are unchanged. Package and host regressions use isolated workbooks/documents; build success alone does not establish acceptance of every spreadsheet operation.

## Cached document startup — 2026-10-12

The user-approved host change adds exact-version-1 display metadata in `doca.document-startup.v1` for the current signed-in account and its twelve most recently cached documents. It contains public bootstrap fields, document metadata and containing-library metadata, without credentials, comments, grants or a second content projection. It does not change or convert existing Yjs checkpoints, immutable baselines, epochs, schema/codec protocols, message IDs or durable ACKs. Old hosts have no startup metadata: one live open is required to create it. Unknown/corrupt startup formats are neither used, converted nor overwritten; rollback leaves content and pending work intact.

A cached refresh mounts the shell and restores the original replica before plugin discovery, bootstrap or detail requests finish. The user explicitly chose to allow offline editing under the last known permission. Live validation and retries run in the background; transient network failure preserves the same editor. Reconnect merges remote changes and retries the original pending bytes/IDs, and only matching server ACKs remove them. Logout/account changes and explicit session/resource denial hide the relevant display metadata without deleting durable content or pending edits. Mismatched lineages still pause under the existing exact protocol checks.

This requires cached metadata, successful browser storage and available static application resources; it is not full offline PWA startup. Comments, uploads and permission changes remain online actions. The host's existing default replica parameters and historical readers are unchanged, without a new old-format adapter. Isolated acceptance is recorded by `tests/document-startup-cache.test.ts` and `scripts/qa-document-startup.mts`; basic cache restore does not establish convergence of every operation in each format. See [the storage and recovery boundary](access-offline-events.md#页面缓存先展示--2026-10-12).

## Published Slate and Canvas integration — 2026-10-13

Host 0.1.23 locks the registry artifacts `@smartdoca/slate` 0.4.14 and `@smartdoca/canvas` 0.4.3. Slate codec/Yjs/headless/conversion bytes and public entrypoint maps are unchanged; Canvas model/IO bytes and public entrypoint maps are unchanged. The DOCX patch is bound to the new Slate artifact. Stable host sessions, resource callbacks, permissions, presence, anchors, original checkpoints, epochs and pending update IDs keep their existing ownership. The package regenerates stale diagram previews in view state without content writes.

The user explicitly chose to make no old-flowchart compatibility promise. No host old-node adapter, automatic conversion, historical-field backfill or data deletion is introduced. New shapes, filled-arrow geometry, manual `routeMode`/`vertices` and endpoint anchors use the shipped native model; AI validation and guidance accept/preserve those fields. A previous editor may not render new fields correctly. Preserve prior deployments and the pre-upgrade backup; host database rollback separately follows the approved knowledge-book storage procedure. Existing historical readers and normalization helpers remain in their established paths and are not redesigned by this package upgrade.

Isolated host regressions cover native-field validation, durable/duplicate ACK, remote replay without echo, undo/redo, checkpoint restore, canvas engine singleton registration and DOCX roundtrips. Browser verification and final release checks are recorded in the 0.1.23 verification attachment; model tests do not establish every new diagram gesture or every canvas operation.

Canvas 0.4.3 also contains a user-approved view rule: numeric text line heights from 0.8 through 3 are displayed as font-size multipliers; other numeric values remain pixels. Loading, selection, resize and idle do not rewrite the model. Ordinary text editing preserves the original numeric field; an explicit line-height edit stores the native percentage value. No host migration, backfill or stored-data deletion is added. Browser acceptance verifies 1.5 at 32 px as 48 px, original numeric bytes after text edits, no idle writes, peer convergence and reload. Previous UI rendering is not guaranteed on rollback.

## Slate and spreadsheet package upgrade — 2026-10-14

The current checkout locks the actual registry artifacts `@smartdoca/slate` 0.4.15 and `@smartdoca/sheet` 0.2.1. Public entrypoint maps and dependencies are unchanged. Slate codec/Yjs/headless/conversion bytes are unchanged; the existing DOCX style patch is bound to 0.4.15. AI node validation accepts finite numeric `angle` values in degrees and the editing manual preserves this field. Native image interaction selects on the first click and previews on the next; clicking elsewhere resets selection.

The user explicitly approved the spreadsheet package's 18 px default row height and 72 px default column width for CRDT-added worksheets, including those created before this upgrade, and virtual empty recovery worksheets. Immutable baseline worksheets retain their original size fields, including omission; explicit per-axis sizes remain native overrides. Newly created host worksheets use the same 18/72 dimensions. This is a projection/default-display decision: existing seeds, baselines, checkpoints, epochs, comments and pending update IDs are not rewritten, converted or deleted. Schema 6 and exact protocol rejection remain unchanged. The existing virtual last-sheet recovery, history readers and normalization helpers remain in their established paths and are not redesigned.

The user retains the previously agreed absence of an old-flowchart compatibility promise. No old-node adapter or field backfill is added. New rotation uses the shipped native model; the preceding editor may ignore angles, and preceding spreadsheet builds may display different defaults. Keep the previous registry artifacts, dependency pins, patch and lockfile for package rollback, and update server and Web together. Host database rollback remains subject to its separately approved storage procedures.

Verification uses an immutable fixture generated by the real rc.19 package, isolated host databases and browser documents. It covers original-byte preservation, approved dimensions, rotation validation/ACK/replay/undo/restore, stable anchors, readonly guards, file roundtrips and idle/selection without writes. Package audit and check outcomes are recorded in `docs/verification/editor-package-upgrade-2026-10-14/report.json`; the source upgrade record is [the pending release note](releases/pending-editor-package-upgrade.md). This does not establish every diagram gesture, every spreadsheet operation or native-device acceptance.

## Spreadsheet hyperlink patch — 2026-10-15

Host 0.1.25 pins the actual registry artifact `@smartdoca/sheet` 0.2.2. Relative to 0.2.1, public entrypoints, dependency contracts and declarations are unchanged; Yjs/model/XLSX runtime JavaScript is byte-identical (some source maps differ). Hyperlink dialogs now cancel and restore the native draft correctly, and native unlink commands pass through the existing inline-link capability and readonly guard. The host continues using its stable editor/session, asset callbacks, native mutations and durable outbox. This patch changes no schema 6 encoding, immutable baseline, epoch, checkpoint or pending update identity and introduces no data conversion or compatibility adapter. Retain the previous package pin and lockfile for rollback. Audit and isolated verification are recorded in `docs/verification/sheet-package-upgrade-2026-10-15/`.

## Native editor upgrade — 2026-10-16

Host 0.1.27 pins the actual npm artifacts `@smartdoca/slate` 0.4.18 and `@smartdoca/sheet` 0.2.3. Entrypoints and dependency contracts are unchanged. Slate codec/Yjs/headless/conversion bytes match 0.4.15; the unchanged DOCX patch is bound to 0.4.18. The host accepts the native additional diagram shapes, node and edge styles and optional `canvasSettings`; AI commands validate and preserve these fields. Native graph editing includes the new workspace, automatic paper expansion, focused-draft Ctrl/Cmd+S saving and corrected floating selection toolbar.

The user explicitly approved native 19.8/79.2 worksheet defaults and graph behavior. New host documents, CRDT-appended worksheets (including historical appended worksheets) and virtual recovery sheets use 19.8-pixel rows / 79.2-pixel columns. Original immutable baseline fields, including omitted defaults, remain unchanged; explicit per-axis dimensions remain. No baseline, seed, checkpoint, epoch, sequence, pending-message identity or cell data is converted. Existing diagram fields remain untouched when opened; native defaults for absent canvas settings affect the view, and only an explicit graph save writes native graph fields/settings. Preview regeneration is view-only. Rich-text schema 3, spreadsheet schema 6 and durable ACK/outbox semantics remain unchanged. Existing historical readers and normalizers are retained without redesign.

Retain the original dependencies, lockfile, patch and deployment for rollback. Earlier editors may show different default dimensions/styles or ignore newly saved fields; no new historical-flowchart compatibility guarantee is introduced. Preserve all new writes when recovering; restoring old backups would discard later edits. Isolated verification, including an actual released 0.1.26 database, is recorded in `docs/verification/editor-package-upgrade-2026-10-16/`.

## Mind-map workspace upgrade — 2026-10-16

Host 0.1.29 pins the actual npm artifact `@smartdoca/slate` 0.4.20, including 0.4.19's diagram/media interaction fixes. Public entrypoints, dependencies and host component/handle declarations are unchanged. Codec, Yjs, headless and conversion runtime bytes match 0.4.18; the identical DOCX patch is bound to 0.4.20. AI guidance preserves the complete native mind map, including `structure`, `theme`, `background`, node `fontSize`/`bold` and `style:"underline"`.

The user explicitly approved the new native mind-map display defaults for existing documents. Opening an older map or regenerating its version-6 preview changes view state only; it does not rewrite original nodes, checkpoints, epochs or pending update identities. Opening and closing the workspace without saving produces no content commit. Explicit saving commits the native draft and derived preview through the existing Slate/Yjs outbox and durable ACK. No migration, field backfill or old-style adapter is introduced. Existing historical readers and normalization helpers remain in their established paths without redesign. Schema 3 and exact protocol checks remain unchanged; there are no SQL changes.

Keep the 0.1.28 deployment, original package artifact, dependency pin, patch and lockfile for rollback. Earlier editors may ignore new styles/settings or show different defaults. Preserve later writes when recovering; restoring a pre-upgrade backup discards subsequent edits. Tests use isolated synthetic documents/databases; verification and limits are recorded in `docs/verification/slate-workspace-upgrade-2026-10-16/`.

## Three editor upgrade — 2026-10-17

Doca now pins the actual registry artifacts `@smartdoca/slate` 0.4.22 and `@smartdoca/slides` 0.3.0-alpha.3. Canvas uses the immutable `vendor/smartdoca-canvas-0.5.0-75e637df1a75.tgz`: the registry 0.5.0 library build tree-shook the Slate/plain-text inner-editor registration modules. The AidCanvas source repair marks both modules as side effects; the host consumes the rebuilt artifact. This artifact and source repair have not been published to npm.

Slate adds five pages of element-color presets and selects the whole diagram label when editing begins. Codec/Yjs/headless bytes match 0.4.20. The unchanged DOCX patch is rebound to 0.4.22. Canvas remains `aidcanvas-yjs` schema 1. Image and attachment callbacks store stable asset IDs, forward real progress and cancellation, and open host-owned authorized previews, including readonly history/trash/audit surfaces. The server validates new inline-media references against the current document's assets. Transient canvas presence forwards validated relative text positions and scene-coordinate pointers with server-owned identity/color; it supports pointer-only messages and never reuses permanent comment anchors.

Slides requires codec revision 6. Both client and server now negotiate `eppt-yjs-v6` with document schema 2/protocol 1. The user explicitly selected **new documents only**: existing `eppt-yjs-v5` documents and old clients are rejected, leaving original checkpoints, update logs, epochs, history and pending message identities untouched. No old-codec reader, metadata relabeling, automatic conversion, migration or SQL structure change is introduced. The host accepts the current native text-inset and table fields, and AI table commands expose merge/split, styles, resize, clear, paste and batch-axis deletion through the native controller. Table cells retain plain text with whole-cell formatting.

Update server and Web together. Keep the previous deployment, package pins, patch, lockfile and artifact. Returning to old code cannot promise readability of new writes; preserve later data before recovery. No user database was modified and no deployment was performed. Isolated acceptance, hashes, screenshots and limits are recorded in `docs/verification/three-editor-upgrade-2026-10-17/`.

## Canvas 0.5.2 registry integration — 2026-10-17

Doca 0.1.31 pins the published `@smartdoca/canvas` 0.5.2 registry artifact. This supersedes the temporary 0.5.0 tarball above, which is removed from the runtime dependency/build path and retained in the preceding source snapshot for recovery. Public exports, dependencies and declaration signatures match that artifact; the sole declaration difference is a table-layout comment. The model runtime is byte-identical. No historical reader, stored-scene conversion, field backfill, codec/schema change or checkpoint/outbox replacement is introduced.

The package fixes consecutive Chinese composition, toolbar tracking during pan/zoom, and content-driven table row growth. Row geometry and text changes use the same native collaborative undo transaction. The host continues its stable model, authenticated resource/presence callbacks and durable ACK queue. Source, browser, image and publication verification is recorded in `docs/verification/release-0.1.31/`; the earlier 0.5.0 evidence remains dated evidence rather than proof of every 0.5.2 operation.

## Canvas inline integration and Slate upgrade — 2026-10-18

Doca 0.1.32 pins the published Slate 0.4.23 and the published registry artifact `@smartdoca/canvas` 0.5.4, which includes Canvas 0.5.3. Slate public declarations, codec/Yjs/headless/conversion bytes match 0.4.22; the identical DOCX patch is rebound. The owner approved current Leafer mind-map display defaults for existing maps. Open/close and preview regeneration remain view-only; explicit save uses the native tree.

Canvas `richTextExtensions` now supports `inline:true`, optional `suggestions:{trigger,search(query,{signal})}` and `matchPaste`/`paste(text,{signal})`. Inline nodes store `{type:'inline',inline:{id,type,label,data},children:[{text:''}]}` in schema-1 rich paragraphs and one U+FFFC marker in native text. The package owns selection, live insertion ranges, debouncing, menu keys, atomic clipboard/deletion/undo, label rendering/export and unknown opaque JSON. Doca supplies directory/ACL checks, user cards, stable reference UUIDs, same-origin document title lookup, notifications and reference indexing. Pending lookup/paste, UI and resolved URLs remain view state. Closed/deleted/readonly targets cannot accept late insertion. Formatting and inline metadata retain existing whole-field LWW semantics.

Active and readonly/history/trash/audit surfaces supply stable `onAttachmentPreview` callbacks to the shared authorized viewer; images retain `onResourcePreview`, and download URLs remain host-authorized. No new transport, autosave, schema/codec, DDL, migration, backfill, historical adapter or epoch/checkpoint/outbox rewrite is introduced. The owner approved no older-client rendering guarantee for new inline metadata. Preserve existing and later data and retain the 0.1.31 deployment, pins, patch and lockfile for recovery. Verification is recorded in `docs/verification/release-0.1.32/` and the native Canvas browser tests; no user documents or databases are used.


## Canvas 0.5.5 host integration — 2026-10-18

Doca 0.2.1 pins the official npm `@smartdoca/canvas` 0.5.5. This patch removes the rich paragraph menu's code-block action and scopes inline/suggestion CSS under the canvas root. Public exports, dependencies, declarations, model and codec remain unchanged from 0.5.4. The host continues the existing inline and resource callbacks; this integration adds no adapter, persisted-format conversion, history rewrite or new compatibility behavior. The title/emoji and access-tag changes are host presentation only. Published-package hashes and isolated browser/image checks are recorded in `docs/verification/release-0.2.1/`.

## Canvas 0.5.6 and Sheet 0.2.4 integration — 2026-10-20

The current checkout pins the official npm artifacts `@smartdoca/canvas` 0.5.6 and `@smartdoca/sheet` 0.2.4. Public entrypoint maps and host-facing declarations are unchanged. Canvas model bytes and Sheet model/Yjs/XLSX bytes match the preceding artifacts. Canvas has changed private rendering declarations and IO bundle references; Sheet explicitly adds `@univerjs/drawing-ui` and `@univerjs/sheets-filter` at the already locked 0.25.1 runtime. No host-source imports or second save channel are introduced.

The owner explicitly approved the upstream Canvas view rules for existing diagrams: a named `frame`/`diagram-node` wrapper with a `diagram-body`, without an explicit conflicting kind/container role, is recognized as a diagram; its duplicate wrapper fill/stroke and generated `Frame` label are suppressed and body/text geometry follows the wrapper. Native explicit containers and unnamed custom paths retain their role/outline. Existing ellipse/diamond endpoint anchors follow the current outline; the four original midpoint port indices remain stable while eight new ports are added. Opening, selecting, viewport changes and closing must not rewrite the original model/checkpoint. Explicit resize/edit operations use the native collaborative transaction and undo stack. No batch conversion, field backfill, DDL, schema/codec adapter, epoch/checkpoint replacement or pending-message reset is authorized. Canvas remains `aidcanvas-yjs` schema 1; Sheet remains `exlsx-cell-registers` schema 6, with exact current-schema rejection.

Canvas images now select first and preview on the next click. PNG clipboard copying uses the host's `resolveDownloadUrl` authorization, including readonly views; snapshot/trash preview adapters preserve their existing access flags, and the server continues rejecting unsupported audit asset access. Sheet uses the shipped native filter renderer and live inline-image geometry/preview; image rendering does not repair incoming document data. Asset UUIDs, ACL checks, transient presence, permanent anchors, durable ACKs and original updates keep their existing ownership.

Existing historical readers, virtual worksheet recovery, normalization helpers and approved display defaults remain in their established paths; they were audited but are not redesigned or extended here. Retain the preceding Canvas 0.5.5 / Sheet 0.2.3 registry artifacts, package pins and lockfile from source revision `589a3589820770d218bea418fe7c93cd10583f95`; artifact identities are recorded in `docs/verification/editor-packages-2026-10-20/package-audit.json`. Update server and Web together. Preserve subsequent writes before rollback; the earlier UI is not guaranteed to render newer diagram interactions identically. No user database or document is used for verification and no deployment is performed. See the [integration verification](verification/editor-packages-2026-10-20/README.md) for passed cases and limits.

## Canvas 0.5.8 and Sheet 0.2.5 integration — 2026-10-21

Doca pins the official npm `@smartdoca/canvas` 0.5.8 and `@smartdoca/sheet` 0.2.5 artifacts. Relative to Canvas 0.5.6 / Sheet 0.2.4, public declarations, entrypoint maps and dependencies are unchanged. Canvas model and Sheet model/XLSX runtime bytes are unchanged. Sheet's Yjs session restores native filters before recalculating combined cell/filter updates and refreshes unchanged criteria after recovery or sorting; this changes projection, not schema-6 encoding or immutable baselines.

Canvas includes 0.5.7's style, wheel, mention and redo fixes, embedded view controls, and 0.5.8's native unbound-connector body translation. Grid/background choices remain view state. Native edit gestures use the existing model, undo, host outbox and durable ACKs. Canvas remains `aidcanvas-yjs` schema 1; Sheet remains `exlsx-cell-registers` schema 6. No host API adapter, new compatibility behavior, stored-data conversion, historical-field default, DDL or epoch/checkpoint/pending-message rewrite is introduced. Existing historical readers, virtual worksheet recovery, normalization helpers and previously approved display rules remain in their established paths without redesign.

Verification uses isolated synthetic documents and databases. Published artifact identities, runtime comparisons, passed checks and limits are recorded in [the integration verification](verification/editor-packages-2026-10-21/README.md). Keep the preceding pins, lockfile, workspace configuration and artifacts from source revision `31fca12f48a54f1c2ce3caeec6a0d976e164ac4e` for package rollback; rebuild server and Web together and preserve later writes. No user document/database or deployment is used.

## Issue-tracker integration and personal Canvas preferences — 2026-10-22

The latest audited official npm baseline is Slate0.4.24, Markdown0.4.4, Sheet0.2.9, Canvas0.5.13 and Slides0.3.0-alpha.4; the current checkout temporarily tests the0.5.14C1file candidate described below. Audits compare actual archives and installed files, not source-only APIs. Existing codec/schema, immutable baselines, epochs, checkpoints, original pending document updates and durable ACK ownership are retained. Canvas0.5.13 model/IO/preferences/declarations/exports match0.5.12; its internal keyboard-helper declaration adds no public SDK API. Sheet 0.2.9 includes clipboard and dropdown-validation removal fixes while model/Yjs/XLSX runtime bytes remain identical to 0.2.7. Gallery callbacks resolve authorized view state without committing editor drafts. Existing approved historical readers, normalization and display rules are unchanged; no old-data conversion, schema adapter, migration or DDL is introduced.

The user explicitly approved Canvas browser preferences scoped by website origin, account and document. Independent version-1 records are validated with the published pure validators and passed through controlled view/creation props. Missing records retain existing behavior; unknown/malformed records are preserved and neither consumed nor overwritten. Storage failure preserves only the explicit current-view choice. Preference updates, menu navigation and minimap movement do not enter document undo or collaboration; creation defaults affect only future interactive elements, never existing content, API/AI insertion, imports or remote projection. The existing in-memory session style cache is not converted into a preference record. Rollback disables consumption and leaves records and later content intact.

The host still owns one model/session and transport. The temporarily installed0.5.14C1file candidate passes native17/preferences7on exact155files, but official/final compiled acceptance remains separate. Focus repairs keep explicit object/tool interactions distinct from automatic completion, without weakening external input/control ownership. Package updates add no autosave, migration, baseline reconstruction or epoch/message-ID replacement. Isolated website evidence and remaining limits are tracked in [the issue-tracker verification](verification/issue-tracker-2026-10-21/README.md). Keep the previous artifacts/manifests/lockfile and rebuild server and Web together for package rollback; never restore an old database over later edits.

## Native input and authorized append boundaries — 2026-10-22

Native editor dispatch must check event ownership before acting on a retained selection. Host comment/AI inputs keep their keyboard, clipboard and composition behavior without document writes. Canvas 0.5.12 repairs the native path; the host retains comment drafts through adjacent AI/layout changes and loads authorized permanent markers independently of the drawer. There is no new anchor, codec, model, command or presence format. The official archive matches the tested C3 keyboard/comments candidate; older 0.5.11 full interaction receipts keep their exact scope.

The approved rich-text/Markdown browser quick note appends explicitly supplied plain text to an explicitly selected authorized existing append target. It uses the existing native epoch, content transaction and receipt/delivery path. Lost response retries the original ticket/request ID and payload; accepted replay does not append twice or increment seq. Target selection, input and process-local five-minute tickets are temporary, with no persistent extension draft queue or cross-process recovery promise. The original document and later edits remain intact; unsupported targets fail without conversion. See [the quick-note contract](browser-quick-note.md) and its isolated two-page/actual MV3 receipts.

## Approved AI pending-send storage — 2026-10-22

This is the host AI sender queue, separate from the document collaboration outbox. The user approved the concrete preservation/rollback plan twice. New ready sends use independent IndexedDB `doca-ai-pending` version 1, store `entries`, keyed by `[docaOrigin,userId,connectionId,messageId]`, with explicit extension profile identity/revision. Conditional transitions finish only after the short readwrite transaction commits; Web Locks serialize network delivery, not storage writes. Accepted/withdrawn source tombstones remain. Unknown versions/records and denied or failed storage are preserved and refused without localStorage or memory-only fallback.

Original 0.2.7 localStorage queues remain read only and do not auto-replay. Each recognized item needs explicit continuation or withdrawal and current settings; complete payloads retain original IDs and source hashes, and accepted jobs reconcile without resending. Before upgrade or rollback, stop sending and close every old website page/extension: mixed old/new senders are unsupported because old senders cannot see new tombstones. Rollback stops the new sender and retains both stores, tombstones and later data; it does not copy back or automatically restart old sending. No server tables, chat/document history, permissions or editor checkpoints are converted. Exact rules and two-page/refresh/failure/legacy evidence are in [the approved queue record](verification/issue-tracker-2026-10-21/ai-pending-idb.md).

## Approved spreadsheet dimensions and personal zoom — 2026-10-23

The owner explicitly approved 21.78 CSS-pixel default row height and 87.12 CSS-pixel default column width, a ten-percent increase. New host worksheets use these values. Historical appended and virtual-recovery worksheets with no stored default dimensions also use the new display defaults. Explicit baseline defaults, row/column overrides, original baseline bytes, worksheet seeds, checkpoints, epochs and pending updates are preserved; no historical-field backfill, persisted-data conversion or schema change is authorized. Returning to the preceding package restores its old missing-field display defaults while preserving later edits. Existing native manual row/column resizing remains collaborative and undoable.

The footer still defaults to 100%. The host stores only explicit native zoom choices in independent version-1 browser records, scoped by origin, account and document. This is one document-wide display ratio, including worksheet switches, not a row/column-size override. Opening without a record does not write one. Unknown versions, malformed records and unrecognized fields are preserved and not overwritten; failed storage keeps the explicit choice only in the mounted view. Anonymous views do not persist a record. Rollback stops reading/writing the new records and leaves them and all later content intact.

The package owns native zoom rendering and callbacks; the host owns browser storage and identity. Applying the preference, dragging the footer, using plus/minus, switching worksheets, readonly changes, resizing and remote projection must not enter document undo, outbox, content updates or history. Personal zoom must not leak into exported snapshots or XLSX. This policy is an agreed boundary, not proof that an installed package exports the required props; integration must verify the published artifact and isolated two-page/browser receipts.

## Approved spreadsheet filter expansion — 2026-10-23

The owner explicitly approved preserving a stored filter range on open, extending it downward to the last content row in its existing columns when active criteria are confirmed, and automatically including contiguous records appended immediately below it. Headers, column boundaries and selected criteria remain unchanged. Styles, content in other columns and clearing criteria do not expand the range. Native range expansion must be authored with the appended content in one shared transaction and undo step; remote projection and recovery must apply the authored range before deriving hidden rows, without local echo.

The official Sheet 0.2.12 implements this policy using existing schema-6 cell and stable-feature registers. It introduces no editor schema, public API, historical adapter, stored-data conversion, DDL, baseline/epoch replacement or pending-update rewrite. Previously approved historical readers and defaults remain unchanged. Existing short ranges are repaired only by an explicit confirmation, never by opening a document. Rollback preserves saved native ranges and all later content; preceding packages can read those ranges but do not durably author later implicit extensions.

Doca 0.2.11 pins the official npm Sheet 0.2.12. Package and isolated host acceptance remain separate from production deployment. See [filter verification](verification/sheet-filter-range-2026-10-23.md).

## Runtime boundary for comment backgrounds — 2026-10-28

Sheet 0.2.14 `commentHighlightAnchor` and Slides 0.3.0-alpha.5 `activeCommentId` are host-controlled view props. The host supplies only the explicitly clicked authorized current comment. Opening the drawer, link navigation and native content-marker clicks do not activate a comment background. Clicking elsewhere, resolution or drawer close clears it; switching comments replaces it and reopening does not restore it. SDKs use existing anchor resolution/current geometry for non-interactive backgrounds without writing models, permanent anchors, transactions, undo, presence, outboxes or storage. Canvas 0.5.16 table-port visibility is also view state. This boundary changes no anchor format or existing deleted-target resolution policy; unknown schemas still fail exact negotiation, with no old-format reader or conversion.
