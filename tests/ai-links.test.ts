import { afterEach, beforeEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { openTestDatabase } from "./database.js";
import {
  createUser,
  type Actor,
} from "@core/modules/identity/passwords.js";
import type { DB } from "@db/index.js";
import { createContent } from "@core/workflows/resources.js";
import {
  editAIDocument,
  readAIDocument,
} from "@core/workflows/ai-documents.js";

let db: DB, owner: Actor;
beforeEach(async () => {
  db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  owner = {
    ...(await createUser(
      db,
      { login: "owner", displayName: "Owner", password: "test-password-2026" },
      { bootstrap: true },
    )),
    admin: 1,
  };
});
afterEach(async () => {
  await db.destroy();
});

const flatten = (nodes: any[]): any[] =>
  nodes.flatMap((n) => [n, ...flatten(n.children ?? [])]);
const links = (value: any[]) =>
  flatten(value).filter((n) => n.type === "link");
const createRichDoc = () =>
  createContent(db).create(owner, {
    title: "链接文档",
    kind: "document",
    format: "rich_text",
  });

it("rich_text append converts markdown link syntax into native link inlines", async () => {
  const doc = await createRichDoc();
  const read = await readAIDocument(db, { actor: owner }, doc.id);
  const result = await editAIDocument(
    db,
    { actor: owner },
    doc.id,
    { seq: read.seq, epochId: read.epochId! },
    [
      {
        type: "append",
        text: "详见 [Doca 官网](https://doca.example.com) 与 [邮箱](mailto:a@b.co) 了解更多",
      },
    ],
    randomUUID(),
  );
  expect(result.saved).toBe(true);
  const after = await readAIDocument(db, { actor: owner }, doc.id);
  const found = links(after.value as any[]);
  expect(found).toHaveLength(2);
  expect(found[0]).toMatchObject({
    type: "link",
    url: "https://doca.example.com",
    children: [{ text: "Doca 官网" }],
  });
  const paragraph = (after.value as any[]).at(-1);
  expect(paragraph.children.map((c: any) => c.text ?? c.children?.[0]?.text)).toEqual([
    "详见 ",
    "Doca 官网",
    " 与 ",
    "邮箱",
    " 了解更多",
  ]);
});

it("rich_text append turns markdown headings, lists and tables into native blocks", async () => {
  const doc = await createRichDoc();
  const read = await readAIDocument(db, { actor: owner }, doc.id);
  await editAIDocument(
    db,
    { actor: owner },
    doc.id,
    { seq: read.seq, epochId: read.epochId! },
    [
      {
        type: "append",
        text: "## 概述\n\n正文一段\n\n- 第一项\n- 第二项\n\n| 数据源 | 接入方式 |\n| --- | --- |\n| 在线文档 | API |",
      },
    ],
    randomUUID(),
  );
  const after = await readAIDocument(db, { actor: owner }, doc.id);
  const nodes = after.value as any[];
  expect(nodes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: "paragraph", title: "h2" }),
      expect.objectContaining({ type: "paragraph", list: "ul" }),
      expect.objectContaining({ type: "table" }),
    ]),
  );
  const saved = JSON.stringify(nodes);
  expect(saved).not.toContain("## 概述");
  expect(saved).not.toContain("| 数据源 |");
  expect(saved).toContain("概述");
  expect(saved).toContain("在线文档");
});

it("rich_text append keeps plain text without link syntax untouched", async () => {
  const doc = await createRichDoc();
  const read = await readAIDocument(db, { actor: owner }, doc.id);
  await editAIDocument(
    db,
    { actor: owner },
    doc.id,
    { seq: read.seq, epochId: read.epochId! },
    [{ type: "append", text: "普通段落 [不是链接] 与 (括号)" }],
    randomUUID(),
  );
  const after = await readAIDocument(db, { actor: owner }, doc.id);
  const paragraph = (after.value as any[]).at(-1);
  expect(paragraph.children).toEqual([{ text: "普通段落 [不是链接] 与 (括号)" }]);
});

it("link command wraps an existing text range and preserves the block id", async () => {
  const doc = await createRichDoc();
  const read = await readAIDocument(db, { actor: owner }, doc.id);
  const edited = await editAIDocument(
    db,
    { actor: owner },
    doc.id,
    { seq: read.seq, epochId: read.epochId! },
    [{ type: "append", text: "请访问项目主页获取更多信息" }],
    randomUUID(),
  );
  const after = await readAIDocument(db, { actor: owner }, doc.id);
  const paragraph = (after.value as any[]).at(-1);
  const text: string = paragraph.children[0].text;
  const index = text.indexOf("项目主页");
  const linked = await editAIDocument(
    db,
    { actor: owner },
    doc.id,
    { seq: edited.seq, epochId: edited.epochId },
    [
      {
        type: "link",
        blockId: paragraph.id,
        index,
        length: 4,
        url: "https://doca.example.com",
      },
    ],
    randomUUID(),
  );
  expect(linked.saved).toBe(true);
  const final = await readAIDocument(db, { actor: owner }, doc.id);
  const finalParagraph = (final.value as any[]).find(
    (n) => n.id === paragraph.id,
  );
  expect(finalParagraph).toBeTruthy();
  const found = links([finalParagraph]);
  expect(found).toHaveLength(1);
  expect(found[0]).toMatchObject({
    url: "https://doca.example.com",
    children: [{ text: "项目主页" }],
  });
  expect(
    finalParagraph.children.map((c: any) => c.text ?? c.children?.[0]?.text).join(""),
  ).toBe(text);
});

