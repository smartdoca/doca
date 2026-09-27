import type { DB, Schema } from "@db/index.js";
import type { Transaction } from "kysely";
import type { PublicResourceKind } from "../deployment/policies.js";

/** Personal search additions. Never changes grants, invitations or connection preferences. */
export async function setCollection(
  db: DB | Transaction<Schema>,
  userId: string,
  kind: PublicResourceKind,
  resourceId: string,
  collected: boolean,
) {
  if (!collected) {
    await db
      .deleteFrom("resource_collections")
      .where("user_id", "=", userId)
      .where("resource_kind", "=", kind)
      .where("resource_id", "=", resourceId)
      .execute();
    return { collected: false };
  }
  await db
    .insertInto("resource_collections")
    .values({
      user_id: userId,
      resource_kind: kind,
      resource_id: resourceId,
      created_at: new Date().toISOString(),
    })
    .onConflict((oc) =>
      oc.columns(["user_id", "resource_kind", "resource_id"]).doNothing(),
    )
    .execute();
  return { collected: true };
}
