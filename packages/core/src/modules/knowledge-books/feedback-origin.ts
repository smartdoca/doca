import { createHash } from "node:crypto";
import type { DB } from "@db/index.js";
import type { Actor } from "../identity/passwords.js";
import { bookFail as fail } from "./errors.js";
export type BookFeedbackMethod = "manual" | "assistant";
function auditId(id: string, revision: number, method: BookFeedbackMethod) {
  const hash = createHash("sha256")
    .update(JSON.stringify(["book-feedback", id, revision, method]))
    .digest("hex")
    .slice(0, 32);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20)}`;
}
export async function recordFeedbackOrigin(
  db: DB,
  actor: Actor,
  bookId: string,
  id: string,
  revision: number,
  method: BookFeedbackMethod,
) {
  await db
    .insertInto("audit_events")
    .values({
      id: auditId(id, revision, method),
      actor_id: actor.id,
      resource_id: bookId,
      action: `knowledge_book.feedback_${method}`,
      created_at: new Date().toISOString(),
    })
    .execute();
}
export async function readFeedbackOrigin(db: DB, id: string, revision: number) {
  for (const method of ["manual", "assistant"] as const) {
    const row = await db
      .selectFrom("audit_events")
      .select(["actor_id", "created_at", "action"])
      .where("id", "=", auditId(id, revision, method))
      .executeTakeFirst();
    if (row && row.action === `knowledge_book.feedback_${method}`)
      return { method, actorId: row.actor_id, createdAt: row.created_at };
  }
  fail(409, "Feedback provenance record is missing");
}
