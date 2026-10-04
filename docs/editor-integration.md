# Editor integration and file exchange

[中文](editor-integration.zh-CN.md)

Host 0.1.10 integrates five editors. Use actual installed exports; target interfaces and gaps are not existing APIs. Responsibilities are detailed in the [integration reference](../skills/doca-editor-integration/references/integration.md) and [collaboration contract](collaboration-sdk-contract.md).

## Installed packages and host adapters

| Format | Installed package | Host entry |
| --- | --- | --- |
| Rich text | @smartdoca/slate 0.4.12 | document-editor.tsx |
| Markdown | @smartdoca/markdown 0.4.3 | markdown-editor.tsx |
| Spreadsheet | @smartdoca/sheet 0.2.0-rc.17 | spreadsheet-editor.tsx |
| Canvas | @smartdoca/canvas 0.4.2 | canvas-editor.tsx |
| Slides | @smartdoca/slides 0.3.0-alpha.2 | presentation-editor.tsx |

Entries are in the [document feature](../apps/web/src/features/documents). Packages own models, editing commands, undo, rendering, selections, and conversion. The host owns identity, ACLs, uploads/downloads, references, user cards, navigation, comments, and collaboration transport. Locale updates chrome without translating content or rebuilding the editor.

## References, resources, and find

Internal references retain stable UUIDs and relative `#/r/{id}` locations. Mentions retain user UUIDs and obey current directory policy. Forward/reverse references recheck reading permission; references grant no access.

Images, attachments, and materials use host resource callbacks. Progress, cancel, errors, and late callbacks stay bound to the original target. Downloads authorize through `assets/:id/content?download=1`; physical storage locations are not durable references.

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
