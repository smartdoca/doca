# README editor screenshots

The five editor images were captured on 2026-10-17 from Doca 0.1.31 in Chrome at 1600 × 1000. Both repository READMEs use these same images.

| Image | Actual editor content |
| --- | --- |
| `rich-text.jpg` | Team collaboration guide and document outline |
| `markdown.jpg` | Development note in source/preview split view |
| `spreadsheet.jpg` | Formatted project budget with totals and formulas |
| `slides.jpg` | Product introduction with four native slides |
| `canvas.jpg` | Native flowchart, mind map, and action table |

The installed packages are Slate 0.4.22, Markdown 0.4.3, Sheet 0.2.3, Slides 0.3.0-alpha.3, and Canvas 0.5.2. The separate `workspace.jpg` overview predates this editor refresh.

To reproduce, install the locked dependencies and Google Chrome, then run from the repository root:

```sh
pnpm exec tsx scripts/capture-readme-screenshots.mts
```

The script creates a temporary account, in-memory SQLite database, local file store, and five synthetic documents. It captures the actual browser UI without injected styles or image compositing, checks for browser errors, and closes the app and removes temporary data when finished. It does not access production documents or call an AI provider.

Review the PNGs in `artifacts/readme-screenshots/`, then copy the five matching JPEGs into this directory. `report.json` records the app/package versions and capture details. Optional environment variables: `DOCA_SCREENSHOT_OUTPUT` and `DOCA_SCREENSHOT_PORT` (default 39481).
