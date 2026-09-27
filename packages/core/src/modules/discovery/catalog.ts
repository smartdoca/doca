import { sql } from "kysely";
import type { DB } from "@db/index.js";
import type { Actor } from "../identity/passwords.js";
import {
  activeActor,
  authorize,
  accessibleQuery,
  policyFieldQuery,
} from "../access/queries.js";
import { authorizeFileFolder } from "../access/file-access.js";
import {
  distributionPolicy,
  publicMode,
  publicResourceKinds,
  type PublicResourceKind,
} from "../deployment/policies.js";
import { setCollection } from "./collections.js";
import { knowledgeAssistantAccess } from "../knowledge/system.js";
import { fail } from "../../shared/errors.js";

export async function catalogPage(
  db: DB,
  actor: Actor,
  input: {
    kind?: PublicResourceKind;
    collected?: boolean;
    q?: string;
    offset?: number;
  },
) {
  await activeActor(db, actor);
  const policy = await distributionPolicy(db);
  const kinds = publicResourceKinds.filter(
    (kind) =>
      (!input.kind || input.kind === kind) &&
      (input.collected || publicMode(policy, kind) !== "link"),
  );
  if (!kinds.length) return { items: [], total: 0, nextOffset: null };
  const pattern = `%${(input.q ?? "").trim().toLowerCase().replaceAll("!", "!!").replaceAll("%", "!%").replaceAll("_", "!_")}%`;
  const queries = kinds.map((kind) => {
    if (kind === "document" || kind === "library")
      return sql`
      select r.id, r.title, r.kind, r.updated_at,
        case when e.resource_id is not null then 1 else 0 end as collected
      from resources r left join resource_collections e on e.resource_id = r.id and e.resource_kind = r.kind and e.user_id = ${actor.id}
      where r.kind = ${kind} and ${accessibleQuery(sql.ref("r.id"), actor)}
        and lower(r.title) like ${pattern} escape '!'
        and ${input.collected ? sql`e.resource_id is not null` : sql`r.library_id is null and ${policyFieldQuery(sql.ref("r.id"), "visibility")} in ('public','authenticated')`}`;
    if (kind === "assistant")
      return sql`
      select b.id, b.title, 'assistant' as kind, b.updated_at,
        case when u.resource_id is not null then 1 else 0 end as collected
      from knowledge_assistants b left join resource_collections u on u.resource_id = b.id and u.resource_kind = 'assistant' and u.user_id = ${actor.id}
      where b.enabled = 1 and ${
        input.collected
          ? sql`(b.visibility in ('public','authenticated') or b.owner_id=${actor.id}
        or coalesce(b.manager_ids,'[]') like ${'%"' + actor.id + '"%'}
        or (b.member_ids like ${'%"' + actor.id + '"%'} and (${policy.grantMode === "direct" ? 1 : 0}=1 or exists(select 1 from knowledge_assistant_users accepted where accepted.assistant_id=b.id and accepted.user_id=${actor.id} and accepted.accepted=1))))`
          : sql`b.visibility in ('public','authenticated')`
      }
        and lower(b.title) like ${pattern} escape '!'
        ${input.collected ? sql`and u.resource_id is not null` : sql``}`;
    return sql`
      select f.id, f.name as title, 'folder' as kind, f.updated_at,
        case when e.resource_id is not null then 1 else 0 end as collected
      from file_folders f left join folder_publications p on p.folder_id = f.id and p.enabled = 1
      left join resource_collections e on e.resource_id = f.id and e.resource_kind = 'folder' and e.user_id = ${actor.id}
      where f.deleted_at is null and lower(f.name) like ${pattern} escape '!'
        and not exists(with recursive parents as (
          select a.id,a.parent_id,a.deleted_at,0 as depth from file_folders a where a.id = f.id
          union all select a.id,a.parent_id,a.deleted_at,p.depth+1 from file_folders a join parents p on a.id=p.parent_id where p.depth<1000
        ) select 1 from parents where deleted_at is not null)
        ${
          input.collected
            ? sql`and e.resource_id is not null and (f.owner_id=${actor.id} or exists(with recursive ancestors as (
          select a.id,a.parent_id,0 as depth from file_folders a where a.id=f.id
          union all select a.id,a.parent_id,p.depth+1 from file_folders a join ancestors p on a.id=p.parent_id where p.depth<1000
        ) select 1 from ancestors a where exists(select 1 from folder_publications pub where pub.folder_id=a.id and pub.enabled=1)
          or (a.parent_id='shared' and exists(select 1 from file_folder_shares share where share.folder_id=a.id and share.user_id=${actor.id}))))`
            : sql`and p.folder_id is not null`
        }`;
  });
  const union = sql.join(queries, sql` union all `);
  const total = await sql<{
    n: number;
  }>`select count(*) as n from (${union}) catalog`.execute(db);
  const offset = input.offset ?? 0;
  const rows = await sql<{
    id: string;
    title: string;
    kind: PublicResourceKind;
    updated_at: string;
    collected: number;
  }>`select * from (${union}) catalog order by updated_at desc, kind, id limit 51 offset ${offset}`.execute(
    db,
  );
  return {
    items: rows.rows
      .slice(0, 50)
      .map((r) => ({ ...r, collected: !!r.collected })),
    total: Number(total.rows[0]!.n),
    nextOffset: rows.rows.length > 50 ? offset + 50 : null,
  };
}

export async function collectPublicResource(
  db: DB,
  actor: Actor,
  kind: PublicResourceKind,
  id: string,
  collected: boolean,
) {
  await activeActor(db, actor);
  // Removing a saved reference is allowed even after its access has been revoked.
  if (!collected) return setCollection(db, actor.id, kind, id, false);
  if (kind === "document" || kind === "library") {
    const { resource } = await authorize(db, actor, id);
    if (resource.kind !== kind) fail(404, "资源不存在");
  } else if (kind === "assistant") {
    const bot = await db
      .selectFrom("knowledge_assistants")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!bot || !(await knowledgeAssistantAccess(db, actor, bot)).accessible)
      fail(404, "问答不存在");
  } else await authorizeFileFolder(db, actor, id);
  return setCollection(db, actor.id, kind, id, true);
}

/** A collected folder covers future descendants without copying membership rows. */
export async function folderInSearch(
  db: DB,
  actor: Actor,
  id: string,
  scope = "all",
) {
  const { folder } = await authorizeFileFolder(db, actor, id);
  if (folder.owner_id === actor.id && scope !== "public") return true;
  const policy = await distributionPolicy(db);
  const rows = await sql<{ id: string }>`with recursive ancestors as (
    select id,parent_id,0 as depth from file_folders where id=${id}
    union all select f.id,f.parent_id,a.depth+1 from file_folders f join ancestors a on f.id=a.parent_id where a.depth<1000
  ) select id from ancestors a where
    (${scope === "public" ? 0 : 1}=1 and (exists(select 1 from resource_collections e where e.resource_kind='folder' and e.resource_id=a.id and e.user_id=${actor.id})
    or exists(select 1 from file_folder_shares s where s.folder_id=a.id and s.user_id=${actor.id})))
    or (${scope !== "personal" && publicMode(policy, "folder") === "search" ? 1 : 0}=1 and exists(select 1 from folder_publications p where p.folder_id=a.id and p.enabled=1))`.execute(
    db,
  );
  return rows.rows.length > 0;
}
