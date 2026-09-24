import { expect, it } from "vitest";
import {
  beginInternalFileDrag,
  dataTransferTypes,
  endInternalFileDrag,
  FILE_DRAG_TEXT_PREFIX,
  FILE_DRAG_TYPE,
  findNameConflicts,
  idsInMarquee,
  isExternalFileDrag,
  isInternalFileDrag,
  nextAvailableName,
  orderedRange,
  parseFileDragItems,
  replaceColumnPage,
  reusedColumnPrefix,
  sameTrail,
  serializeFileDrag,
  toggleSelectedId,
  trailAfterRemovedFolders,
} from "@web/features/files/file-interactions.js";

it("parses internal file drag payloads and ignores unrelated text", () => {
  const raw = serializeFileDrag([{ kind: "file", id: "a", version: 1 }, { kind: "folder", id: "b", version: 2 }]);
  expect(parseFileDragItems(raw)).toEqual([
    { kind: "file", id: "a", version: 1 },
    { kind: "folder", id: "b", version: 2 },
  ]);
  expect(parseFileDragItems(FILE_DRAG_TEXT_PREFIX + raw)?.[0]?.id).toBe("a");
  expect(parseFileDragItems("hello")).toBeNull();
  expect(parseFileDragItems('[{"kind":"note","id":"x"}]')).toBeNull();
});

it("does not treat an in-app file drag as an external upload", () => {
  beginInternalFileDrag([{ kind: "folder", id: "folder-1", version: 1 }]);
  expect(isInternalFileDrag({ types: ["Files", "text/plain"] })).toBe(true);
  expect(isExternalFileDrag({ types: ["Files"] })).toBe(false);
  endInternalFileDrag();
  expect(isExternalFileDrag({ types: ["Files"] })).toBe(true);
  expect(isInternalFileDrag({ types: [FILE_DRAG_TYPE] })).toBe(true);
  expect(dataTransferTypes({ types: ["text/plain", "Files"] })).toEqual(["text/plain", "Files"]);
});

it("selects intersecting entries for marquee and range shortcuts", () => {
  expect(idsInMarquee(
    { left: 10, top: 10, right: 80, bottom: 80 },
    [
      { id: "in", rect: { left: 20, top: 20, right: 40, bottom: 40 } },
      { id: "out", rect: { left: 120, top: 120, right: 140, bottom: 140 } },
    ],
  )).toEqual(["in"]);
  expect(orderedRange(["a", "b", "c", "d"], "b", "d")).toEqual(["b", "c", "d"]);
  expect(orderedRange(["a", "b", "c"], "c", "a")).toEqual(["a", "b", "c"]);
  expect([...toggleSelectedId(["a"], "b")].sort()).toEqual(["a", "b"]);
  expect([...toggleSelectedId(["a", "b"], "a")]).toEqual(["b"]);
});

it("assigns incrementing names when a copy would collide", () => {
  expect(nextAvailableName("新建文件夹", ["新建文件夹"], "folder")).toBe("新建文件夹 2");
  expect(nextAvailableName("新建文件夹", ["新建文件夹", "新建文件夹 2"], "folder")).toBe("新建文件夹 3");
  expect(nextAvailableName("新建文件夹 2", ["新建文件夹", "新建文件夹 2"], "folder")).toBe("新建文件夹 3");
  expect(nextAvailableName("说明.txt", ["说明.txt"], "file")).toBe("说明 2.txt");
  expect(nextAvailableName("说明.txt", ["说明.txt", "说明 2.txt"], "file")).toBe("说明 3.txt");
});

it("treats a same-folder copy as a name conflict and ignores a no-op move onto itself", () => {
  const folder = { kind: "folder" as const, id: "a", name: "资料", version: 1 };
  expect(findNameConflicts([folder], [folder], true)).toHaveLength(1);
  expect(findNameConflicts([folder], [folder], false)).toHaveLength(0);
  expect(findNameConflicts(
    [{ ...folder, id: "src" }],
    [{ ...folder, id: "dest" }],
    false,
  )).toHaveLength(1);
});

it("leaves column-view navigation before a trashed open folder", () => {
  const trail = [{ id: "root" }, { id: "cats" }, { id: "cats-2" }];
  expect(trailAfterRemovedFolders(trail, ["cats-2"])).toEqual({
    kind: "parent",
    trail: [{ id: "root" }, { id: "cats" }],
  });
  expect(trailAfterRemovedFolders(trail, ["cats"])).toEqual({
    kind: "parent",
    trail: [{ id: "root" }],
  });
  expect(trailAfterRemovedFolders(trail, ["other"])).toEqual({ kind: "unchanged" });
  expect(trailAfterRemovedFolders(trail, ["root"])).toEqual({ kind: "leave-root" });
});

it("reuses matching column prefix instead of refetching parent columns", () => {
  const documents = { type: "system", id: "documents" };
  const personal = { type: "system", id: "documents-personal" };
  const doc = { type: "document", id: "doc-1" };
  const columns = [
    { location: documents, page: 1 },
    { location: personal, page: 2 },
    { location: doc, page: 3 },
  ];
  expect(reusedColumnPrefix([documents, personal, doc], columns)).toEqual(columns);
  expect(reusedColumnPrefix([documents, { type: "system", id: "documents-shared" }], columns)).toEqual([columns[0]]);
  expect(replaceColumnPage(columns, doc, 9)[2]).toEqual({ location: doc, page: 9 });
  expect(sameTrail([documents, personal], [documents, personal])).toBe(true);
  expect(sameTrail([documents, personal], [documents, doc])).toBe(false);
});
