import { createHash, randomUUID } from "node:crypto";
import type { DB } from "@db/index.js";
import { transact } from "@db/transactions.js";
import type { Actor } from "../identity/passwords.js";
import {
  maintainKnowledge,
  effectiveKnowledgeBotLibraries,
  knowledgeBotConfig,
  canManageKnowledgeBot,
  knowledgeAssistantAccess,
  knowledgeSettingsSchema,
  effectiveKnowledgeSettings,
  sanitizeKnowledge,
} from "./system.js";
import { fail } from "../../shared/errors.js";

export async function knowledgeBot(db: DB, actor: Actor, id: string) {
  const active = await db
    .selectFrom("users")
    .select("id")
    .where("id", "=", actor.id)
    .where("status", "=", "active")
    .executeTakeFirst();
  if (!active) fail(401, "账号不可用");
  const bot = await db
    .selectFrom("knowledge_assistants")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();
  if (!bot || !(await knowledgeAssistantAccess(db, actor, bot)).accessible)
    fail(404, "问答机器人不可用");
  return {
    ...bot,
    library_ids: JSON.stringify(await effectiveKnowledgeBotLibraries(db, bot)),
  };
}
export async function conversationAccess(db: DB, actor: Actor, id: string) {
  const row = await db
    .selectFrom("knowledge_conversations")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();
  if (!row) fail(404, "会话不存在");
  if (row.kind === "curation") await maintainKnowledge(db, actor, row.scope_id);
  else {
    if (row.owner_id !== actor.id) fail(404, "会话不存在");
    const bot = await knowledgeBot(db, actor, row.scope_id);
    if (row.access_key_id) {
      const key = await db
        .selectFrom("knowledge_bot_keys")
        .selectAll()
        .where("id", "=", row.access_key_id)
        .where("bot_id", "=", row.scope_id)
        .where("expires_at", ">", new Date().toISOString())
        .executeTakeFirst();
      if (
        !key ||
        !canManageKnowledgeBot(bot, key.creator_id) ||
        (key.channel.startsWith("public:")
          ? bot.visibility !== "public" ||
            !knowledgeBotConfig(bot).channels.includes(key.channel.slice(7))
          : !knowledgeBotConfig(bot).channels.includes(key.channel))
      )
        fail(403, "会话调用权限已撤销");
    }
  }
  return row;
}
/** Re-apply current scope and masking to stored answers, including old citation excerpts. */
export async function visibleKnowledgeAnswers<
  T extends { role: string; content: string; detail: string },
