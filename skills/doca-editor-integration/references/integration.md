# Editor integration contract

## Ownership

Package: document data model, native selection, normalized editing transactions, undo/redo, inline/void semantics, format state, anchor resolution, viewport and format-specific import/export.

Host: one authenticated realtime session/outbox, durable server ACK, permissions and invitation acceptance, resource uploads/download authorization, identity cards/@ directory, notifications, reference graph, page navigation, toolbars/search UI, history and business metadata.

Do not encode current deployment origins, temporary signed URLs, user session secrets, or selected directory results into document content. References and attachments store stable identifiers. Host resolves access and addresses at use time.

## Verified rich-text surface (2026-09-11)

Verified against `slatetsx-kit-editor` 0.2.0 artifact `eef381ed` installed in Doca. Version reuse is possible: inspect the actual artifact rather than assuming every 0.2.0 build has identical behavior.

- `mode: 'edit' | 'readonly'`. Doca enables edit only after synchronization, with rank >= editor, connected and not presenting. Server authorization is still authoritative. Readonly supports selecting/copying/search; comments depend on separate authenticated comment permission. Readonly never publishes or draws editing cursors.
- `initialValue` for standalone initialization; `value` is an externally controlled full replacement, not the realtime transport. With collaboration, do not feed every received snapshot through `value`/setValue.
- `collaboration`: one stable `createYjsAdapter(runtime)` instance per document session. `onReady(handle)` means the UI handle exists, not that transport/bootstrap or uploads are ready.
- `plugins`, `resources`, and adapter objects keep stable references. In particular changing `plugins` reconstructs this editor. Host profile/ACL/selection/save-state updates must not recreate those objects or the underlying Y.Doc.
- `onChange` can run for selection-only changes; it is not a save trigger. Use local CRDT transactions and the shared outbox for persistence. Keep format-state reads lightweight; do not stringify the entire document on cursor movement.
- `ref` / `onReady` yields `RichTextEditorHandle` with `commands`, `query`, `editor`. Current commands include undo/redo, insertLink/removeLink, toggleMark/toggleBlock, table/columns and upload helpers. Both toolbars read the same query/model state. Preserve selection on icon mousedown, but do not prevent normal input focus inside forms; retain a live range reference while a link form is open.

Async inline insertion (for example fetching an internal document title) must retain that range until completion. Do not let a global menu-button auto-dismiss handler close the form and release the range before the request returns. Outside-click cancellation should release the range and prevent the late response from inserting elsewhere. Insert an internal atomic reference as a complete node; generic wrap-selected-text hyperlink commands have different semantics. Browser tests should wait for actual editable focus before sending synthetic keystrokes; focus can be deferred while Slate operations flush.

## Resources

`resources` currently accepts `uploadImage`, `uploadVideo`, `uploadAttachment`, `resolveUrl`, `resolveDownloadUrl`. Inspect current callback argument and result types, including progress/cancellation context, before implementing an adapter.

Uploads go through the platform asset service, bind to the resource ID, recheck write permission, and return a stable asset `path` plus relevant name/size/MIME/dimensions. Doca uses asset UUIDs as `path`. The resolver produces same-origin permission-checked content/download endpoints; server storage settings select local/object storage/CDN. Downloads must not bypass asset ACL.

Use editor upload commands for placeholders, ordering, retry/error handling and selection stability, rather than inserting arbitrary successful URLs on promise completion. Cancel/remove stale uploads on disposal; server must reject uploads after revocation. No side-effectful upload from rendering, readonly transitions or remote projection. Choose UI auto-save for simple preferences; keep confirmation for destructive moves/deletes/permission resets.

## Custom business inline objects

User lookup, candidate UI, avatar cards, navigation and notifications belong to the host. Package extensions must preserve `attributes`, Slate children/anchors and actual `inline`/`void` behavior, not just apply `contentEditable=false` to editable text.

Doca's current bridge uses the SDK's supported `link` codec: `#/u/{internal-user-uuid}` and `#/r/{resource-uuid}`, with a label text child. Host plugins declare these internal links inline voids and render an uneditable chip plus hidden required Slate child. This keeps the link CRDT encoding explicit rather than inventing fields the codec silently drops. SDK `custom:*` plugins alone do not guarantee Yjs serialization. New custom fields/types need an explicit codec, validation, copy/paste and checkpoint contract first.

