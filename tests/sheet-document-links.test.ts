import { expect, it, vi } from "vitest";
import type { SpreadsheetNativeText } from "@online-office/univer-sheet";
import { insertSheetDocumentLink } from "../apps/web/src/features/documents/sheet-document-links.js";

const id = "95c67111-d90b-48df-9502-581a858b51d4";
const url = `http://127.0.0.1:39130/#/r/${id}`;
const target = { token: "retained-draft" };
const fixture = () => {
  const insert = vi.fn(() => true),
    release = vi.fn();
  return {
    insert,
    release,
    native: { insert, release } as unknown as SpreadsheetNativeText,
  };
};
it("inserts a relative document identity using the retained native inline target", async () => {
  const f = fixture();
  await insertSheetDocumentLink(
    f.native,
    target,
    id,
    url,
    async () => ({ resource: { kind: "document", title: "链接标题" } as any }),
    () => true,
  );
  expect(f.insert).toHaveBeenCalledWith(target, {
    kind: "atomic",
    node: { type: "document", refId: id, label: "链接标题" },
  });
  expect(f.release).toHaveBeenCalledWith(target);
});
it("does not insert after readonly/disposal and releases the draft token", async () => {
  const f = fixture();
  await insertSheetDocumentLink(
    f.native,
    target,
    id,
    url,
    async () => ({ resource: { kind: "document", title: "标题" } as any }),
    () => false,
  );
  expect(f.insert).not.toHaveBeenCalled();
  expect(f.release).toHaveBeenCalledWith(target);
});
it("preserves the original pasted URL if the title is inaccessible", async () => {
  const f = fixture();
  await expect(
    insertSheetDocumentLink(
      f.native,
      target,
      id,
      url,
      async () => {
        throw Error("文档不存在");
      },
      () => true,
    ),
  ).rejects.toThrow("文档不存在");
  expect(f.insert).toHaveBeenCalledWith(target, {
    kind: "link",
    text: url,
    href: url,
  });
  expect(f.release).toHaveBeenCalledWith(target);
});
it("does not retry a stale target in the new selection", async () => {
  const f = fixture();
  f.insert.mockImplementation(() => {
    throw Error("STALE_TEXT_TARGET");
  });
  await expect(
    insertSheetDocumentLink(
      f.native,
      target,
      id,
      url,
      async () => ({ resource: { kind: "document", title: "标题" } as any }),
      () => true,
    ),
  ).rejects.toThrow("STALE_TEXT_TARGET");
  expect(f.insert).toHaveBeenCalledTimes(1);
  expect(f.release).toHaveBeenCalledWith(target);
});