>(db: DB, actor: Actor, botId: string, messages: T[]) {
  const bot = await knowledgeBot(db, actor, botId),
    libraryIds = JSON.parse(bot.library_ids) as string[];
  const policies: ReturnType<typeof effectiveKnowledgeSettings>[] = [];
  for (const libraryId of libraryIds) {
    const row = await db
      .selectFrom("knowledge_settings")
      .select("config")
      .where("library_id", "=", libraryId)
      .executeTakeFirst();
    const config = knowledgeSettingsSchema.parse(
      row ? JSON.parse(row.config) : {},
    );
    policies.push(
      effectiveKnowledgeSettings(config, Object.keys(config.sourcePolicies)),
    );
  }
  const live = new Set(
    libraryIds.length
      ? (
          await db
            .selectFrom("resources")
            .select("id")
            .where("library_id", "in", libraryIds)
            .where("deleted_at", "is", null)
            .execute()
        ).map((x) => x.id)
      : [],
  );
  const mask = (text: string) =>
    policies.reduce((value, policy) => sanitizeKnowledge(value, policy), text);
  return messages.map((message) => {
    const detail = JSON.parse(message.detail);
    if (message.role !== "assistant")
      return { ...message, content: mask(message.content) };
    if (
      (detail.botRevision !== undefined &&
        detail.botRevision !== bot.revision) ||
      detail.citations?.some(
        (x: { documentId: string }) => !live.has(x.documentId),
      )
    )
      return {
        ...message,
        content: "",
        detail: JSON.stringify({ status: "withdrawn" }),
      };
    return {
      ...message,
      content: mask(message.content),
      detail: JSON.stringify({
        ...detail,
        ...(detail.query ? { query: mask(detail.query) } : {}),
        ...(detail.citations
          ? {
              citations: detail.citations.map((x: any) => ({
                ...x,
                title: mask(x.title),
                heading: mask(x.heading),
                text: mask(x.text),
              })),
            }
          : {}),
      }),
    };
  });
}
export async function createKnowledgeConversation(
  db: DB,
  actor: Actor,
  scopeId: string,
  kind: "curation" | "answer",
  title: string,
) {
  if (kind === "curation") await maintainKnowledge(db, actor, scopeId);
  else await knowledgeBot(db, actor, scopeId);
  const now = new Date().toISOString();
  const row = {
    id: randomUUID(),
    scope_id: scopeId,
    kind,
    owner_id: actor.id,
    title: title.trim().slice(0, 160) || "…",
    summary: "",
    state: "idle",
    created_at: now,
    updated_at: now,
  };
  await db.insertInto("knowledge_conversations").values(row).execute();
  return row;
}
export async function listKnowledgeConversations(
  db: DB,
  actor: Actor,
  scopeId: string,
  kind: "curation" | "answer",
) {
  if (kind === "curation") await maintainKnowledge(db, actor, scopeId);
  else await knowledgeBot(db, actor, scopeId);
  let query = db
    .selectFrom("knowledge_conversations")
    .selectAll()
    .where("scope_id", "=", scopeId)
    .where("access_key_id", "is", null)
    .where("kind", "=", kind);
  if (kind === "answer") query = query.where("owner_id", "=", actor.id);
  return query.orderBy("updated_at", "desc").limit(100).execute();
}
export async function appendKnowledgeMessage(
  db: DB,
  conversationId: string,
  role: string,
  content: string,
  authorId: string | null = null,
  trigger = "assistant",
  detail: unknown = {},
) {
  const row = {
    id: randomUUID(),
    conversation_id: conversationId,
    role,
    content,
    author_id: authorId,
    trigger,
    detail: JSON.stringify(detail),
    created_at: new Date().toISOString(),
  };
  await db.insertInto("knowledge_messages").values(row).execute();
  return row;
}
export async function sendKnowledgeMessage(
  db: DB,
  actor: Actor,
  id: string,
  content: string,
  requestId: string,
  trigger = "manual",
  attachments: {
    id: string;
    filename: string;
    mime: string;
    size: number;
  }[] = [],
) {
  if (!content.trim() || content.length > 20000)
    fail(400, "请输入不超过20000字的消息");
  return transact(db, async (tx) => {
    const conversation = await conversationAccess(tx, actor, id);
    const duplicate = await tx
      .selectFrom("knowledge_messages")
      .selectAll()
      .where("id", "=", requestId)
      .executeTakeFirst();
    if (duplicate) {
      if (
        duplicate.conversation_id !== id ||
        duplicate.author_id !== actor.id ||
        duplicate.content !== content ||
        JSON.stringify(JSON.parse(duplicate.detail).attachments ?? []) !==
          JSON.stringify(attachments)
      )
        fail(409, "请求编号已使用");
      return conversation;
    }
    if (
      conversation.kind === "answer" &&
      ["running", "queued"].includes(conversation.state)
    )
      fail(409, "请等待当前回答完成");
    const now = new Date().toISOString();
    await tx
      .insertInto("knowledge_messages")
      .values({
        id: requestId,
        conversation_id: id,
        role: "user",
        author_id: actor.id,
        trigger,
        content,
        detail: JSON.stringify({ attachments }),
        created_at: now,
      })
      .execute();
    await tx
      .insertInto("knowledge_tasks")
      .values({
        id: requestId,
        conversation_id: id,
        actor_id: actor.id,
        status: "queued",
        error: "",
        created_at: now,
        updated_at: now,
      })
      .execute();
    await tx
      .updateTable("knowledge_conversations")
      .set({
        state: conversation.state === "running" ? "running" : "queued",
        updated_at: now,
      })
      .where("id", "=", id)
      .execute();
    return { ...conversation, state: "queued" };
  });
}

/** One scheduled occurrence owns one conversation; task retries retain this identity. */
export async function createScheduledKnowledgeConversation(
  db: DB,
  actor: Actor,
  libraryId: string,
  triggeredAt = new Date(),
  purpose: "sources" | "feedback" = "sources",
  occurrenceKey = triggeredAt.toISOString().slice(0, 10),
) {
  return transact(db, async (tx) => {
    const timestamp = triggeredAt.toISOString();
    const conversation = await createKnowledgeConversation(
      tx,
      actor,
      libraryId,
      "curation",
      timestamp.replace("T", " ").replace(/\.\d{3}Z$/, " UTC"),
    );
    await sendKnowledgeMessage(
      tx,
      actor,
      conversation.id,
      purpose === "feedback" ? "处理本库尚未解决的问答反馈：先读取反馈并分类根因，按需修订知识或整理规则，验证当前知识下的回答。无法自动解决的决策登记人工待办后继续其他案例。" : "检查来源变化和质量，整理需要更新的知识，遵守本库来源范围和人工操作，按需推荐符合范围的高质量来源。",
      scheduledKnowledgeOccurrenceId(libraryId, purpose, occurrenceKey),
      purpose === "feedback" ? "feedback_schedule" : "schedule",
    );
    return conversation;
  });
}

export function scheduledKnowledgeOccurrenceId(
  libraryId: string,
  purpose: "sources" | "feedback",
  occurrenceKey: string,
) {
  const hex = createHash("sha256")
    .update(JSON.stringify([libraryId, purpose, occurrenceKey]))
    .digest("hex")
    .slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}
