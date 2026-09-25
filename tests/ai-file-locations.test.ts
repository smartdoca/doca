import { expect, it } from "vitest";
import { defaultOfficialSkills } from "../packages/core/src/modules/ai/skills.js";
import {
  describeFileCopy,
  folderDisplayPath,
  describeDroppedExplorerItems,
  fileExplorerHref,
  folderExplorerHref,
  folderRecordParentId,
  interpretFileParent,
  isCopyOnlyParent,
  isPersonalRootFolderParent,
  isRootFolderQuery,
  normalizeFolderParentId,
  parseFolderId,
  preferDisplayLocation,
  preferFileCopyId,
  requireUuid,
  systemFolders,
} from "../apps/server/src/services/ai/file-locations.js";

it("maps folder ids to the files tree", () => {
  expect(parseFolderId(undefined)).toEqual({ type: "system", id: "root" });
  expect(parseFolderId("我的文件夹")).toEqual({ type: "system", id: "root" });
  expect(parseFolderId("ai")).toEqual({ type: "system", id: "ai" });
  expect(parseFolderId("AI 助手")).toEqual({ type: "system", id: "ai" });
  expect(parseFolderId("shared")).toEqual({ type: "system", id: "shared" });
  expect(parseFolderId("系统文档")).toEqual({ type: "system", id: "documents" });
  const folderId = "442983f3-7b1a-4c2d-9e0f-1234567890ab";
  expect(parseFolderId(folderId)).toEqual({ type: "folder", id: folderId });
  expect(interpretFileParent("system", "root")).toEqual({
    type: "system",
    id: "root",
  });
  expect(interpretFileParent("folder", "我的文件夹")).toEqual({
    type: "system",
    id: "root",
  });
  expect(interpretFileParent("system", folderId)).toEqual({
    type: "folder",
    id: folderId,
  });
  expect(folderRecordParentId({ type: "system", id: "root" })).toBeNull();
  expect(folderRecordParentId({ type: "folder", id: folderId })).toBe(folderId);
  expect(() => folderRecordParentId({ type: "system", id: "ai" })).toThrow(
    /不能在「AI 助手」下/,
  );
  expect(isPersonalRootFolderParent(null)).toBe(true);
  expect(isPersonalRootFolderParent("root")).toBe(true);
  expect(normalizeFolderParentId("root")).toBeNull();
  expect(folderDisplayPath(["猫猫"])).toBe("我的文件夹 / 猫猫");
  expect(folderDisplayPath(["项目"], true)).toBe(
    "我的文件夹 / 共享文件夹 / 项目",
  );
  expect(
    preferDisplayLocation([
      { parentType: "system", parentId: "root", inMyFilesRoot: true },
      { parentType: "folder", parentId: folderId, inMyFilesRoot: false },
    ]),
  ).toMatchObject({ parentType: "folder" });
  expect(() => parseFolderId(folderId.slice(0, 8))).toThrow(/完整文件夹/);
  expect(() => requireUuid(folderId.slice(0, 8), "文件")).toThrow(/完整 UUID/);
  expect(requireUuid(folderId, "文件")).toBe(folderId);
});

it("describes the system folders and file tools", () => {
  expect(systemFolders.map((folder) => folder.id)).toEqual([
    "root",
    "ai",
    "shared",
    "documents",
  ]);
  expect(systemFolders.find((folder) => folder.id === "ai")).toMatchObject({
    parentId: "root",
    path: "我的文件夹 / AI 助手",
    writable: false,
    copyOnly: true,
  });
  expect(describeFileCopy("system", "ai")).toMatchObject({
    path: "我的文件夹 / AI 助手",
    inMyFilesRoot: false,
    copyOnly: true,
  });
  expect(describeFileCopy("system", "root")).toMatchObject({
    path: "我的文件夹",
    inMyFilesRoot: true,
  });
  expect(isRootFolderQuery("文件夹")).toBe(true);
  expect(isRootFolderQuery("猫猫图片")).toBe(false);
  expect(
    preferFileCopyId([
      { fileId: "doc-copy", parentType: "document" },
      { fileId: "ai-copy", parentType: "system" },
    ]),
  ).toBe("ai-copy");
  const files = defaultOfficialSkills.find((skill) => skill.id === "files");
  expect(files?.content).toContain("id=ai");
  expect(files?.content).toContain("id=root");
  expect(files?.content).toContain("AI 生成的图片在这里");
  expect(files?.content).toContain("fileIds");
  expect(files?.content).toContain("只能 copy");
  expect(files?.content).toContain("审批卡");
  expect(files?.content).toContain("rename 必须同时给 folderId");
  expect(files?.content).not.toContain("直接执行");
  expect(files?.content).not.toContain("parent_id 是 null");
  expect(
    defaultOfficialSkills.find((skill) => skill.id === "spreadsheet")?.content,
  ).toContain("写工作表名 Sheet1 也可以");
});

it("keeps AI assistant and document folders copy-only and routes shared folders separately", () => {
  expect(isCopyOnlyParent("system", "ai")).toBe(true);
  expect(isCopyOnlyParent("system", "documents")).toBe(true);
  expect(isCopyOnlyParent("system", "root")).toBe(false);
  expect(isCopyOnlyParent("folder", "442983f3-7b1a-4c2d-9e0f-1234567890ab")).toBe(
    false,
  );
  const folderId = "442983f3-7b1a-4c2d-9e0f-1234567890ab";
  expect(
    folderExplorerHref({
      navigation: [
        { type: "system", id: "root", name: "我的文件夹" },
        { type: "folder", id: folderId, name: "猫猫" },
      ],
    }),
  ).toBe(
    `/files?path=${encodeURIComponent(JSON.stringify([{ type: "system", id: "root", name: "我的文件夹" }, { type: "folder", id: folderId, name: "猫猫" }]))}`,
  );
  const sharedId = "b2c9d4e5-6f70-4819-a0b1-c2d3e4f50617";
  expect(
    folderExplorerHref({
      sharedRoot: { id: sharedId, name: "设计资料" },
      navigation: [{ type: "folder", id: sharedId, name: "设计资料" }],
    }),
  ).toBe(`/shared-files/${sharedId}?name=${encodeURIComponent("设计资料")}`);
  const folderHref = folderExplorerHref({
    navigation: [
      { type: "system", id: "root", name: "我的文件夹" },
      { type: "folder", id: folderId, name: "猫猫" },
    ],
  });
  expect(fileExplorerHref(folderHref, "file-1")).toBe(`${folderHref}&focus=file-1`);
  expect(
    describeDroppedExplorerItems([
      {
        kind: "file",
        id: "file-1",
        name: "说明.webp",
        path: "我的文件夹 / 猫猫 / 说明.webp",
        mime: "image/webp",
      },
      {
        kind: "folder",
        id: folderId,
        name: "猫猫",
        path: "我的文件夹 / 猫猫",
      },
    ]),
  ).toContain("可以直接查看");
  expect(
    describeDroppedExplorerItems([
      {
        kind: "folder",
        id: folderId,
        name: "猫猫",
        path: "我的文件夹 / 猫猫",
      },
    ]),
  ).toContain("没有发送其中的文件或图片");
});
