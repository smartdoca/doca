# Editor package upgrade record — 2026-10-14

[简体中文](pending-editor-package-upgrade.zh-CN.md)

Historical record: these changes shipped in [0.1.25](0.1.25.md), whose final spreadsheet version is 0.2.2. The current package matrix is in [editor integration](../editor-integration.md); the 18/72 defaults below were superseded by the separately approved [21.78/87.12 defaults](../editor-integration.md#spreadsheet-dimensions-and-personal-zoom--2026-10-23). The original package and verification details below apply to the 2026-10-14 candidate.

At that time, the source checkout pinned `@smartdoca/slate` 0.4.15 and `@smartdoca/sheet` 0.2.1. Slate adds native node rotation and first-click image selection followed by second-click preview. AI edits validate finite numeric angles and preserve rotation when changing node styles. The existing DOCX style patch applies to the new artifact. Spreadsheet adds its native accessible select-all corner and normalizes full-sheet selection before statistics subscribers receive it.

The user approved the package's default 18 px row height and 72 px column width for CRDT-added worksheets, including worksheets added before this upgrade, and virtual empty recovery sheets. New host worksheets use the same dimensions. Immutable baseline worksheets retain original size fields, including omission; explicit per-axis sizes are preserved. This changes projection defaults without rewriting seeds, original Yjs bytes, baselines, epochs, comments or pending updates. Spreadsheet schema 6 and rich-text schema 3 remain unchanged; unknown schemas still fail exact negotiation. Existing recovery/history readers are unchanged.

The prior decision to make no old-flowchart compatibility promise remains in effect. No old-node adapter, automatic conversion, migration or data reset is added. Update server and Web together. Retain the previous package artifacts, version pins, patch and lockfile for package rollback; previous editors may ignore rotation or display different default sizes. Database rollback follows the separately approved host storage procedure.

The immutable `tests/fixtures/editor-upgrade/sheet-rc19.json` was generated with the actual unmodified rc.19 registry artifact. Package hashes, automated checks and isolated browser evidence are recorded in `docs/verification/editor-package-upgrade-2026-10-14/report.json`. This original candidate record does not establish deployment or acceptance of every spreadsheet operation, every diagram gesture, external AI services or native devices.
