import type { DB } from "@db/index.js";
import type { Actor } from "../identity/passwords.js";
import { AppError } from "../../shared/errors.js";
import { listKnowledgeAssistants, searchKnowledgeAssistant } from "./system.js";

/** Search-only projection: connections never delegate source or document tools. */
export async function searchConnectedKnowledge(
  db: DB,
  actor: Actor,
  query: string,
) {
  const bots = (await listKnowledgeAssistants(db, actor)).filter(
    (bot) => bot.connected || (bot.collected && bot.accessible),
  );
  const results: {
    assistantId: string;
    assistantTitle: string;
    items: Awaited<ReturnType<typeof searchKnowledgeAssistant>>["items"];
  }[] = [];
  for (const bot of bots) {
    try {
      const result = await searchKnowledgeAssistant(db, actor, bot.id, query);
      if (result.items.length)
        results.push({
          assistantId: bot.id,
          assistantTitle: bot.title,
          items: result.items,
        });
    } catch (error) {
      if (error instanceof AppError && [401, 403, 404].includes(error.status))
        continue;
      throw error;
    }
  }
  return { results, capability: "knowledge_search_only" };
}
