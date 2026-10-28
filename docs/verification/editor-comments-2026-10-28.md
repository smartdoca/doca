# Comment backgrounds — 2026-10-28

Doca 0.2.23 was checked against the installed official npm releases: Slate 0.4.26, Markdown 0.4.4, Canvas 0.5.16, Sheet 0.2.14 and Slides 0.3.0-alpha.5. The lockfile and editor-source guard require registry versions; no local archive dependency or editor patch is used.

The compiled website was exercised through MCP browser control using an isolated in-memory database, synthetic documents and local test storage. Each format contained two comments on different content. Opening the sidebar did not add a background. Clicking the first comment highlighted only its content; clicking the second replaced that background. Clicking document content, clicking sidebar blank space, closing and reopening the sidebar all left no comment background. Clicking the already active card again restored its background after clearing. All five formats also supported selecting and clearing a comment background in reading mode. Markdown source and preview decorations cleared together.

Canvas decoration IDs, rich-text range geometry, Markdown comment IDs and Slides element geometry were inspected in the rendered DOM. Sheet paints in its native canvas: screenshots showed the requested cell range, and pixel checks distinguished the filled range from the remaining comment borders. Raw screenshots and run reports are retained under ignored `artifacts/verification/release-20261028/comment-highlight/`.

The reusable isolated fixture is `scripts/qa-issue-record-fixture.mts`. It compares document sequence numbers and checkpoints throughout browser verification. Comment clicks, navigation and reading mode preserved those values. All five documents were then held open together for 73 seconds with unchanged sequence 0 and byte-identical checkpoints, and no browser errors. This check does not claim new concurrent editing or schema-upgrade coverage.

Host validation passed: TypeScript, the three production builds, npm editor-source validation, documentation link validation, and the full test suite (3449 passed, 11 skipped). `tests/comment-highlight.test.ts` covers explicit selection, switching, capture-phase outside clicks despite stopped bubbling, closing/reopening and resolution. No production document was edited or deployment performed during these browser checks.

Only runtime view state changed. Permanent anchors, document styles, schemas/codecs, epochs, checkpoints, ACK identities and historical readers retain their existing behavior. Canvas AI reference navigation remains separate from comment background activation.
