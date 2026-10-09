import { expect, it } from "vitest";
import {
  answerSegments,
  aiSessionFolderHref,
  folderExplorerHash,
  navigationHref,
  resolveExplorerClick,
  isFolderExplorerHref,
  keepsAssistantSession,
  withSessionHash,
} from "../apps/web/src/features/ai/ai-folder-mentions.js";

const folder = {
  id: "20117e32-13ad-4c3f-87ec-0541eb39fc97",
  name: "无敌猫猫",
  path: "我的文件夹 / 无敌猫猫",
  href: "/files?path=%5B%7B%22id%22%3A%22root%22%7D%5D",
  shared: false,
};

it("opens the current conversation folder and keeps its session across navigation", () => {
  const session = {
    id: "20117e32-13ad-4c3f-87ec-0541eb39fc97",
    title: '设计 / 图片? #历史 & "版本1".png',
  };
  const href = aiSessionFolderHref(session, "AI 助手");
  const url = new URL(href, "http://localhost");
  expect(url.pathname).toBe("/files");
  expect(url.searchParams.get("session")).toBe(session.id);
  expect(JSON.parse(url.searchParams.get("path")!)).toEqual([
    { type: "system", id: "ai", name: "AI 助手" },
    { type: "system", id: `ai-session:${session.id}`, name: session.title },
  ]);
  expect(navigationHref(href)).toBe(true);
  expect(keepsAssistantSession(href)).toBe(true);
});

it("turns a fenced folder path in the final answer into a card segment", () => {
  const segments = answerSegments(
    "✅ 已确认：文件夹名为 **无敌猫猫**\n\n📁 `我的文件夹 / 无敌猫猫`\n\n改名操作已通过审批并生效",
    [folder],
  );
  expect(segments.map((s) => s.type)).toEqual(["text", "folder", "text"]);
  expect(segments[0]).toMatchObject({
    type: "text",
    text: expect.stringContaining("已确认"),
  });
  expect(segments[1]).toMatchObject({ type: "folder", folder });
  expect(segments[2]).toMatchObject({
    type: "text",
    text: expect.stringContaining("改名操作已通过审批"),
  });
});

it("turns markdown folder links into card segments", () => {
  const segments = answerSegments(
    `请打开 [我的文件夹 / 无敌猫猫](${folderExplorerHash(folder.href)})`,
    [folder],
  );
  expect(segments).toEqual([
    { type: "text", text: "请打开 " },
    { type: "folder", folder },
  ]);
});

it("turns a bold folder path in the final answer into a card segment", () => {
  const renamed = {
    ...folder,
    name: "超级无敌猫猫",
    path: "我的文件夹 / 超级无敌猫猫",
  };
  const segments = answerSegments(
    "✅ 改名完成！\n\n📁 **我的文件夹 / 超级无敌猫猫**\n\n名字又升级了",
    [renamed],
  );
  expect(segments.map((s) => s.type)).toEqual(["text", "folder", "text"]);
  expect(segments[1]).toMatchObject({ type: "folder", folder: renamed });
  expect(segments[2]).toMatchObject({
    type: "text",
    text: expect.stringContaining("名字又升级了"),
  });
});

it("still inserts a folder card when the answer never mentions the path", () => {
  const segments = answerSegments("改名完成！", [folder], {
    ensureCards: true,
  });
  expect(segments.map((s) => s.type)).toEqual(["text", "folder"]);
});

it("does not treat a folder name mention as a card", () => {
  expect(
    answerSegments("已确认：文件夹名为 **无敌猫猫**", [folder]),
  ).toEqual([{ type: "text", text: "已确认：文件夹名为 **无敌猫猫**" }]);
});

it("turns a delivered file path into a file card", () => {
  const file = {
    id: "file-1",
    name: "说明.webp",
    path: "我的文件夹 / 猫猫 / 说明.webp",
    href: "/files?path=%5B%5D&focus=file-1",
    downloadUrl: "/api/v1/files/items/file-1/content?download=1",
  };
  const segments = answerSegments("📄 `我的文件夹 / 猫猫 / 说明.webp`", [], {
    files: [file],
  });
  expect(segments.map((item) => item.type)).toEqual(["file"]);
  expect(segments[0]).toMatchObject({ type: "file", file });
});

it("appends unused file cards when ensureCards is on", () => {
  const file = {
    id: "file-2",
    name: "合同.pdf",
    path: "我的文件夹 / 合同.pdf",
    href: "/files?path=%5B%5D&focus=file-2",
    downloadUrl: "/api/v1/files/items/file-2/content?download=1",
  };
  const segments = answerSegments("文件已就绪。", [], {
    files: [file],
    ensureCards: true,
  });
  expect(segments).toEqual([
    { type: "text", text: "文件已就绪。" },
    { type: "file", file },
  ]);
});

it("replaces a handwritten file link with the delivered card", () => {
  const file = {
    id: "file-3",
    name: "武汉大学品牌声誉深度分析报告.pdf",
    path: "我的文件夹 / 武汉大学品牌声誉深度分析报告.pdf",
    href: "/files?path=%5B%7B%22type%22%3A%22system%22%2C%22id%22%3A%22root%22%7D%5D&focus=file-3",
    downloadUrl: "/api/v1/files/items/file-3/content?download=1",
  };
  const segments = answerSegments(
    "您可以点击下方卡片访问该文件：[武汉大学品牌声誉深度分析报告.pdf](#/files?path=我的文件夹)",
    [],
    { files: [file] },
  );
  expect(segments.map((item) => item.type)).toEqual(["text", "file"]);
  expect(segments[1]).toMatchObject({ type: "file", file });
  expect(navigationHref("#/files?path=我的文件夹")).toBe(false);
  expect(navigationHref(file.href)).toBe(true);
  expect(
    resolveExplorerClick("#/files?path=我的文件夹", [file], file.name),
  ).toBe(file.href);
  expect(resolveExplorerClick("#/files?path=我的文件夹", [])).toBe("");
});

it("turns a handwritten download link into the delivered file card", () => {
  const file = {
    id: "file-4",
    name: "GitHub 平台调研报告.docx",
    path: "我的文件夹 / GitHub 平台调研报告.docx",
    href: "/files?path=%5B%5D&focus=file-4",
    downloadUrl: "/api/v1/files/items/file-4/content?download=1",
  };
  const segments = answerSegments(
    "调研报告已生成。\n\n[点击下载报告](https://example.invalid/report.docx)",
    [],
    { files: [file], ensureCards: true },
  );
  expect(segments.filter((item) => item.type === "file")).toEqual([
    { type: "file", file },
  ]);
});

it("recognizes personal and shared folder explorer hrefs", () => {
  expect(isFolderExplorerHref("/files?path=%5B%5D")).toBe(true);
  expect(isFolderExplorerHref("/files?path=%5B%5D&focus=file-1")).toBe(true);
  expect(isFolderExplorerHref("#/files?path=%5B%5D")).toBe(true);
  expect(
    isFolderExplorerHref(
      "#/shared-files/20117e32-13ad-4c3f-87ec-0541eb39fc97?name=资料",
    ),
  ).toBe(true);
  expect(isFolderExplorerHref("#/shared-files/join?token=abc")).toBe(false);
  expect(isFolderExplorerHref("#/r/20117e32-13ad-4c3f-87ec-0541eb39fc97")).toBe(
    false,
  );
});

const session = "20117e32-13ad-4c3f-87ec-0541eb39fc97";
