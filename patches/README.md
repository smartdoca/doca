# Document conversion patches

These patches target the locked packages, not a new upstream release. `pnpm-workspace.yaml` and the lockfile apply them during installation, including Docker builds.

- `@smartdoca/slate@0.4.13`: ESM and CJS DOCX converters preserve directly assigned font family, font size (CSS px ↔ Word half-points), hex foreground/background colors, paragraph alignment and table-cell marks. Explicit false/off Word emphasis is respected. Default headings match the online sizes, body text is 16 px with 1.6 line spacing, and the page is A4 with 48 px margins. Arbitrary inherited Word styles, complex sections and exact Word pagination are outside the verified scope.
- `@smartdoca/markdown@0.4.3`: the preview's color-span component retains generated inline styles from KaTeX. Overwriting those styles made superscripts and fractions lose their positioning in both the online preview and PDF. ESM and CJS entrypoints now load PDF conversion through private asynchronous chunks, so preview/editor consumers do not eagerly load PDF.js, its worker, pdf-lib or fontkit. Public root exports, declarations, errors and document/collaboration formats remain the 0.4.3 contract; no new public subpath is assumed. This is a locked host patch, not an upstream npm release.

When maintaining a patch, update both module entries with `pnpm patch` / `pnpm patch-commit`, retain the exact installed version boundary, and review the regenerated diff. No stored document formats, compatibility adapters or migrations are added here.

Validation: `tests/document-pdf.test.ts` verifies real DOCX XML and reimport; `node --import tsx scripts/qa-document-pdf.mts` verifies math positioning and visual PDF export in isolated browser documents. See `docs/editor-file-exchange-contract.md` for host boundaries and remaining fidelity limits.
