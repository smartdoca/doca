# File exchange integration contract

This contract applies to file import/export and conversion-package upgrades across Doca editors. Basic content and acceptable styling take priority over complete Office fidelity. Documented loss is acceptable; important content must not disappear silently. Responsibilities and acceptance requirements do not imply every package already implements every interface.

## Responsibilities

- Packages identify formats, parse/serialize, convert models, enumerate assets, report structured warnings/errors, and enforce file/decompression/image-dimension limits. Expose pure converters through independent entry points and declare Node/browser requirements.
- The host selects files, creates resources, authorizes upload/download, provides feedback, chooses filenames, and triggers browser downloads. Packages must not call platform APIs, create business documents, or establish another save channel.
- Import results contain native models, pending assets, and warnings. Export results contain Blob, filename, MIME, and warnings. Follow the installed version's actual types rather than assume unified method names.
- Supported types follow delivered capability. Filename accept filters are hints; parsers verify contents. Product UI does not offer JSON upload/download: internal models/recovery copies are separate from portable formats.

## Collaboration, assets, and security

- Import normally creates a new resource, epoch, and stable identity, without replacing an actively edited Y.Doc or reusing comments, permissions, history, or outbox. Full-body replacement requires a separate explicit protocol.
- If upload requires a resource, create its record, upload assets, then perform one-time initialization. The server rejects initialized/opened/modified resources; this endpoint cannot become a full-save bypass around collaboration.
- Reuploaded assets receive the new document's stable IDs. Never persist blob/data/temporary signed URLs or trust user/resource/permission IDs from imported files. External assets are not fetched automatically; host-supported fetching requires SSRF, size, and origin controls.
- Sanitize active content such as SVG. Doca rasterizes SVG already sanitized by the canvas package and uses the existing image-upload service, without enabling arbitrary same-origin SVG execution.
- Business history follows the retention rules of the collaboration contract. Removing a history row does not establish that assets are unreferenced and cannot justify deleting attachments. Export reads current content or a retained requested version; an evicted version returns not-found rather than current content masquerading as history.
- Export enforces current resource access. Conversion changes no body, selection, undo, presence, or save state and neither waits for nor fabricates ACKs. If the package requires native editing to finish first, the host explicitly finishes it before calling export rather than hiding flush in a pure converter.
- Cancellation, failures, and late callbacks cannot insert into a different document/selection. The server rechecks access. Aborted upload does not prove server assets rolled back; document temporary-resource cleanup.

## Product matrix recorded on 2026-09-12

| Format | Import | Export | Accepted limitations |
| --- | --- | --- | --- |
| Rich text | DOCX, MD/Markdown | DOCX, MD | Simplified complex layout; custom objects may degrade to readable text; no legacy DOC |
| Spreadsheet | XLSX | XLSX | Basic values, formula text, multiple sheets, styles; images/attachments/business identities may degrade with warnings |
| Markdown | UTF-8 MD/Markdown | Original MD | Retains resource references without offline asset packaging |
| Canvas | PNG/JPEG/WebP/SVG assets | PNG/SVG | Imports image assets rather than reconstructing native layers; no editable-model roundtrip promise |
| Presentation | Delivery unconfirmed | Delivery unconfirmed | Do not enable entries based on an upcoming readiness claim |

Inspected interfaces: slatetsx 0.4.0 `/conversion` importDocument/exportDocument; exlsx rc.5 `/xlsx` xlsxToSnapshot/snapshotToXlsx returning result objects; exmd 0.4.1 importMarkdownFile/exportMarkdownFile; aidcanvas 0.4.0 `/io` and handle.exportFile. When reusing a version number, use a hash-named package and update the lockfile. Accept installed artifacts rather than source README claims alone.

## Acceptance evidence

Clipboard operations follow the same asset boundary. Packages report files/text and captured insertion targets; the host uploads images/attachments and checks internal links/access, then the package inserts through normal edit transactions. Async completion cannot use a newer current selection or write into closed/readonly documents. Native spreadsheet multiline/tab paste remains. Hyperlinks accept safe protocols only; internal documents store stable IDs and generate relative URLs without deployment domains. Current spreadsheet business objects occupy whole cells, without mixed inline rich-text support claims; XLSX roundtrips may degrade to readable labels with warnings.

Use isolated data and real files to cover basic Chinese text/styles/tables/graphics, editing and reload after import, exported-file reopening/reimport, synchronization between editor instances, zero body increments on export, readonly export/edit guards, corrupt/oversized/cancelled files, asset rebinding/unauthorized reads, and visible warnings. Record passed, lossy, and unverified cases individually. A successful build does not prove correct file exchange.
