import { Agent } from "@mastra/core/agent";
import { enqueueProjection } from "@core/modules/automation/jobs.js";
import { aiConfig } from "@core/modules/ai/config.js";
import { enqueueKnowledge } from "@core/modules/knowledge/service.js";
import { mailKnowledgeIncluded } from "@core/modules/mail/scope.js";
import type { DB } from "@db/index.js";
import { meteredModel } from "./ai/model.js";

export async function tagMailMessage(db: DB, messageId: string) {
  const row = await db
    .selectFrom("mail_messages as m")
    .innerJoin("mailboxes as b", "b.id", "m.mailbox_id")
    .select([
      "m.subject",
      "m.from_addr",
      "m.snippet",
      "m.body_text",
      "m.starred",
      "m.ai_tags",
      "b.owner_id",
      "b.knowledge_scope",
      "b.deleted_at",
    ])
    .where("m.id", "=", messageId)
    .executeTakeFirst();
  if (!row || row.deleted_at || !mailKnowledgeIncluded(row.knowledge_scope, row.starred)) return;
  if (row.ai_tags.trim()) return;
  const config = await aiConfig(db);
  const modelConfig = config.models.find(
    (item) => item.id === config.defaultModel && item.enabled && !item.embedding,
  );
  if (!modelConfig) return;
  const model = await meteredModel(db, row.owner_id, modelConfig.id, null);
  const agent = new Agent({
    id: "mail-tagger",
    name: "邮件打标",
    model,
    instructions: "你为私人邮件生成检索标签。只输出 3 到 6 个短标签，用中文顿号分隔，不要解释。",
  });
  const text = [row.subject, row.from_addr, row.snippet, row.body_text.slice(0, 2000)]
    .filter(Boolean)
    .join("\n");
  const result = await agent.generate(`邮件内容：\n${text}`, {
    modelSettings: { maxOutputTokens: 120, maxRetries: 0 },
  });
  const parts = result.text
    .split(/[,，、;\n]+/u)
    .map((item) => item.replace(/^[\d.\-\s]+/u, "").trim())
    .filter((item) => item.length >= 2 && item.length <= 16);
  const tags = (parts.length ? parts.slice(0, 6).join("、") : result.text.replace(/\s+/g, " ").trim()).slice(0, 200);
  if (!tags) return;
  const updated = await db
    .updateTable("mail_messages")
    .set({ ai_tags: tags })
    .where("id", "=", messageId)
    .where("ai_tags", "=", "")
    .executeTakeFirst();
  if (!updated.numUpdatedRows) return;
  await enqueueProjection(db, "search-mail", messageId, { messageId });
  await enqueueKnowledge(db, "mail", messageId);
}
