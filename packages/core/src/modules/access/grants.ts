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
    const groupRows = await db.selectFrom("resource_group_grants as grant")
      .innerJoin("user_groups as group", "group.id", "grant.group_id")
      .selectAll("grant").select(["group.name as group_name", "group.avatar as group_avatar"])
      .where("grant.resource_id", "in", ids).where("group.dissolved_at", "is", null).execute();
    const groupIds = [...new Set(groupRows.map(g => g.group_id))];
    const members = groupIds.length ? await db.selectFrom("user_group_members as member")
      .innerJoin("users as user", "user.id", "member.user_id")
      .select(["member.group_id", "member.user_id"]).where("member.group_id", "in", groupIds)
      .where("user.status", "=", "active").$if(!!userId, q => q.where("member.user_id", "=", userId!)).execute() : [];
    for (const row of groupRows) grants.push({
      ...row, user_id: "", source_type: "direct", source: "group", groupId: row.group_id, groupName: row.group_name, groupAvatar: row.group_avatar,
      memberIds: members.filter(m => m.group_id === row.group_id).map(m => m.user_id), blocked: row.status === "disabled",
    });
  }
  return grants;
}
