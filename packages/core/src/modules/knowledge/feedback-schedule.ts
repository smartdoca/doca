import type { DB } from "@db/index.js";
import { createScheduledKnowledgeConversation } from "./conversations.js";
import { knowledgeSettingsSchema } from "./system.js";
export async function sweepKnowledgeFeedbackSchedules(
  db: DB,
  now = new Date(),
) {
  const libraries = await db
    .selectFrom("resources as r")
    .innerJoin("knowledge_settings as s", "s.library_id", "r.id")
    .select(["r.id", "r.owner_id", "s.config"])
    .where("r.kind", "=", "library")
    .where("r.deleted_at", "is", null)
    .where("r.ai_curated", "=", 1)
    .execute();
  for (const library of libraries) {
    const schedule = knowledgeSettingsSchema.parse(
      JSON.parse(library.config),
    ).feedbackSchedule;
    if (schedule === "off") continue;
    const last = await db
      .selectFrom("knowledge_messages as m")
      .innerJoin("knowledge_conversations as c", "c.id", "m.conversation_id")
      .select("m.created_at")
      .where("c.scope_id", "=", library.id)
      .where("m.trigger", "=", "feedback_schedule")
      .orderBy("m.created_at", "desc")
      .executeTakeFirst();
    if (
      last &&
      now.getTime() - Date.parse(last.created_at) <
        (schedule === "weekly" ? 7 : 1) * 86400000
    )
      continue;
    const cases = await db
      .selectFrom("knowledge_cases as c")
      .innerJoin("knowledge_assistants as b", "b.id", "c.bot_id")
      .select(["b.library_ids"])
      .where("c.status", "=", "open")
      .where("c.judgment", "=", "unhelpful")
      .execute();
    if (
      !cases.some((item) =>
        (JSON.parse(item.library_ids) as string[]).includes(library.id),
      )
    )
      continue;
    const owner = await db
      .selectFrom("users")
      .select(["id", "display_name", "admin"])
      .where("id", "=", library.owner_id)
      .where("status", "=", "active")
      .executeTakeFirst();
    if (!owner) continue;
    try {
      await createScheduledKnowledgeConversation(
        db,
        owner,
        library.id,
        now,
        "feedback",
      );
    } catch {
      /* One inaccessible library must not stop other scheduled work. */
    }
  }
}