Verify whole-object selection, Backspace/Delete, copying/pasting a rich fragment, undo, remote updates and reload. Never flatten a chip to editable characters to make it render. Store relative IDs for internal links; external links keep validated HTTP(S)/mailto URLs. User-visible names are labels, not authorization or identity keys.

Reference edges are derived from the persisted model, transactionally alongside content updates; they are not navigation telemetry. Backfill old documents without rewriting CRDT. On every read filter both incoming/outgoing results by current document ACL, including trash/revocation; do not leak inaccessible titles, identifiers or counts. Changing title/domain must not break the edge.

## Find/replace boundary

Preferred cross-editor target: model capability `find(query, options) -> matches`, `reveal(match)`, `replace(match, text)`, `replaceAll(query, text)`, plus change invalidation and supported-options metadata. Match handles are tied to a model revision or live anchors, not stale DOM offsets. These are proposed semantic capabilities, NOT exported slatetsx methods today.

Platform owns the compact search/replace panel, shortcut, query state and access gating. Package/model owns finding text across formatted leaves, locating code/cell data, replacing using native transactions and undo, and collaboration origin. Never replace via innerHTML/textContent or mutate cached JSON outside the editor.

Current Doca rich-text adapter uses Slate operations (`rich-text-search.ts`) and CSS Highlight for search display. Replacement excludes atomic objects, supports text and code blocks, applies from end to start, and uses one editor change batch. Current search is literal case-insensitive, not regex, formulas or semantic search. Move these semantics behind a package capability when available; retain platform UI. Large/virtualized editors need model-based enumeration and reveal, not DOM-only scanning. Excel should wrap its own native find/replace, not reuse Slate.

## Presence and platform integration

Online member avatars are a platform header concern, shared by document types; members are deduplicated by user, editing cursors by session (same user in two tabs has two cursors). Do not mount a second room subscriber that joins/leaves the document just to show avatars; consume existing presence messages.

Discovery is separate from access: permission enables reading/search, not unconditional listing. Doca config separates invitation/direct grants, direct-document list discovery, library membership discovery and optional public-library catalogue. Whole-library membership does not imply that every child is directly shared. Public documents are discoverable by search but never populate the shared-document list merely because public access exists.

## Locale

The host owns the active interface language and passes `locale` (`zh` or `en` today) into an editor once that package's props include it. Unknown codes fall back to English inside the package. Packages keep their own catalogs and use stable English keys, not Chinese or full-sentence English keys. Switching locale updates package chrome only and must not reconstruct the document, Y.Doc, collaboration adapter, or plugin list. Follow `doca-i18n` (`skills/doca-i18n` in the Doca repo, or the installed `$doca-i18n` skill).

The host passes `locale` into each editor mount. Do not add it to a dependency list that rebuilds the document, Y.Doc, collaboration adapter, or plugin list.

## Acceptance evidence

Check stable mount through selection/style/profile/save updates; readonly safety; asset callbacks and abort/errors; local edits vs remote/idle events; same-account dual sessions; snapshot reload; atomic inline roundtrips and clipboard; single and bulk replace with undo, code and split formatted leaves; target link resolution across origin changes; graph privacy; invitation accept/refuse/revoke and separate discovery rules.

Doca uses its shared host WebSocket/outbox; an SDK transport helper is not part of the host integration. This skill does not imply a persistent offline outbox or universal Excel/PPT capabilities. For protocol versions, epochs, durable ACK, checkpoints and collaboration failure modes use the separate collaboration contract.

## Plugin elements increment — 2026-10-02

Source host 0.1.8 and SDK 0.1.6 now implement `WebPluginBundle.elements` and `plugin-sdk/editor-elements`. These are current source exports, not proof of npm publication or native-device acceptance. `@smartdoca/slate` 0.4.12 has a host-owned permanent `custom:plugin-element` atomic inline codec/renderer; business registrations change only its registry lookup and never remount the editor. `@smartdoca/sheet` 0.2.0-rc.17 exposes native `cellRenderers` and range `setValue(ICellData)`; the host stores a whole-cell element in `custom.docaElement` with a static text `v`. The fixed built-in `SpreadsheetCellObject` union is not extended or coerced.

