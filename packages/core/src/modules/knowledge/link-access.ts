import type { DB } from "@db/index.js";
// Accepted link membership survives pausing/expiry; revocation removes it.
export async function knowledgeLinkMemberships(
  db: DB,
  botId: string,
  userId?: string,
) {
  let query = db
    .selectFrom("knowledge_bot_link_members as m")
    .innerJoin("knowledge_bot_share_links as l", "l.id", "m.link_id")
    .select(["m.user_id", "m.link_id"])
    .where("l.bot_id", "=", botId)
    .where("l.revoked_at", "is", null);
  if (userId) query = query.where("m.user_id", "=", userId);
  return query.execute();
}
