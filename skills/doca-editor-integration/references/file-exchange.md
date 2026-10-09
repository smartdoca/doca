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

## Product matrix recorded on 2026-10-04

| Format | Import | Export | Accepted limitations |
| --- | --- | --- | --- |
| Rich text | DOCX, MD/Markdown, PDF | DOCX, MD, PDF | Simplified complex layout; custom objects may degrade to readable text; no legacy DOC |
| Spreadsheet | XLSX | XLSX | Basic values, formula text, multiple sheets, styles; images/attachments/business identities may degrade with warnings |
| Markdown | UTF-8 MD/Markdown, PDF converted to Markdown | MD, PDF | Retains resource references without offline asset packaging |
| Canvas | PNG/JPEG/WebP/SVG assets | PNG/SVG | Imports image assets rather than reconstructing native layers; no editable-model roundtrip promise |
| Presentation | PPTX, at most 30 MB | PPTX | Basic text, shapes, tables, images; complex masters/animations may simplify; no legacy PPT |

Installed packages: `@smartdoca/slate` 0.4.13, `@smartdoca/sheet` 0.2.0-rc.18, `@smartdoca/markdown` 0.4.3, `@smartdoca/canvas` 0.4.2, `@smartdoca/slides` 0.3.0-alpha.2. Import dispatch is in `apps/web/src/features/documents/file-transfer.tsx`; exports use the respective host editor adapters. PDF import recognizes/converts content and reuploads assets; it does not preserve original page layout. Reused versions need hash-named artifacts and lockfile updates. Independent applications and complex files still need individual acceptance.

## Rendered PDF and editable import

Rich-text PDF export mounts a cloned native value as a readonly portal under the host's existing locale/plugin contexts. It does not attach collaboration, replace the live editor, finish an edit, or write a checkpoint. Markdown export mounts the package's preview under the same editor typography. Both wait for images, formulas and diagrams, copy computed styles, embed authorized platform images and fonts, remove editing controls, and send a self-contained view to `POST /api/v1/resources/:id/pdf`. Video/audio become readable labels with authorized download links; attachment and mention labels remain readable. PDF text stays selectable. Pages retain the measured document width and use a paper aspect ratio of √2, with 24 px vertical print margins; pagination may differ from an unpaginated screen.

The host renderer uses `playwright-core` with sandboxed Chromium, disabled scripts/service workers, restrictive CSP and blocked network requests. It rechecks `read_content` after rendering, permits readonly/public reading according to existing policy, and limits requests to 32 MiB, two simultaneous jobs and 60 seconds. Browser installation is a deployment prerequisite, not an editor SDK capability. Run `pnpm exec playwright-core install chromium --only-shell` for source installs, or configure `DOCA_PDF_CHROMIUM`. This checkout's Dockerfile installs Chromium and CJK fonts and runs as `node`; its host must allow Chromium's sandbox. The container image build and Windows/macOS Word visual reopening remain unverified.

PDF import prioritizes editable native content. The shipped Markdown parser still validates file/page/image limits and extracts assets/warnings. The host PDF.js adapter then reconstructs font size, basic font families, bold/italic, text colors, safe links, size-based heading hierarchy, simple list markers, regularly spaced tables and page-ordered images. Rich text receives that native model directly; Markdown receives its portable serialization. Existing asset rebinding and one-time new-document initialization remain the save boundary. PDF background fills, underlining, vector drawings, complex columns/tables and math reconstruction are approximate; scans remain images without OCR. Parser warnings are surfaced. No stored-model, schema, old-format conversion or migration changes are introduced.

`patches/@smartdoca__slate@0.4.13.patch` adds direct Word run font/size/color/background, paragraph alignment and table-cell marks to both ESM/CJS conversion entries, with online heading sizes, 1.6 line spacing and A4 defaults. It does not resolve arbitrary inherited Word styles, complex sections or exact pagination. `patches/@smartdoca__markdown@0.4.3.patch` preserves generated math span styles in the preview; it changes neither the Markdown storage model nor its protocol. These are checked-in host patches, not claims about published upstream packages.

Acceptance: `tests/document-pdf.test.ts` exercises real Chromium PDFs, selectable Chinese text, native PDF reconstruction, real DOCX XML/reimport, and blocked scripts/remote images. `tests/document-pdf-access.test.ts` covers readonly access, revocation and zero source checkpoint changes. `node --import tsx scripts/qa-document-pdf.mts` runs isolated browser fixtures, verifies host context retention and zero Y.Doc updates, exports/reimports images, checks Mermaid/math and a three-page table, and writes visual artifacts under `.local/document-pdf-qa/`. Use Poppler to inspect the generated PDFs alongside the online screenshots; no user documents or production database are opened.

## Acceptance evidence

Clipboard operations follow the same asset boundary. Packages report files/text and captured insertion targets; the host uploads images/attachments and checks internal links/access, then the package inserts through normal edit transactions. Async completion cannot use a newer current selection or write into closed/readonly documents. Native spreadsheet multiline/tab paste remains. Hyperlinks accept safe protocols only; internal documents store stable IDs and generate relative URLs without deployment domains. Current spreadsheet business objects occupy whole cells, without mixed inline rich-text support claims; XLSX roundtrips may degrade to readable labels with warnings.

Use isolated data and real files to cover basic Chinese text/styles/tables/graphics, editing and reload after import, exported-file reopening/reimport, synchronization between editor instances, zero body increments on export, readonly export/edit guards, corrupt/oversized/cancelled files, asset rebinding/unauthorized reads, and visible warnings. Record passed, lossy, and unverified cases individually. A successful build does not prove correct file exchange.
