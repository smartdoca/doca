import type { DB } from "@db/index.js";
import { fail } from "../../shared/errors.js";
/** An activity ledger, never an authorization grant. */
export async function recordSessionResource(
  db: DB,
  userId: string,
  sessionId: string,
  resource: { id: string; kind: string; title: string; href: string },
) {
  const session = await db
    .selectFrom("ai_sessions")
    .select("id")
    .where("id", "=", sessionId)
    .where("user_id", "=", userId)
    .executeTakeFirst();
  if (!session) fail(404, "会话不存在");
  const row = {
    session_id: sessionId,
    kind: resource.kind,
    resource_id: resource.id,
    title: resource.title,
    href: resource.href,
    touched_at: new Date().toISOString(),
  };
  await db
    .insertInto("ai_session_resources")
    .values(row)
    .onConflict((oc) =>
      oc
        .columns(["session_id", "kind", "resource_id"])
        .doUpdateSet({
          title: row.title,
          href: row.href,
          touched_at: row.touched_at,
        }),
    )
    .execute();
}
export async function sessionResourceHistory(
  db: DB,
  userId: string,
  sessionId: string,
) {
  return db
    .selectFrom("ai_session_resources as r")
    .innerJoin("ai_sessions as s", "s.id", "r.session_id")
    .select([
      "r.resource_id as id",
      "r.kind",
      "r.title",
      "r.href",
      "r.touched_at",
    ])
    .where("s.user_id", "=", userId)
    .where("s.id", "=", sessionId)
    .where("r.kind", "!=", "assistant")
    .orderBy("r.touched_at", "desc")
    .execute();
}