it("link command over a linked range updates the url instead of nesting", async () => {
  const doc = await createRichDoc();
  const read = await readAIDocument(db, { actor: owner }, doc.id);
  const first = await editAIDocument(
    db,
    { actor: owner },
    doc.id,
    { seq: read.seq, epochId: read.epochId! },
    [{ type: "append", text: "详见 [旧地址](https://old.example.com) 内容" }],
    randomUUID(),
  );
  let after = await readAIDocument(db, { actor: owner }, doc.id);
  const paragraph = (after.value as any[]).at(-1);
  const second = await editAIDocument(
    db,
    { actor: owner },
    doc.id,
    { seq: first.seq, epochId: first.epochId },
    [
      {
        type: "link",
        blockId: paragraph.id,
        index: 3,
        length: 3,
        url: "https://new.example.com",
      },
    ],
    randomUUID(),
  );
  after = await readAIDocument(db, { actor: owner }, doc.id);
  const found = links(after.value as any[]);
  expect(found).toHaveLength(1);
  expect(found[0].url).toBe("https://new.example.com");
  expect(second.saved).toBe(true);
});

it("link command rejects bad urls and invalid ranges", async () => {
  const doc = await createRichDoc();
  const read = await readAIDocument(db, { actor: owner }, doc.id);
  const edited = await editAIDocument(
    db,
    { actor: owner },
    doc.id,
    { seq: read.seq, epochId: read.epochId! },
    [{ type: "append", text: "一些文字" }],
    randomUUID(),
  );
  const after = await readAIDocument(db, { actor: owner }, doc.id);
  const blockId = (after.value as any[]).at(-1).id;
  await expect(
    editAIDocument(
      db,
      { actor: owner },
      doc.id,
      { seq: edited.seq, epochId: edited.epochId },
      [{ type: "link", blockId, index: 0, length: 2, url: "javascript:alert(1)" }],
      randomUUID(),
    ),
  ).rejects.toThrow("链接必须是 http(s)、mailto、tel 或站内地址");
  await expect(
    editAIDocument(
      db,
      { actor: owner },
      doc.id,
      { seq: edited.seq, epochId: edited.epochId },
      [{ type: "link", blockId, index: 3, length: 9, url: "https://a.co" }],
      randomUUID(),
    ),
  ).rejects.toThrow("链接范围无效");
});

it("link command refuses blocks containing atomic inlines", async () => {
  const doc = await createRichDoc();
  // Initialize the document through the normal read path before direct runtime edits.
  await readAIDocument(db, { actor: owner }, doc.id);
  const { restoreDocument } = await import(
    "../packages/core/src/modules/collaboration/documents.js"
  );
  const { transact } = await import("@db/transactions.js");
  const mentionBlock = randomUUID();
  await transact(db, async (tx) => {
    const l = await restoreDocument(tx, doc.id);
    try {
      l.runtime.execute({
        type: "insertBlock",
        block: {
          id: mentionBlock,
          type: "paragraph",
          children: [
            { text: "请咨询 " },
            {
              id: randomUUID(),
              type: "custom:user-mention",
              userId: owner.id,
              label: "Owner",
              children: [{ text: "" }],
            },
            { text: " 获取权限" },
          ],
        },
      } as any);
      const { b64, createDocuments } = await import(
        "../packages/core/src/modules/collaboration/documents.js"
      );
      const Y = await import("yjs");
      const epoch = await tx
        .selectFrom("editor_epochs")
        .select("epoch_id")
        .where("resource_id", "=", doc.id)
        .executeTakeFirstOrThrow();
      const update = Y.encodeStateAsUpdate(l.doc);
      await createDocuments(tx).exchange(owner, doc.id, {
        update: b64(update),
        codec: "slate-kit",
        protocolVersion: 1,
        schemaVersion: 3,
        epochId: epoch.epoch_id,
        messageId: randomUUID(),
      });
    } finally {
      l.destroy();
    }
  });
  const read = await readAIDocument(db, { actor: owner }, doc.id);
  const block = (read.value as any[]).find((n) => n.id === mentionBlock);
  expect(block).toBeTruthy();
  await expect(
    editAIDocument(
      db,
      { actor: owner },
      doc.id,
      { seq: read.seq, epochId: read.epochId! },
      [
        {
          type: "link",
          blockId: mentionBlock,
          index: 0,
          length: 3,
          url: "https://a.co",
        },
      ],
      randomUUID(),
    ),
  ).rejects.toThrow("含原子元素的文字区域需缩小范围");
});

