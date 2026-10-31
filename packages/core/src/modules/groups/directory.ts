import { sql, type RawBuilder } from "kysely";
import { transact } from "@db/transactions.js";
import { securityAudit } from "../identity/accounts.js";
import type { DB } from "@db/index.js";
import type { Actor } from "../identity/passwords.js";
import { activeActor, accessibleQuery } from "../access/queries.js";
import { folderGroupRank } from "./access.js";
import { groupError } from "./service.js";
import {
  cursorFingerprint,
  decodePageCursor,
  encodePageCursor,
} from "../../shared/cursor.js";

export type GroupDirectoryMode = "member" | "related" | "all";

export async function readGroupDirectoryPolicy(db: DB, actor: Actor) {
  await activeActor(db, actor);
  const rows = await db
    .selectFrom("group_directory_policies")
    .selectAll()
    .where("id", "in", ["system", actor.id])
    .execute();
  const site = rows.find((row) => row.id === "system"),
    user = rows.find((row) => row.id === actor.id);
  if (!site || !site.mode) return groupError(409, "conflict");
  return {
    mode: user?.mode ?? site.mode,
    revision: `${site.revision}:${user?.revision ?? 0}`,
  };
}

export async function validateGroupSelection(
  db: DB,
  actor: Actor,
  groupId: string,
) {
  const policy = await readGroupDirectoryPolicy(db, actor);
  const group = await db
    .selectFrom("user_groups as g")
    .select("g.id")
    .where("g.id", "=", groupId)
    .where("g.dissolved_at", "is", null)
    .where(groupVisibility(sql.ref("g.id"), actor, policy.mode))
    .executeTakeFirst();
  if (!group) return groupError(403, "scope");
}

export async function updateGroupDirectoryPolicy(
  db: DB,
  actor: Actor,
  id: string,
  input: { mode: GroupDirectoryMode | null; revision: number },
) {
  return transact(db, async (tx) => {
    const administrator = await tx
      .selectFrom("users")
      .select(["status", "admin"])
      .where("id", "=", actor.id)
      .executeTakeFirst();
    if (
      !actor.admin ||
      !administrator?.admin ||
      administrator.status !== "active"
    )
      return groupError(403, "forbidden");
    if (
      (id === "system" && !input.mode) ||
      (input.mode !== null &&
        !["member", "related", "all"].includes(input.mode))
    )
      return groupError(400, "invalid");
    if (
      id !== "system" &&
      !(await tx
        .selectFrom("users")
        .select("id")
        .where("id", "=", id)
        .executeTakeFirst())
    )
      return groupError(404, "unavailable");
    const current = await tx
      .selectFrom("group_directory_policies")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (
      (!current && id === "system") ||
      (current?.revision ?? 0) !== input.revision
    )
      return groupError(409, "conflict");
    const row = {
      id,
      user_id: id === "system" ? null : id,
      mode: input.mode,
      revision: input.revision + 1,
    };
    if (current)
      await tx
        .updateTable("group_directory_policies")
        .set(row)
        .where("id", "=", id)
        .where("revision", "=", input.revision)
        .execute();
    else await tx.insertInto("group_directory_policies").values(row).execute();
    await securityAudit(
      tx,
      actor.id,
      id === "system" ? null : id,
      "group.directory_policy_updated",
      { mode: input.mode, revision: row.revision },
    );
    return { mode: row.mode, revision: row.revision };
  });
}

/** Group discovery exposes group metadata, never another group's roster. Public access is excluded. */
export function groupVisibility(
  groupId: RawBuilder<unknown>,
  actor: Actor,
  mode: GroupDirectoryMode,
) {
  if (mode === "all") return sql<boolean>`true`;
  const own = sql<boolean>`exists(select 1 from user_group_members own where own.group_id=${groupId} and own.user_id=${actor.id})`;
  if (mode === "member") return own;
  return sql<boolean>`(${own} or exists(with recursive paths as (
    select r.id, gg.role, gg.include_descendants, 0 as depth from resource_group_grants gg join resources r on r.id=gg.resource_id
      where gg.group_id=${groupId} and gg.status='active' and r.deleted_at is null
    union all select child.id, p.role, p.include_descendants, p.depth+1 from resources child join paths p on coalesce(child.parent_id,child.library_id)=p.id
      where p.include_descendants=1 and child.access_mode='inherit' and child.deleted_at is null and p.depth<1000
      and not exists(select 1 from resource_group_grants boundary where boundary.group_id=${groupId} and boundary.resource_id=child.id)
  ), audience as (
    select id from paths
    union select child.id from resource_group_grants gg join resources lib on lib.id=gg.resource_id join resources child on child.library_id=lib.id
      where gg.group_id=${groupId} and gg.status='active' and gg.role='manager' and lib.kind='library' and lib.deleted_at is null and child.deleted_at is null
  ) select 1 from audience shared_resource where ${accessibleQuery(sql.ref("shared_resource.id"), actor, 1, false, false)})
  or exists(with recursive folders as (
    select f.id, f.id as root_id, 0 as depth from file_folder_group_grants gg join file_folders f on f.id=gg.folder_id
      where gg.group_id=${groupId} and f.parent_id='shared' and f.deleted_at is null
    union all select child.id,p.root_id,p.depth+1 from file_folders child join folders p on child.parent_id=p.id where child.deleted_at is null and p.depth<1000
  ) select 1 from folders path join file_folders shared_folder on shared_folder.id=path.id where shared_folder.owner_id=${actor.id}
    or exists(select 1 from file_folder_shares share where share.folder_id=path.root_id and share.user_id=${actor.id})
    or ${folderGroupRank(sql.ref("path.root_id"), actor.id)}>0))`;
}

export async function searchGroupDirectory(
  db: DB,
  actor: Actor,
  policy: { mode: GroupDirectoryMode; revision: string },
  input: { query: string; cursor?: string; limit?: number },
) {
  await activeActor(db, actor);
  const limit = input.limit ?? 20,
    queryText = input.query.trim();
  if (
    queryText.length > 160 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    (input.cursor?.length ?? 0) > 2048
  )
    return groupError(400, "invalid");
  const fingerprint = cursorFingerprint({
    groupDirectory: 1,
    userId: actor.id,
    ...policy,
    query: queryText,
  });
  const cursor = input.cursor
    ? decodePageCursor(input.cursor, fingerprint)
    : null;
  const pattern = `%${queryText.toLowerCase().replaceAll("!", "!!").replaceAll("%", "!%").replaceAll("_", "!_")}%`;
  let query = db
    .selectFrom("user_groups as g")
    .innerJoin("users as owner", "owner.id", "g.owner_id")
    .select(["g.id", "g.name", "g.avatar", "owner.display_name as ownerName"])
    .where("g.dissolved_at", "is", null)
    .where(groupVisibility(sql.ref("g.id"), actor, policy.mode))
    .where(sql<boolean>`lower(g.name) like ${pattern} escape '!'`);
  if (cursor)
    query = query.where((eb) =>
      eb.or([
        eb("g.name", ">", cursor.value),
        eb.and([eb("g.name", "=", cursor.value), eb("g.id", ">", cursor.id)]),
      ]),
    );
  const rows = await query
    .orderBy("g.name")
    .orderBy("g.id")
    .limit(limit + 1)
    .execute();
  const last = rows[limit - 1];
  return {
    items: rows.slice(0, limit),
    mode: policy.mode,
    nextCursor:
      rows.length > limit && last
        ? encodePageCursor(fingerprint, last.name, last.id)
        : null,
  };
}
