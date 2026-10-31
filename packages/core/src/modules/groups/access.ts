import { sql, type RawBuilder } from "kysely";
import type { DB } from "@db/index.js";

export function folderGroupRank(folderId: RawBuilder<unknown>, userId: string) {
  return sql<number>`coalesce((select max(case gg.role when 'admin' then 3 else 1 end) from file_folder_group_grants gg
    join user_groups ug on ug.id=gg.group_id and ug.dissolved_at is null
    join user_group_members gm on gm.group_id=ug.id and gm.user_id=${userId}
    join users gu on gu.id=gm.user_id and gu.status='active' where gg.folder_id=${folderId}),0)`;
}
export async function groupMemberIds(db: DB, groupId: string) {
  return (
    await db
      .selectFrom("user_group_members as member")
      .innerJoin("users as user", "user.id", "member.user_id")
      .select("member.user_id")
      .where("member.group_id", "=", groupId)
      .where("user.status", "=", "active")
      .execute()
  ).map((m) => m.user_id);
}
