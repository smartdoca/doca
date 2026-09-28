import { expect, it, vi } from "vitest";
import { scrollBoundary, scrollDocumentBoundary } from "../apps/web/src/features/documents/document-scroll.js";

it("clamps short documents and supports fractional scroll extents", () => {
  expect(scrollBoundary("top", 9000, 500)).toBe(0);
  expect(scrollBoundary("bottom", 200, 500)).toBe(0);
  expect(scrollBoundary("bottom", 900.5, 500)).toBe(400.5);
});
it.each(["top", "bottom"] as const)("moves visible Markdown columns and the outer document to %s", (edge) => {
  const pane = (visible = true) => ({ scrollTop: 120, scrollHeight: 2400, clientHeight: 600, getBoundingClientRect: () => ({ width: visible ? 400 : 0, height: visible ? 600 : 0 }) });
  const source = pane(), preview = pane(), hidden = pane(false);
  const outer = { scrollHeight: 1100, clientHeight: 700, querySelector: (selector: string) => selector === ".markdown-sdk-container" ? {} : null, querySelectorAll: () => [source, preview, hidden], scrollTo: vi.fn() };
  const root = { querySelector: () => outer } as unknown as HTMLElement;
  scrollDocumentBoundary(root, edge, "instant");
  expect(source.scrollTop).toBe(edge === "top" ? 0 : 1800);
  expect(preview.scrollTop).toBe(source.scrollTop);
  expect(hidden.scrollTop).toBe(120);
  expect(outer.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "instant" });
});
it("stops at the rich-text body, excluding longer comment rails and discussion", () => {
  const scrollTo = vi.fn();
  const content = { getBoundingClientRect: () => ({ bottom: 1800 }) };
  const outer = { scrollHeight: 9000, clientHeight: 600, scrollTop: 300, clientTop: 0, getBoundingClientRect: () => ({ top: 100 }), querySelector: (selector: string) => selector === ".markdown-sdk-container" ? null : content, querySelectorAll: () => [], scrollTo };
  scrollDocumentBoundary({ querySelector: () => outer } as unknown as HTMLElement, "bottom");
  expect(scrollTo).toHaveBeenCalledWith({ top: 1400, behavior: "smooth" });
  // Even when already looking at discussion, return to the same body boundary.
  outer.scrollTop = 1900;
  content.getBoundingClientRect = () => ({ bottom: 200 });
  scrollDocumentBoundary({ querySelector: () => outer } as unknown as HTMLElement, "bottom");
  expect(scrollTo).toHaveBeenLastCalledWith({ top: 1400, behavior: "smooth" });
  expect(() => scrollDocumentBoundary({ querySelector: () => null } as unknown as HTMLElement, "top")).not.toThrow();
});
