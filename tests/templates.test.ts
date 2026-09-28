import { openTestDatabase } from "./database.js";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { DB } from "@db/index.js";
import { createUser, type Actor } from "@core/modules/identity/passwords.js";
import { createContent } from "@core/workflows/resources.js";
import { restoreDocument } from "@core/modules/collaboration/documents.js";
import { restoreMarkdown } from "@core/modules/documents/codecs/markdown.js";
import { restoreSurface } from "@core/modules/documents/codecs/surfaces.js";
import { readDocument } from "@smartdoca/slides/core";
import { CanvasModel } from "@smartdoca/canvas/model";
import { projectExlsxWorkbook } from "@smartdoca/sheet/model";
import * as Y from "yjs";
import {
  blankTemplateContent,
  createTemplates,
  templatePreviewLines,
} from "@core/modules/templates/templates.js";

let db: DB, admin: Actor, member: Actor;
beforeEach(async () => {
  db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  admin = {
    ...(await createUser(
      db,
      { login: "templates-admin", displayName: "模板管理员", password: "template-admin-2026" },
      { bootstrap: true },
    )),
    admin: 1,
  };
  member = {
    ...(await createUser(
      db,
      {
        login: "templates-member",
        displayName: "普通用户",
        password: "template-member-2026",
      },
      { actor: admin },
    )),
    admin: 0,
  };
});
afterEach(() => db.destroy());

it("lets every user create a document from an admin-managed template", async () => {
  const templates = createTemplates(db);
  const content = createContent(db);
  const markdown = await templates.create(admin, {
    format: "markdown",
    title: "周报",
    content: "# 周报\n\n本周完成",
    preview: "",
  });
  const rich = await templates.create(admin, {
    format: "rich_text",
    title: "纪要",
    content: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        type: "paragraph",
        children: [{ text: "会议纪要" }],
      },
    ],
  });
  await expect(
    templates.create(member, {
      format: "markdown",
      title: "越权",
      content: "no",
    }),
  ).rejects.toThrow("需要系统管理员权限");

  const listed = await templates.list("markdown");
  expect(listed.items.map((item) => item.title)).toEqual(["周报"]);
  expect(listed.items[0]).not.toHaveProperty("content");

  const fromMarkdown = await content.create(member, {
    kind: "document",
    format: "markdown",
    title: markdown.title,
    templateId: markdown.id,
  });
  const loadedMarkdown = await restoreMarkdown(db, fromMarkdown.id);
  try {
    expect(loadedMarkdown.doc.getText("markdown").toString()).toContain("本周完成");
  } finally {
    loadedMarkdown.destroy();
  }

  const fromRich = await content.create(member, {
    kind: "document",
    format: "rich_text",
    title: rich.title,
    templateId: rich.id,
  });
  const loadedRich = await restoreDocument(db, fromRich.id);
  try {
    expect(JSON.stringify(loadedRich.runtime.getValue())).toContain("会议纪要");
  } finally {
    loadedRich.destroy();
  }

  await templates.update(admin, markdown.id, { title: "周报模板" });
  expect((await templates.get(markdown.id)).title).toBe("周报模板");
  await templates.remove(admin, markdown.id);
  await expect(templates.get(markdown.id)).rejects.toThrow("模板不存在");
  await expect(
    content.create(member, {
      kind: "document",
      format: "markdown",
      title: "缺失",
      templateId: markdown.id,
    }),
  ).rejects.toThrow("模板不存在");
});

it("copies spreadsheet, canvas and presentation templates into new documents", async () => {
  const templates = createTemplates(db);
  const content = createContent(db);
  const sheet = blankTemplateContent("spreadsheet") as {
    sheetOrder: string[];
    sheets: Record<string, { cellData: Record<string, Record<string, { v: string }>> }>;
  };
  sheet.sheets[sheet.sheetOrder[0]!]!.cellData = { 0: { 0: { v: "预算" } } };
  const savedSheet = await templates.create(admin, {
    format: "spreadsheet",
    title: "预算表",
    content: sheet,
  });
  const sheetDoc = await content.create(member, {
    kind: "document",
    format: "spreadsheet",
    title: "预算表",
    templateId: savedSheet.id,
  });
  const loadedSheet = await restoreSurface(db, sheetDoc.id, "spreadsheet");
  const projected = await projectExlsxWorkbook({
    baseline: loadedSheet.baseline!,
    update: loadedSheet.update,
    checkpointSeq: 0,
  });
  expect(JSON.stringify(projected)).toContain("预算");

  const canvas = await templates.create(admin, {
    format: "canvas",
    title: "空白画板",
    content: blankTemplateContent("canvas"),
  });
  const canvasDoc = await content.create(member, {
    kind: "document",
    format: "canvas",
    title: canvas.title,
    templateId: canvas.id,
  });
  const loadedCanvas = await restoreSurface(db, canvasDoc.id, "canvas");
  const model = CanvasModel.restore({
    codec: "aidcanvas-yjs",
    schemaVersion: 1,
    epochId: loadedCanvas.epochId,
    update: loadedCanvas.update,
  });
  try {
    expect(model.getValue().scene.children).toEqual([]);
  } finally {
    model.dispose();
  }

  const deck = await templates.create(admin, {
    format: "presentation",
    title: "立项",
    content: blankTemplateContent("presentation"),
  });
  const deckDoc = await content.create(member, {
    kind: "document",
    format: "presentation",
    title: "立项",
    templateId: deck.id,
  });
  const loadedDeck = await restoreSurface(db, deckDoc.id, "presentation");
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, loadedDeck.update);
    expect(readDocument(doc).title).toBe("立项");
  } finally {
    doc.destroy();
  }
  expect(templatePreviewLines("spreadsheet", sheet).join(" ")).toContain("预算");
});

it("rejects a template whose type does not match the new document", async () => {
  const templates = createTemplates(db);
  const saved = await templates.create(admin, {
    format: "markdown",
    title: "笔记",
    content: "正文",
  });
  await expect(
    createContent(db).create(member, {
      kind: "document",
      format: "rich_text",
      title: "笔记",
      templateId: saved.id,
    }),
  ).rejects.toThrow("模板与文档类型不一致");
  await expect(
    templates.create(admin, {
      format: "rich_text",
      title: "坏模板",
      content: { text: "不是文档节点" },
    }),
  ).rejects.toThrow("文档模板内容无效");
});
