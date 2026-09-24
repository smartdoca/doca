if (process.env.DOCA_QA_ISOLATED !== "1")
  throw Error("Set DOCA_QA_ISOLATED=1; isolated fixture server only");
import { openDatabase } from "../packages/db/src/index.ts";
import { createUser } from "../packages/core/src/modules/identity/passwords.ts";
import { createContent } from "../packages/core/src/workflows/resources.ts";
import { restoreDocument } from "../packages/core/src/modules/collaboration/documents.ts";
import { createApp } from "../apps/server/src/bootstrap/app.ts";
import { restoreMarkdown } from "../packages/core/src/modules/documents/codecs/markdown.ts";
import { encodeMarkdownAnchor } from "../packages/core/src/modules/documents/codecs/markdown-anchor.ts";
import { createMarkdownTextAnchor } from "exmd-collaborative-editor";
import { provisionSurface, restoreSurface } from "../packages/core/src/modules/documents/codecs/surfaces.ts";
import { restoreExlsxDocument, createExlsxCollaborationSession } from "@online-office/univer-sheet/yjs";
const db = await openDatabase({ driver: "sqlite", path: ":memory:" });
const owner = {
  ...(await createUser(
    db,
    { login: "qatest", displayName: "协同甲", password: "qa-password-2026" },
    { bootstrap: true },
  )),
  admin: 1,
};
const peer = await createUser(
  db,
  { login: "qapeer", displayName: "协同乙", password: "qa-password-2026" },
  { actor: owner },
);
const content = createContent(db),
  resources = [];
