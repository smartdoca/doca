import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { FileIcon } from "../apps/web/src/features/documents/document-controls.js";

it("uses the board icon for canvas documents, not the generic document icon", () => {
  const html = renderToStaticMarkup(createElement(FileIcon, {
    r: { kind: "document", format: "canvas" },
  }));
  expect(html).toContain("file-glyph canvas");
  expect(html).toContain("lucide-square-pen");
  expect(html).not.toContain("lucide-file-text");
});

it.each([
  ["rich_text", "file-text"], ["markdown", "file-code"],
  ["spreadsheet", "table"], ["presentation", "presentation"],
] as const)("preserves the %s list icon", (format, icon) => {
  const html = renderToStaticMarkup(createElement(FileIcon, {
    r: { kind: "document", format },
  }));
  expect(html).toContain(`lucide-${icon}`);
  expect(html).toContain(`file-glyph ${format}`);
  expect(html).toContain('aria-hidden="true"');
  expect(html).toContain('width="19"');
  expect(html).toContain('height="19"');
});

it("distinguishes Markdown from rich text even in compact monochrome trees", () => {
  const render = (format: "markdown" | "rich_text") => renderToStaticMarkup(createElement(FileIcon, {
    r: { kind: "document", format }, size: "compact",
  }));
  expect(render("markdown")).toContain("lucide-file-code");
  expect(render("markdown")).not.toContain("lucide-file-text");
  expect(render("rich_text")).toContain("lucide-file-text");
});

it("uses the same library badge regardless of the resource format", () => {
  const html = renderToStaticMarkup(createElement(FileIcon, {
    r: { kind: "library", format: "rich_text" },
  }));
  expect(html).toContain("file-glyph library");
  expect(html).toContain("lucide-book-open");
  expect(html).not.toContain("lucide-file-text");
});

it.each(["rich_text", "spreadsheet", "markdown", "canvas", "presentation"] as const)(
  "uses a compact %s badge in trees without changing its document type",
  (format) => {
    const html = renderToStaticMarkup(createElement(FileIcon, {
      r: { kind: "document", format }, size: "compact",
    }));
    expect(html).toContain(`file-glyph ${format} compact`);
    expect(html).toContain('width="15"');
    expect(html).toContain('height="15"');
  },
);
