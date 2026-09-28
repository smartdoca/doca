import { randomUUID } from "node:crypto";
import type { DB } from "@db/index.js";
import type { Actor } from "../identity/passwords.js";
import { maintainKnowledge } from "./system.js";
import { fail } from "../../shared/errors.js";
import { knowledgeInstructions } from "./system.js";
export type HumanTaskInput = {
  key: string;
  kind: "decision" | "draft" | "source";
  title: string;
  detail: {
    reason: string;
    entryId?: string;
    entryRevision?: number;
    sourceKey?: string;
    options?: string[];
  };
};
export async function upsertHumanTask(
  db: DB,
  actor: Actor,
  libraryId: string,
  conversationId: string,
  input: HumanTaskInput,
) {
  await maintainKnowledge(db, actor, libraryId);
  const conversation = await db
    .selectFrom("knowledge_conversations")
    .selectAll()
    .where("id", "=", conversationId)
    .executeTakeFirst();
  if (
    !conversation ||
    conversation.kind !== "curation" ||
    conversation.scope_id !== libraryId
  )
    fail(403, "待办必须属于当前知识库整理会话");
  if (
    input.detail.entryId &&
    !(await db
      .selectFrom("knowledge_entries")
      .select("id")
      .where("id", "=", input.detail.entryId)
      .where("library_id", "=", libraryId)
      .executeTakeFirst())
  )
    fail(403, "草稿不属于本库");
  const old = await db
    .selectFrom("knowledge_human_tasks")
    .selectAll()
    .where("library_id", "=", libraryId)
    .where("task_key", "=", input.key)
    .executeTakeFirst();
  const detail = JSON.stringify(input.detail);
  if (old && old.detail === detail && old.title === input.title) return old;
  const now = new Date().toISOString(),
    row = {
      id: old?.id ?? randomUUID(),
      library_id: libraryId,
      conversation_id: conversationId,
      task_key: input.key,
      kind: input.kind,
      title: input.title,
      detail,
      status: "open",
      revision: (old?.revision ?? 0) + 1,
      resolution: "",
      created_at: old?.created_at ?? now,
      updated_at: now,
    };
  await db
    .insertInto("knowledge_human_tasks")
    .values(row)
    .onConflict((oc) => oc.columns(["library_id", "task_key"]).doUpdateSet(row))
    .execute();
  return row;
}
export async function closeHumanTask(
  db: DB,
  actor: Actor,
  libraryId: string,
  id: string,
  revision: number,
  reason: string,
  status = "resolved",
) {
  await maintainKnowledge(db, actor, libraryId);
  const result = await db
    .updateTable("knowledge_human_tasks")
    .set({
      status,
      resolution: reason,
      revision: revision + 1,
      updated_at: new Date().toISOString(),
    })
    .where("id", "=", id)
    .where("library_id", "=", libraryId)
    .where("revision", "=", revision)
    .where("status", "=", "open")
    .executeTakeFirst();
  if (!Number(result.numUpdatedRows))
    fail(409, "待办已更新或已关闭，请刷新后查看");
  return { ok: true };
}
/** Deterministic invalidation; completed decisions remain auditable, never reappear as open cards. */
export async function reconcileHumanTasks(
  db: DB,
  actor: Actor,
  libraryId: string,
) {
  await maintainKnowledge(db, actor, libraryId);
  const latest = await db
    .selectFrom("knowledge_conversations")
    .select("id")
    .where("scope_id", "=", libraryId)
    .where("kind", "=", "curation")
    .orderBy("created_at", "desc")
    .executeTakeFirst();
  if (latest) {
    const drafts = await db
      .selectFrom("knowledge_entries")
      .select(["id", "title", "revision"])
      .where("library_id", "=", libraryId)
      .where("status", "=", "draft")
      .execute();
    for (const draft of drafts)
      await upsertHumanTask(db, actor, libraryId, latest.id, {
        key: `draft:${draft.id}`,
        kind: "draft",
        title: draft.title,
        detail: {
          reason: "draft_review",
          entryId: draft.id,
          entryRevision: draft.revision,
        },
      });
  }
  const tasks = await db
    .selectFrom("knowledge_human_tasks")
    .selectAll()
    .where("library_id", "=", libraryId)
    .where("status", "=", "open")
    .execute();
  const policy = await knowledgeInstructions(db, actor, libraryId);
  const sources = (
    await db
      .selectFrom("knowledge_subscriptions")
      .selectAll()
      .where("library_id", "=", libraryId)
      .where("status", "!=", "detached")
      .execute()
  ).filter((s) => !policy.settings.excludedSourceIds.includes(s.id));
  for (const task of tasks) {
    const detail = JSON.parse(task.detail);
    let reason = "";
    if (detail.entryId) {
      const entry = await db
        .selectFrom("knowledge_entries")
        .select(["status", "revision"])
        .where("id", "=", detail.entryId)
        .where("library_id", "=", libraryId)
        .executeTakeFirst();
      if (!entry || entry.status !== "draft") reason = "draft_resolved";
      else if (
        detail.entryRevision !== undefined &&
        entry.revision !== detail.entryRevision
      )
        reason = "draft_replaced";
    }
    if (detail.sourceKey) {
      if (
        policy.settings.sourceScope === "internal" &&
        /^https?:/i.test(detail.sourceKey)
      )
        reason = "source_scope_changed";
      if (
        sources.some(
          (s) =>
            s.id === detail.sourceKey ||
            s.url === detail.sourceKey ||
            s.source_id === detail.sourceKey,
        )
      )
        reason = "source_added";
      const action = await db
        .selectFrom("knowledge_source_actions")
        .select("action")
        .where("library_id", "=", libraryId)
        .where("source_key", "=", detail.sourceKey)
        .where("action", "in", ["ignore", "restore"])
        .orderBy("created_at", "desc")
        .executeTakeFirst();
      if (action?.action === "ignore") reason = "source_ignored";
    }
    if (reason)
      await db
        .updateTable("knowledge_human_tasks")
        .set({
          status: "obsolete",
          resolution: reason,
          revision: task.revision + 1,
          updated_at: new Date().toISOString(),
        })
        .where("id", "=", task.id)
        .where("revision", "=", task.revision)
        .where("status", "=", "open")
        .execute();
  }
  return db
    .selectFrom("knowledge_human_tasks")
    .selectAll()
    .where("library_id", "=", libraryId)
    .where("status", "=", "open")
    .orderBy("updated_at", "desc")
    .execute();
}
