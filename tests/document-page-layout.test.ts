import { describe, expect, it } from "vitest";
import {
  documentPageLayout,
  parseDocumentPageWidth,
} from "../apps/web/src/features/documents/document-page-layout.js";

describe("document paper width layout", () => {
  it("defaults to A4 and rejects obsolete preferences", () => {
    expect(parseDocumentPageWidth(null)).toBe("a4");
    expect(parseDocumentPageWidth("legacy")).toBe("a4");
    expect(parseDocumentPageWidth("a3")).toBe("a3");
    expect(parseDocumentPageWidth("fluid")).toBe("fluid");
  });
  it.each([
    ["a4", 794],
    ["a3", 1123],
  ] as const)("keeps %s paper width while panels collapse", (mode, paper) => {
    expect(documentPageLayout(paper + 552, mode, true)).toEqual({
      paper,
      commentsInline: true,
      outlineInline: true,
    });
    expect(documentPageLayout(paper + 400, mode, true)).toEqual({
      paper,
      commentsInline: false,
      outlineInline: true,
    });
    expect(documentPageLayout(paper + 100, mode, true)).toEqual({
      paper,
      commentsInline: false,
      outlineInline: false,
    });
    expect(documentPageLayout(400, mode, true).paper).toBe(paper);
  });
  it("can use space released by an explicitly collapsed outline", () => {
    expect(documentPageLayout(1150, "a4", false).commentsInline).toBe(true);
    expect(documentPageLayout(1150, "a4", true).commentsInline).toBe(false);
    expect(documentPageLayout(1150, "a4", true).outlineInline).toBe(true);
  });
  it("restores panels when AI closes without changing the width preference", () => {
    const wide = documentPageLayout(1700, "a3", true);
    expect(wide.outlineInline).toBe(true);
    expect(documentPageLayout(1340, "a3", true).commentsInline).toBe(false);
    expect(documentPageLayout(1700, "a3", true)).toEqual(wide);
  });
  it("retains adaptive breakpoints without imposing a paper width", () => {
    expect(documentPageLayout(1600, "fluid", true)).toEqual({
      paper: 0,
      commentsInline: true,
      outlineInline: true,
    });
    expect(documentPageLayout(900, "fluid", true)).toEqual({
      paper: 0,
      commentsInline: false,
      outlineInline: true,
    });
    expect(documentPageLayout(700, "fluid", true)).toEqual({
      paper: 0,
      commentsInline: false,
      outlineInline: false,
    });
  });
});