const longDocs = process.env.DOCA_QA_LONG_DOCS === "1";
for (const format of [
  "rich_text",
  "markdown",
  "spreadsheet",
  "canvas",
  "presentation",
] as const) {
  const r = await content.create(owner, {
    kind: "document",
    format,
    title: "Audit " + format,
    ...(format === "markdown"
      ? {
          markdown:
            "# Audit markdown\nBase\n" +
            (longDocs
              ? Array.from(
                  { length: 160 },
                  (_, i) =>
                    `\n## Section ${i}\n\nMarkdown comment target ${i}. 测试正文。\n` +
                    (i % 3 === 0
                      ? `\n\`\`\`typescript\n${Array.from({ length: 12 }, (_, n) => `const row${n} = "测试长代码 ${i}";`).join("\n")}\n\`\`\`\n`
                      : "\n- 第一项\n- 第二项\n"),
                ).join("")
              : ""),
        }
      : {}),
    ...(longDocs && format === "rich_text"
      ? {
          initialContent: {
            schemaVersion: 2,
            children: Array.from({ length: 400 }, (_, i) => ({
              id: `row-${i}`,
              type: "paragraph",
              children: [{ text: `Large document row ${i}` }],
            })),
          },
        }
      : {}),
    ...(process.env.DOCA_QA_OUTLINE === "1" && format === "rich_text"
      ? {
          initialContent: {
            schemaVersion: 2,
            children: [
              { id: "outline-title", type: "heading-one", children: [{ text: "部门季报/半年报/年报" }] },
              ...["1. 季度/半年度/年度小结", "2. 交付甘特图", "3. 关键指标", "3.1 用户注册率", "3.2 接口可用性", "4. 组织建设"].flatMap((text, i) => [
                { id: `outline-heading-${i}`, type: i === 3 || i === 4 ? "heading-three" : "heading-two", children: [{ text }] },
                ...Array.from({ length: 12 }, (_, n) => ({ id: `outline-body-${i}-${n}`, type: "paragraph", children: [{ text: `季度进展与工作记录 ${i + 1} — ${n + 1}` }] })),
              ]),
            ],
          },
        }
      : {}),
    ...(process.env.DOCA_QA_CODE_HIGHLIGHT === "1" && format === "rich_text"
      ? {
          initialContent: {
            schemaVersion: 2,
            children: [
              {
                id: "qa-title",
                type: "heading-one",
                children: [{ text: "代码高亮隔离验收" }],
              },
              {
                id: "qa-code",
                type: "code-block",
                language: "bash",
                code: "npm install react\n\n# 包尚未发布时，生成 tarball\nyarn build\n# class=\"token comment\" <script> &",
                children: [{ text: "" }],
              },
              {
                id: "qa-tail",
                type: "paragraph",
                children: [{ text: "代码块之后的正文保持可编辑" }],
              },
            ],
          },
        }
      : {}),
  });
  if (format === "spreadsheet" && process.env.DOCA_QA_SHEET_FEATURES === "1")
    await db
      .transaction()
      .execute((tx) =>
        provisionSurface(tx, r),
      );
  if (process.env.DOCA_QA_SKIP_PEER_GRANTS !== "1")
    await content.permissions(owner, r.id, {
      version: r.version,
      visibility: "invited",
      accessMode: "custom",
      grants: [{ userId: peer.id, role: process.env.DOCA_QA_READER === "1" ? "reader" : "editor" }],
    });
  resources.push(r);
  if (format === "rich_text" && process.env.DOCA_QA_OUTLINE === "1" && process.env.DOCA_QA_RICH_COMMENTS === "1") {
    const loaded = await restoreDocument(db, r.id);
    try {
      for (const i of [0, 2, 4, 5]) {
        const anchor = loaded.runtime.createCommentAnchor(`outline-heading-${i}`, 0, 4);
        await content.comment(owner, r.id, `正文联动验收 ${i}`, null, JSON.stringify({
          ...anchor, start: Buffer.from(anchor.start).toString("base64"), end: Buffer.from(anchor.end).toString("base64"),
        }));
      }
    } finally { loaded.destroy(); }
  }
  if (format === "spreadsheet" && process.env.DOCA_QA_SHEET_COMMENTS === "1") {
    await db.transaction().execute(tx => provisionSurface(tx, r));
    const loaded = await restoreSurface(db, r.id, format);
    const doc = await restoreExlsxDocument({ baseline: loaded.baseline!, update: loaded.update, checkpointSeq: loaded.state.checkpoint_seq });
    const session = await createExlsxCollaborationSession({ doc, baseline: loaded.baseline!, sessionId: "qa-comment-fixture", readOnly: true });
    try {
      const sheetId = loaded.baseline!.snapshot.sheetOrder[0]!;
      for (let i = 0; i < 12; i++) {
        const anchor = session.captureCellAnchor!({ sheetId, startRow: i * 3, endRow: i * 3 + 2, startColumn: 0, endColumn: 3 })!;
        await content.comment(owner, r.id, `区域评论 ${i + 1}`, null, JSON.stringify(anchor));
      }
    } finally { session.dispose(); doc.destroy(); }
  }
  if (longDocs && format === "markdown") {
    const loaded = await restoreMarkdown(db, r.id);
    try {
      const text = loaded.doc.getText("markdown");
      for (const i of [0, 0, 3, 30, 95]) {
        const quote = `Markdown comment target ${i}`,
          start = text.toString().indexOf(quote);
        const anchor = encodeMarkdownAnchor(
          createMarkdownTextAnchor(text, start, start + quote.length),
          loaded.epochId!,
          quote,
        );
        await content.comment(
          owner,
          r.id,
          `Scroll QA ${i}`,
          null,
          JSON.stringify(anchor),
        );
      }
    } finally {
      loaded.destroy();
    }
  }
}
const port = Number(process.env.DOCA_QA_PORT ?? 39140);
// Browser cookies are shared across ports. Use localhost when the daily service
// uses 127.0.0.1 so a fixture login cannot replace the user's daily session.
const hostname = process.env.DOCA_QA_LOCALHOST === "1" ? "localhost" : "127.0.0.1";
const app = await createApp(db, {
  origin: `http://${hostname}:${port}`,
  staticDirectory: process.env.DOCA_QA_STATIC_DIRECTORY ?? new URL("../apps/web/dist", import.meta.url).pathname,
});
console.log(JSON.stringify({ resources, peerId: peer.id }));
if (process.env.DOCA_QA_RICH_COMMENTS === "1") {
  const audit = async () => console.log("layout-audit", JSON.stringify({
    time: new Date().toISOString(),
    states: await db.selectFrom("document_states").select(["resource_id", "seq", "checkpoint_seq", "updated_at"]).execute(),
    updates: await db.selectFrom("document_updates").select(({ fn }) => fn.countAll().as("count")).executeTakeFirst(),
  }));
  await audit();
  setInterval(() => void audit(), 30_000).unref();
}
await app.listen({ host: "127.0.0.1", port });
console.log("isolated audit ready");
process.on("SIGTERM", async () => {
  await app.close();
  await db.destroy();
  process.exit(0);
});
