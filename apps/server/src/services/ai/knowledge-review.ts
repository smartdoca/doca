import type { DB } from "@db/index.js";
import type { Actor } from "@core/modules/identity/passwords.js";
import { knowledgeManagementView, knowledgeEntries, knowledgeHumanChanges, knowledgeRunHistory } from "@core/modules/knowledge/system.js";
import { listKnowledgeSubscriptions } from "@core/modules/knowledge/subscriptions.js";

/** Read-only review evidence; source bodies and foreign private links are never read. */
export async function knowledgeReviewSnapshot(db: DB, actor: Actor, libraryId: string) {
  const instructions = await knowledgeManagementView(db, actor, libraryId);
  const [sources, entries, humanChanges, runs] = await Promise.all([
    listKnowledgeSubscriptions(db, actor, libraryId, { refreshStatus: false }),
    knowledgeEntries(db, actor, libraryId),
    knowledgeHumanChanges(db, actor, libraryId),
    knowledgeRunHistory(db, actor, libraryId),
  ]);
  return { kind: "knowledge_library", instructions, instructionStatus: instructions.files.map(file => ({ path: file.path, configured: file.revision > 0, state: file.revision > 0 ? "saved" : "placeholder_not_authored" })), sources, entries, humanChanges, runs };
}