it("link command works inside table cell paragraphs", async () => {
  const doc = await createRichDoc();
  const read = await readAIDocument(db, { actor: owner }, doc.id);
  const block = (read.value as any[])[0];
  const edited = await editAIDocument(
    db,
    { actor: owner },
    doc.id,
    { seq: read.seq, epochId: read.epochId! },
    [{ type: "insertTable", rows: 1, columns: 1, afterId: block.id }],
    randomUUID(),
  );
  const after = await readAIDocument(db, { actor: owner }, doc.id);
  const cellParagraph = flatten(after.value as any[]).find(
    (n) => n.type === "paragraph" && n.children?.[0]?.text === "",
  );
  expect(cellParagraph).toBeTruthy();
  const linked = await editAIDocument(
    db,
    { actor: owner },
    doc.id,
    { seq: after.seq, epochId: after.epochId! },
    [
      {
        type: "text",
        blockId: cellParagraph.id,
        index: 0,
        deleteCount: 0,
        text: "单元格链接",
      },
    ],
    randomUUID(),
  );
  await editAIDocument(
    db,
    { actor: owner },
    doc.id,
    { seq: linked.seq, epochId: linked.epochId },
    [
      {
        type: "link",
        blockId: cellParagraph.id,
        index: 0,
        length: 5,
        url: "https://doca.example.com",
      },
    ],
    randomUUID(),
  );
  const final = await readAIDocument(db, { actor: owner }, doc.id);
  const found = links(final.value as any[]);
  expect(found).toHaveLength(1);
  expect(found[0]).toMatchObject({
    url: "https://doca.example.com",
    children: [{ text: "单元格链接" }],
  });
});

it("wire schema accepts loosely-shaped operations and server errors stay precise", async () => {
  const { editToolSchema } = await import(
    "../packages/core/src/modules/ai/edit-schema.js"
  );
  const schema = editToolSchema("rich_text");
  // Mastra pre-validation no longer rejects semantic mistakes with an opaque union error
  expect(
    schema.safeParse({
      resourceId: randomUUID(),
      seq: 0,
      epochId: "e",
      operations: [{ type: "node", id: "x" }],
    }).success,
  ).toBe(true);
  const doc = await createRichDoc();
  const read = await readAIDocument(db, { actor: owner }, doc.id);
  await expect(
    editAIDocument(
      db,
      { actor: owner },
      doc.id,
      { seq: read.seq, epochId: read.epochId! },
      [{ type: "node", id: "x" }],
      randomUUID(),
    ),
  ).rejects.toThrow("不支持 rich_text 命令 node");
  await expect(
    editAIDocument(
      db,
      { actor: owner },
      doc.id,
      { seq: read.seq, epochId: read.epochId! },
      [{ type: "text", blockId: "b1", index: 0, deleteCount: 0 }],
      randomUUID(),
    ),
  ).rejects.toThrow(/rich_text 的 text 参数不合法：text/);
});

it("insertBlock link inlines enforce the editor url policy", async () => {
  const doc = await createRichDoc();
  const read = await readAIDocument(db, { actor: owner }, doc.id);
  await expect(
    editAIDocument(
      db,
      { actor: owner },
      doc.id,
      { seq: read.seq, epochId: read.epochId! },
      [
        {
          type: "insertBlock",
          block: {
            id: randomUUID(),
            type: "paragraph",
            children: [
              {
                id: randomUUID(),
                type: "link",
                url: "javascript:alert(1)",
                children: [{ text: "x" }],
              },
            ],
          },
        },
      ],
      randomUUID(),
    ),
  ).rejects.toThrow("链接必须是 http(s)、mailto、tel 或站内地址");
});

it("presentation text leaf link property persists", async () => {
  const doc = await createContent(db).create(owner, {
    title: "PPT",
    kind: "document",
    format: "presentation",
  });
  const read = await readAIDocument(db, { actor: owner }, doc.id);
  const slideId = (read.value as any).slideOrder[0];
  await editAIDocument(
    db,
    { actor: owner },
    doc.id,
    { seq: read.seq, epochId: read.epochId! },
    [
      {
        type: "insert",
        slideId,
        element: {
          id: randomUUID(),
          type: "text",
          transform: {
            x: 914400,
            y: 914400,
            width: 4000000,
            height: 800000,
            rotation: 0,
          },
          paragraphs: [
            {
              type: "paragraph",
              children: [
                { text: "访问 " },
                { text: "Doca 官网", link: "https://doca.example.com" },
              ],
            },
          ],
        },
      },
    ],
    randomUUID(),
  );
  const after = await readAIDocument(db, { actor: owner }, doc.id);
  const text = JSON.stringify((after.value as any).slides[slideId].elements);
  expect(text).toContain('"link":"https://doca.example.com"');
});