Configuration sessions capture a live rich range or stable single-cell anchor, recheck readonly/provider/current target, and commit native operations with native undo. Missing type, provider, format or exact version shows an error placeholder while retaining opaque bounded JSON. Existing internal reference readers are unchanged. No compatibility adapter, automatic conversion or migration is introduced. General blocks, floating spreadsheet objects and public arbitrary editor mutation handles remain unimplemented. See the repository source `docs/plugin-editor-elements.md` and independent example `examples/plugin-elements/README.md` for precise fields, limits and installation.

Performance: ordinary cells take a property-check fast path. Validation is memoized per immutable payload/provider; registry changes invalidate the canvas cache. Only painting a visible timed cell schedules another view refresh, at most once per second; hidden pages pause and sheets with no visible timed cells have no recurring canvas timer. No ticking data is persisted. Third-party renderers still own their CPU/network work and require their own performance acceptance.

## Markdown bootstrap correction — 2026-10-03

The host restores the authoritative checkpoint into an empty replica before calling the shipped Markdown session factory. It no longer stamps local metadata into a loading replica: those unsubmitted CRDT clocks caused the first text update to depend on items absent from the server. Session status snapshots retain the same doc/text/awareness/undo objects. No schema, epoch or persisted-format adapter changes; existing pending edits are preserved and are not silently converted or cleared. Regression acceptance includes first-edit durable restore, no remote/bootstrap echo and stable status handles; browser verification covers typing, cross-instance updates, reload and idle checks on isolated documents.

## Current host inventory — 2026-10-04

Host 0.1.10 integrates `@smartdoca/slate` 0.4.12, `@smartdoca/sheet` 0.2.0-rc.17, `@smartdoca/markdown` 0.4.3, `@smartdoca/canvas` 0.4.2 and `@smartdoca/slides` 0.3.0-alpha.2. Earlier dated artifact inventories above describe their original versions, not the complete current package surface. Current source guides are `docs/editor-integration.md` and `docs/editor-file-exchange-contract.md`.

All five host formats use the shared transport/ACK lifecycle and implement content-comment anchors. Spreadsheet region comments use stable row/column identities with native capture/resolve/reveal and server validation. All formats expose history reads, but only rich text and Markdown support manager restore; other previews report `canRestore:false`. PDF import/export and PPTX import/export are connected in the host. Persistent offline outboxes, a unified cross-format component API and device/service acceptance remain separate gaps. No compatibility behavior, persisted schema or user data is changed by this inventory update.

## Attachment preview increment — 2026-10-04

Host 0.1.11 installs `@smartdoca/slate` 0.4.13 and `@smartdoca/sheet` 0.2.0-rc.18. Both export `onAttachmentPreview`: rich text receives `AttachmentElement` with a stable asset path and metadata; spreadsheet receives `SpreadsheetAttachmentPreviewEvent` with `node.refId/label` and the current cell location. Stable host callbacks open the existing `DocumentFilePreview` through permission-checked asset endpoints, including readonly/history/trash views. Rich text's edit-mode first click selects, subsequent click or preview button previews; readonly previews on the first click. Spreadsheet previews native inline attachment-label clicks. Existing whole-cell objects are still rendered through their current API. Preview remains view state: no codec, schema, epoch, checkpoint, outbox, migration or stored-data change. Do not reintroduce DOM/selection-based attachment lookup or store resolved preview URLs in document nodes.

## Rich-text diagram and upload integration — 2026-10-10

The host toolbar inserts flowcharts and mind maps through the installed 0.4.13 `commands.insertBlock` API with complete native elements. It does not use `toggleBlock` to convert a paragraph into an incomplete diagram. Whole-block comments and AI references share the current block-anchor contract; native diagram labels do not gain user-mention support.

The upload adapter forwards real asset-transfer bytes to `UploadContext.onProgress` as a fraction, keeping progress below 1 until the asset service succeeds. Image, video and attachment commands keep their native placeholders, cancellation, retry and undo lifecycle.

AI diagram edits read the complete block rather than reconstructing it from outline labels. Node fill/border/text colors use `fillColor`/`color`/`textColor`; edge color/width use `color`/`thickness`. A free endpoint uses the SDK's empty source/target ID plus `sourcePoint`/`targetPoint`; an unknown nonempty ID is rejected. Updating nodes, edges or mindData invalidates the generated SVG and its derived bounds in the same native content transaction. Width-only changes retain that preview. No stored-format adapter, automatic conversion, compatibility plan or migration is introduced. Existing historical readers are unchanged.
