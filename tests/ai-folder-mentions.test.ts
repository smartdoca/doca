import { expect, it } from "vitest";
import {
  answerSegments,
  folderExplorerHash,
  isFolderExplorerHref,
  isMailHref,
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
const mail = {
  id: "msg-1",
  mailboxId: "11111111-1111-4111-8111-111111111111",
  subject: "会议纪要",
  from: "Ada <ada@example.com>",
  href: "/mail/11111111-1111-4111-8111-111111111111?message=msg-1",
};

it("turns a mail search hit into a card and keeps the chat session on the link", () => {
  const segments = answerSegments("找到这封邮件。", [], {
    ensureCards: true,
    mails: [mail],
  });
  expect(segments).toEqual([
    { type: "text", text: "找到这封邮件。" },
    { type: "mail", mail },
  ]);
  expect(isMailHref(mail.href)).toBe(true);
  expect(withSessionHash(mail.href, session)).toBe(
    `/mail/${mail.mailboxId}?message=msg-1&session=${session}`,
  );
  expect(withSessionHash("/files?path=%5B%5D", session)).toContain(`session=${session}`);
  expect(keepsAssistantSession("/mail/box")).toBe(true);
  expect(keepsAssistantSession("/files")).toBe(true);
  expect(keepsAssistantSession("/home")).toBe(false);
});
