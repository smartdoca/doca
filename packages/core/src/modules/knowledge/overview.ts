import type { DB } from "@db/index.js";
import { transact } from "@db/transactions.js";
import type { Actor } from "../identity/passwords.js";
import { maintainKnowledge } from "./system.js";
import { knowledgeDocumentSnapshot, fingerprint } from "./document-snapshot.js";
import { writeKnowledgeRichDocument } from "./rich-document.js";
import { fail } from "../../shared/errors.js";

/** Parent pages are real documents. Only their own child digest is needed to update a guide. */
export async function knowledgeOverviewContext(
  db: DB,
  actor: Actor,
  libraryId: string,
  documentId: string,
) {
  await maintainKnowledge(db, actor, libraryId);
  const directory = await db
    .selectFrom("knowledge_directories")
    .selectAll()
    .where("library_id", "=", libraryId)
    .where("resource_id", "=", documentId)
    .executeTakeFirst();
  if (!directory) fail(404, "请选择知识库的分类导读页");
  const parent = await db
    .selectFrom("resources as r")
    .innerJoin("document_states as d", "d.resource_id", "r.id")
    .select(["r.id", "r.title", "d.seq", "d.text"])
    .where("r.id", "=", documentId)
    .where("r.deleted_at", "is", null)
    .executeTakeFirstOrThrow();
  const children = await db
    .selectFrom("resources as r")
    .innerJoin("document_states as d", "d.resource_id", "r.id")
    .select(["r.id", "r.title", "d.seq", "d.text"])
    .where("r.parent_id", "=", documentId)
    .where("r.deleted_at", "is", null)
    .orderBy("r.title")
    .execute();
  return {
    documentId,
    title: parent.title,
    expectedSeq: parent.seq,
    markdown: parent.text,
    childFingerprint: fingerprint(
      children.map(({ id, title, seq }) => ({ id, title, seq })),
    ),
    children: children.map(({ text, ...child }) => ({
      ...child,
      excerpt: text.slice(0, 1800),
      characters: text.length,
      link: `#/r/${child.id}`,
    })),
  };
}
export async function saveKnowledgeOverview(
  db: DB,
  actor: Actor,
  libraryId: string,
  input: {
    documentId: string;
    expectedSeq: number;
    childFingerprint: string;
    markdown: string;
  },
) {
  return transact(db, async (tx) => {
    const current = await knowledgeOverviewContext(
      tx,
      actor,
      libraryId,
      input.documentId,
    );
    if (
      current.expectedSeq !== input.expectedSeq ||
      current.childFingerprint !== input.childFingerprint
    )
      fail(409, "导读页或子章节已变化，请读取最新内容后重试");
    if (input.markdown.trim().length < 100 || input.markdown.length > 20000)
      fail(400, "导读页需说明主题关系和阅读路径，请控制在100至20000字符");
    const markdown = `# ${current.title}\n\n${input.markdown.replace(/^\s*# [^\n]*\n?/, "").trim()}`;
    await writeKnowledgeRichDocument(tx, input.documentId, markdown);
    return {
      documentId: input.documentId,
      title: current.title,
      characters: input.markdown.length,
    };
  });
}
