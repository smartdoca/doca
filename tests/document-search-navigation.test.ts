import { afterEach, describe, expect, it, vi } from "vitest";
import {
  documentSearchQuery,
  openSearchDocument,
  searchDocumentHash,
} from "../apps/web/src/features/search/document-search-navigation.js";

const document = {
  id: "11111111-1111-1111-1111-111111111111",
  kind: "document",
};
afterEach(() => vi.unstubAllGlobals());

describe("document search navigation", () => {
  it("roundtrips literal Chinese and URL-significant characters without changing the resource path", () => {
    const query = "中文 + & # ? / % = 📝";
    const hash = searchDocumentHash(document, ` ${query} `);
    expect(hash.split("?")[0]).toBe(`#/r/${document.id}`);
    expect(documentSearchQuery(hash, document.id)).toBe(query);
  });

  it("does not carry a find request for recent results or non-document resources", () => {
    expect(searchDocumentHash(document, "   ")).toBe(`#/r/${document.id}`);
    expect(searchDocumentHash({ ...document, kind: "library" }, "关键字")).toBe(
      `#/r/${document.id}`,
    );
    expect(documentSearchQuery(`#/r/${document.id}`, document.id)).toBeNull();
  });

  it("isolates the request to the destination document, including the mobile web route", () => {
    const hash = searchDocumentHash(document, "关键字");
    expect(documentSearchQuery(hash, "another-document")).toBeNull();
    expect(
      documentSearchQuery(hash.replace("#/r/", "#/m/r/"), document.id),
    ).toBe("关键字");
    expect(
      documentSearchQuery(`#/u/${document.id}?find=关键字`, document.id),
    ).toBeNull();
    expect(
      documentSearchQuery(`#/r/${document.id}?comment=x&find=`, document.id),
    ).toBeNull();
  });

  it("reopens find when the same result is selected after closing its panel", () => {
    const hash = searchDocumentHash(document, "关键字");
    const dispatchEvent = vi.fn();
    vi.stubGlobal("window", { location: { hash }, dispatchEvent });
    vi.stubGlobal(
      "HashChangeEvent",
      class {
        constructor(public type: string) {}
      },
    );
    openSearchDocument(document, "关键字");
    expect(dispatchEvent).toHaveBeenCalledOnce();
    expect(dispatchEvent.mock.calls[0]?.[0].type).toBe("hashchange");
    openSearchDocument(document, "另一个关键字");
    expect(window.location.hash).toBe(
      searchDocumentHash(document, "另一个关键字"),
    );
    expect(dispatchEvent).toHaveBeenCalledOnce();
  });
});
