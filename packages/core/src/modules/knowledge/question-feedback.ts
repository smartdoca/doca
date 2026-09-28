import { randomUUID } from "node:crypto";
import type { DB } from "@db/index.js";
import type { Actor } from "../identity/passwords.js";
import {
  conversationAccess,
  visibleKnowledgeAnswers,
} from "./conversations.js";
import { fail } from "../../shared/errors.js";
export async function messageFeedback(db: DB, userId: string, ids: string[]) {
  if (!ids.length) return {} as Record<string, string>;
  const rows = await db
    .selectFrom("knowledge_cases")
    .select(["message_id", "judgment"])
    .where("user_id", "=", userId)
    .where("message_id", "in", ids)
    .where("status", "!=", "withdrawn")
    .execute();
  return Object.fromEntries(rows.map((row) => [row.message_id, row.judgment]));
}
export async function recordQuestionFeedback(
  db: DB,
  actor: Actor,
  id: string,
  judgment: "useful" | "unhelpful" | null,
  reason = "",
) {
  const message = await db
    .selectFrom("knowledge_messages")
    .selectAll()
    .where("id", "=", id)
    .where("role", "=", "assistant")
    .executeTakeFirst();
  if (!message) fail(404, "回答不存在");
  const conversation = await conversationAccess(
    db,
    actor,
    message.conversation_id,
  );
  if (conversation.kind !== "answer") fail(400, "只支持问答反馈");
  if (judgment === null) {
    await db
      .updateTable("knowledge_cases")
      .set({ status: "withdrawn" })
      .where("message_id", "=", id)
      .where("user_id", "=", actor.id)
      .execute();
    return { ok: true, judgment: null };
  }
  const rows = await db
    .selectFrom("knowledge_messages")
    .selectAll()
    .where("conversation_id", "=", conversation.id)
    .where("created_at", "<=", message.created_at)
    .where("role", "in", ["user", "assistant"])
    .orderBy("created_at", "desc")
    .limit(30)
    .execute();
  const visible = await visibleKnowledgeAnswers(
    db,
    actor,
    conversation.scope_id,
    rows.reverse(),
    false,
  );
  const row = {
    id: randomUUID(),
    bot_id: conversation.scope_id,
    message_id: id,
    user_id: actor.id,
    judgment,
    reason,
    snapshot: JSON.stringify({
      conversationId: conversation.id,
      messageId: id,
      summary: conversation.summary,
      messages: visible.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        createdAt: m.created_at,
      })),
      evidence: JSON.parse(visible.find((m) => m.id === id)?.detail ?? "{}"),
    }),
    status: "open",
    created_at: new Date().toISOString(),
  };
  await db
    .insertInto("knowledge_cases")
    .values(row)
    .onConflict((oc) =>
      oc
        .columns(["message_id", "user_id"])
        .doUpdateSet({
          judgment,
          reason,
          snapshot: row.snapshot,
          status: "open",
        }),
    )
    .execute();
  return { ok: true, judgment };
}
