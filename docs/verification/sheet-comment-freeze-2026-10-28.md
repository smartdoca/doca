# Spreadsheet comment navigation with frozen panes

Verified against the installed `@smartdoca/sheet` 0.2.14 and the current Doca website on 2026-10-28, using disposable SQLite documents and Chrome. No user documents or deployment were used.

The native comment reveal delegates to `scrollToCell`, which subtracts the frozen row/column counts from physical indices. Hidden axes or unequal dimensions can make that scroll origin overlap the frozen pane. The reproducible first-row case hides rows 59 and 60 and navigates to a comment on row 61: the original path places the target at the same screen position as row 1, underneath it.

The host now follows the existing native anchor resolution and worksheet activation with the current public `executeCommand("sheet.command.scroll-view", ...)` API. It uses the target indices and the negative pixel dimensions of the visible frozen rows/columns. Hidden/filtered axes contribute no size; zoom remains native. This changes only scrolling. The installed package, anchor formats, stored content, selection, schema, collaboration transport and history are unchanged. Existing historical anchor readers remain in their established paths and are not extended.

Verification:

- The original native path fails the hidden-row assertion; its screenshot visibly hides row 61 beneath frozen row 1.
- Both the development website and the final production build pass nine cases: frozen first row, multiple frozen rows/columns, a target inside the frozen area, no freeze, 150% and 50% zoom, hidden preceding rows, hidden preceding columns, and unequal row heights/column widths.
- Each case checks the target against the frozen pane boundary, unchanged cell selection, zero outgoing content updates, and unchanged persisted sequence/checkpoint. Screenshots were inspected for the hidden-row and unequal-dimension cases, including the final production build.
- A 60-second idle observation after navigation produces no content updates or persisted sequence/checkpoint changes.
- `pnpm typecheck`, the five tests in `tests/region-comment-interaction.test.ts` and `tests/comment-highlight.test.ts`, and `pnpm build` pass.

Reusable verification: `pnpm exec tsx scripts/qa-sheet-comment-freeze.mts`. Set `DOCA_QA_BUILT_WEB=1` after building to test the production bundle. `DOCA_QA_REPRO=1 DOCA_QA_CASES=hidden-rows` restores only the original reveal call in the development test transform and is expected to fail. The script uses the mounted public SDK handle for observations; production verification obtains the actual host ref without modifying the bundle.

Raw screenshots, reports and logs are under `artifacts/verification/sheet-comment-freeze/`, `sheet-comment-freeze-built/`, and `sheet-comment-freeze-red/`, with corresponding `.log` files under `artifacts/verification/`. These are ignored verification output. This is isolated website acceptance, not a production deployment or a claim about unrelated spreadsheet operations.
