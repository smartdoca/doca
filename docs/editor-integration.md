# Editor integration and file exchange

[中文](editor-integration.zh-CN.md)

Host 0.1.11 integrates five editors. Use actual installed exports; target interfaces and gaps are not existing APIs. Responsibilities are detailed in the [integration reference](../skills/doca-editor-integration/references/integration.md) and [collaboration contract](collaboration-sdk-contract.md).

## Installed packages and host adapters

| Format | Installed package | Host entry |
| --- | --- | --- |
| Rich text | @smartdoca/slate 0.4.13 | document-editor.tsx |
| Markdown | @smartdoca/markdown 0.4.3 | markdown-editor.tsx |
| Spreadsheet | @smartdoca/sheet 0.2.0-rc.19 | spreadsheet-editor.tsx |
| Canvas | @smartdoca/canvas 0.4.2 | canvas-editor.tsx |
| Slides | @smartdoca/slides 0.3.0-alpha.2 | presentation-editor.tsx |

Entries are in the [document feature](../apps/web/src/features/documents). Packages own models, editing commands, undo, rendering, selections, and conversion. The host owns identity, ACLs, uploads/downloads, references, user cards, navigation, comments, and collaboration transport. Locale updates chrome without translating content or rebuilding the editor.

## References, resources, and find

Internal references retain stable UUIDs and relative `#/r/{id}` locations. Mentions retain user UUIDs and obey current directory policy. Forward/reverse references recheck reading permission; references grant no access.

Images, attachments, and materials use host resource callbacks. Progress, cancel, errors, and late callbacks stay bound to the original target. Downloads authorize through `assets/:id/content?download=1`; physical storage locations are not durable references.

Rich text and spreadsheets pass stable `onAttachmentPreview` callbacks to the installed editors. Rich text supplies `AttachmentElement.path/name/mimeType`; spreadsheet native inline attachments supply `event.node.refId/label`. The host resolves asset UUIDs to permission-checked content endpoints and opens the shared `DocumentFilePreview`, also in readonly/history/trash views with their existing access flags. Rich text selects an attachment on the first edit-mode click and previews on the next click or its preview button; readonly previews on the first click. Spreadsheet previews clicks on the native attachment label. The existing whole-cell object renderer remains available. Preview does not change the model, collaboration session, or persisted format.

Find/replace uses editor models or native capabilities. Rich text uses a host Slate adapter; other formats use installed package find/replace or native panels. Readonly, disconnected, and presentation modes offer no content replacement. There is no generic public arbitrary-editor mutation handle or promise of identical text ranges/regex across formats.

## File import/export

| Format | Import | Export and limits |
| --- | --- | --- |
| Rich text | DOCX, Markdown, PDF | DOCX, Markdown, PDF; complex layout may simplify, no old DOC |
| Markdown | Markdown, converted PDF | Markdown, PDF; no complete offline asset bundle |
| Spreadsheet | XLSX | XLSX; unsupported objects may degrade with warnings, no full Office fidelity |
| Canvas | PNG/JPEG/WebP/SVG image assets | PNG/SVG; import does not restore native layers |
| Slides | PPTX, up to 30 MB | PPTX; basic text, shapes, tables, images; complex masters/animation may simplify, no old PPT |

Import creates a new document and lineage and rebinds authorized assets; it never replaces an active document. Conversion warnings are shown. PDF export uses browser/component generation and does not guarantee exact Office layout. See [file-transfer.tsx](../apps/web/src/features/documents/file-transfer.tsx) and the [file exchange contract](editor-file-exchange-contract.md).

## Comments and business extensions

Permanent anchors differ from live cursors. All five formats provide content comments. Spreadsheet uses stable row/column IDs and native capture/resolve/reveal methods; structural changes and deleted targets are validated. Unknown plugin elements retain opaque data with an unsupported placeholder, never automatic conversion or deletion.

Installed providers contribute templates, materials, and document elements, with zero default providers. Rich atomic inline and spreadsheet whole-cell elements are implemented; general blocks and floating spreadsheet objects are unavailable. See [element contract](plugin-editor-elements.md) and [creation resources](creation-resources.md).

## Verification scope

Check installed README, exports, and schema before upgrades. Use isolated documents for real file roundtrips, readonly guards, authorized assets, two-page sync, receipts, and reload. A cell-edit test does not establish convergence for every spreadsheet operation; a successful build does not establish device acceptance. Early integration/acceptance records remain in [research](research.md).

## Rich-text diagram and upload integration — 2026-10-10

The host toolbar inserts flowcharts and mind maps through the installed 0.4.13 `commands.insertBlock` API with complete native elements. It does not use `toggleBlock` to convert a paragraph into an incomplete diagram. Whole-block comments and AI references share the current block-anchor contract; native diagram labels do not gain user-mention support.

The upload adapter forwards real asset-transfer bytes to `UploadContext.onProgress` as a fraction, keeping progress below 1 until the asset service succeeds. Image, video and attachment commands keep their native placeholders, cancellation, retry and undo lifecycle.

AI diagram edits read the complete block rather than reconstructing it from outline labels. Node fill/border/text colors use `fillColor`/`color`/`textColor`; edge color/width use `color`/`thickness`. A free endpoint uses the SDK's empty source/target ID plus `sourcePoint`/`targetPoint`; an unknown nonempty ID is rejected. Updating nodes, edges or mindData invalidates the generated SVG and its derived bounds in the same native content transaction. Width-only changes retain that preview. No stored-format adapter, automatic conversion, compatibility plan or migration is introduced. Existing historical readers are unchanged.
