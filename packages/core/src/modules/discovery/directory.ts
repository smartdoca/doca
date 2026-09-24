import { sql } from "kysely";
import type { DB } from "../../../../db/src/index.js";
import { activeActor } from "../access/queries.js";
import type { Actor } from "../identity/passwords.js";
export type DirectoryMode = "all" | "related" | "none";
export async function directoryIds(
  db: DB,
  actor: Actor,
): Promise<Set<string> | null> {
  await activeActor(db, actor);
  const user = await db
    .selectFrom("users")
    .select("directory_mode")
    .where("id", "=", actor.id)
    .executeTakeFirstOrThrow();
  const settings = await db
    .selectFrom("settings")
    .select("directory_mode")
    .where("id", "=", "system")
    .executeTakeFirstOrThrow();
  // Per-user overrides are administrator policy, never a self-service privacy bypass.
  const mode = user.directory_mode ?? settings.directory_mode ?? "all";
  if (mode === "all") return null;
  if (mode === "none") return new Set();
  const rows = await sql<{ id: string }>`with recursive
    memberships as (
      select g.resource_id, g.user_id from grants g where g.status = 'active'
    ),
    owned_nodes as (
      select r.* from resources r where r.owner_id = ${actor.id}
      union select r.* from resources r join memberships m on m.resource_id = r.id where m.user_id = ${actor.id}
      union select r.* from resources r join resources l on r.library_id = l.id where l.owner_id = ${actor.id}
    ),
    descendants as (
      select * from owned_nodes
      union select c.* from resources c join descendants p on coalesce(c.parent_id, c.library_id) = p.id where c.access_mode = 'inherit'
    ),
    nodes as (
      select * from descendants
      union select p.* from resources p join nodes c on p.id = coalesce(c.parent_id, c.library_id) where c.access_mode = 'inherit'
    ),
    live as (select n.* from nodes n where n.deleted_at is null and not exists(select 1 from resources l where l.id = n.library_id and l.deleted_at is not null)),
    participants as (
      select n.owner_id as id from live n
      union select l.owner_id from live n join resources l on l.id = n.library_id
      union select m.user_id from memberships m join live n on n.id = m.resource_id
    ) select u.id from users u join participants p on p.id = u.id where u.status = 'active'`.execute(
    db,
  );
  return new Set(rows.rows.map((r) => r.id));
}
