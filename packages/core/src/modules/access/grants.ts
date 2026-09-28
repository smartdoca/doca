import type { Transaction } from "kysely";
import type { DB, Schema } from "../../../../db/src/index.js";
import type { Grant } from "./policy.js";
/** All callers must specify a resource scope; invitations never grant access. */
export async function effectiveGrants(
  db: DB | Transaction<Schema>,
  resourceIds: readonly string[],
  userId?: string,
): Promise<Grant[]> {
  const grants: Grant[] = [];
  for (let offset = 0; offset < resourceIds.length; offset += 300) {
    const ids = resourceIds.slice(offset, offset + 300);
    const records = await db
      .selectFrom("grants")
      .selectAll()
      .where("resource_id", "in", ids)
      .$if(!!userId, (q) => q.where("user_id", "=", userId!))
      .execute();
    grants.push(
      ...records.map((g) => ({
        ...g,
        role: g.role ?? "reader",
        source:
          g.source_type === "link"
            ? "link"
            : g.source_type === "parent_override"
              ? "parent_override"
              : "invitation",
        blocked: g.status === "disabled",
      })),
    );
  }
  return grants;
}
