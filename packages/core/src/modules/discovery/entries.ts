import type { Transaction } from "kysely";
import type { DB, Schema } from "../../../../db/src/index.js";
import { authorize } from "../access/queries.js";
import type { Actor } from "../identity/passwords.js";

/** Explicit choices are durable. Automatic joins never override an explicit hide. */
export async function setEntry(
  db: DB | Transaction<Schema>,
  actor: Actor,
  resourceId: string,
  state: "joined" | "hidden",
  source = "manual",
) {
  await authorize(db, actor, resourceId);
  const old = await db
    .selectFrom("resource_entries")
    .selectAll()
    .where("user_id", "=", actor.id)
    .where("resource_id", "=", resourceId)
    .executeTakeFirst();
  if (source !== "manual" && old) return old;
  const row = {
    user_id: actor.id,
    resource_id: resourceId,
    state,
    source,
    version: (old?.version ?? 0) + 1,
    updated_at: new Date().toISOString(),
  };
  await db
    .insertInto("resource_entries")
    .values(row)
    .onConflict((oc) => oc.columns(["user_id", "resource_id"]).doUpdateSet(row))
    .execute();
  return row;
}
