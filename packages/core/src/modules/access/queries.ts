import { policyFields, type PolicyField } from "./inheritance.js";
import { effectiveResource } from "../access/inheritance.js";
import { sql, type RawBuilder, type Transaction } from "kysely";
import type { DB, Resource, Schema } from "../../../../db/src/index.js";
import { fail } from "../../shared/errors.js";
import type { Actor } from "../identity/passwords.js";
import { effectiveGrants } from "./grants.js";
import {
  canRemoveResource,
  actionMinimum,
  label,
  permission,
  type Action,
} from "./policy.js";

/** Correlated SQL predicate: ancestor traversal is bounded by the candidate's tree. */
export function roleQuery(
  resourceId: RawBuilder<unknown>,
  actor: Actor | null,
  includePublic = true,
): RawBuilder<number> {
  const userId = actor?.id ?? "";
  return sql<number>`(with recursive ancestry as (
    select a.*, 0 as depth from resources a where a.id = ${resourceId}
    union all
    select p.*, a.depth + 1 from resources p join ancestry a on p.id = coalesce(a.parent_id, a.library_id)
      where a.access_mode = 'inherit' and a.depth < 1000
  ), boundaries as (
    select min(a.depth) as depth
      from grants g join ancestry a on a.id = g.resource_id
      where g.user_id = ${userId} and g.source_type = 'parent_override'
  ), decisions as (
    select a.depth, case when a.depth = 0 or a.kind = 'library' then 5 else 4 end as rank from ancestry a where a.owner_id = ${userId}
    union all
    select 0 as depth, 5 as rank
      from resources target
      join resources library_owner on library_owner.id = target.library_id
      where target.id = ${resourceId} and library_owner.owner_id = ${userId}
    union all
    select a.depth, case
      when g.status = 'disabled' then 0
      when a.depth > 0 and g.include_descendants = 0 then 0
      else case g.role when 'manager' then 4 when 'editor' then 3 when 'commenter' then 2 else 1 end
    end
      from grants g join ancestry a on a.id = g.resource_id
      where g.user_id = ${userId}
        and ((select depth from boundaries) is null
          or a.depth <= (select depth from boundaries))
  ), openness as (
    select
      (select a.visibility from ancestry a where a.access_mode = 'custom' or (a.permission_overrides & 1) <> 0 or (a.parent_id is null and a.library_id is null) order by a.depth limit 1) as visibility,
      (select a.public_role from ancestry a where a.access_mode = 'custom' or (a.permission_overrides & 2) <> 0 or (a.parent_id is null and a.library_id is null) order by a.depth limit 1) as public_role
  ) select coalesce(max(effective.rank), 0) from (
    select rank from decisions where depth = (select min(depth) from decisions)
    union all
    select 4 as rank from resources target join grants library_manager on library_manager.resource_id = target.library_id
      where target.id = ${resourceId} and library_manager.user_id = ${userId}
      and library_manager.role = 'manager' and library_manager.status = 'active'
    union all
    select case when ${actor ? 1 : 0} = 0 then 1 when public_role = 'editor' then 3 when public_role = 'commenter' then 2 else 1 end from openness
      where ${includePublic ? 1 : 0} = 1 and (${policyFieldQuery(resourceId, "visibility")} = 'public' or (${policyFieldQuery(resourceId, "visibility")} = 'authenticated' and ${actor ? 1 : 0} = 1))
  ) effective)`;
}

/** Field-level inheritance uses the same path and override bits as point authorization. */
export function policyFieldQuery(
  resourceId: RawBuilder<unknown>,
  field: PolicyField,
): RawBuilder<any> {
  const inherited = sql`(select l.visibility from resources target join resources l on l.id = target.library_id where target.id = ${resourceId} and l.visibility in ('public', 'authenticated'))`;
  const original = sql`(with recursive settings_path as (
    select policy_root.*, 0 as depth from resources policy_root where policy_root.id = ${resourceId}
    union all select p.*, a.depth + 1 from resources p join settings_path a on p.id = coalesce(a.parent_id, a.library_id)
      where a.access_mode = 'inherit' and (a.permission_overrides & ${policyFields[field]}) = 0 and a.depth < 1000
  ) select ${sql.ref(field)} from settings_path order by depth desc limit 1)`;
  return field === "visibility"
    ? sql`coalesce(${inherited}, ${original})`
    : original;
}

export function accessibleQuery(
  id: RawBuilder<unknown>,
  actor: Actor | null,
  minimum = 1,
  trash = false,
  includePublic = true,
) {
  return sql<boolean>`exists(select 1 from resources authorized where authorized.id = ${id}
    ${trash ? sql`` : sql`and authorized.deleted_at is null and not exists(select 1 from resources l where l.id = authorized.library_id and l.deleted_at is not null)`}
    and ${roleQuery(sql.ref("authorized.id"), actor, includePublic)} >= ${minimum})`;
}

export async function activeActor(
  db: DB | Transaction<Schema>,
  actor: Actor | null,
) {
  if (!actor) return;
  const user = await db
    .selectFrom("users")
    .select("status")
    .where("id", "=", actor.id)
    .executeTakeFirst();
  if (user?.status !== "active") fail(401, "登录已失效");
}

export async function loadResources(
  db: DB | Transaction<Schema>,
  ids: readonly (string | null | undefined)[],
  subtrees: readonly string[] = [],
) {
  const resources = new Map<string, Resource>();
  if (subtrees.length) {
    const result = await sql<Resource>`with recursive subtree as (
      select r.* from resources r where r.id in (${sql.join(subtrees.map((id) => sql`${id}`))})
      union
      select r.* from resources r join subtree p on r.parent_id = p.id or r.library_id = p.id
    ) select * from subtree`.execute(db);
    for (const r of result.rows) resources.set(r.id, r);
  }
  let pending = [
    ...new Set([
      ...ids.filter((id): id is string => !!id),
      ...[...resources.values()]
        .flatMap((r) => [r.parent_id, r.library_id])
        .filter((id): id is string => !!id),
    ]),
  ];
  const visited = new Set(resources.keys());
  while (pending.length) {
    const batch = pending.filter((id) => !visited.has(id));
    if (!batch.length) break;
    pending = [];
    for (let offset = 0; offset < batch.length; offset += 300) {
      const keys = batch.slice(offset, offset + 300);
      keys.forEach((id) => visited.add(id));
      for (const r of await db
        .selectFrom("resources")
        .selectAll()
        .where("id", "in", keys)
        .execute()) {
        resources.set(r.id, r);
        if (r.parent_id) pending.push(r.parent_id);
        if (r.library_id) pending.push(r.library_id);
      }
    }
  }
  return [...resources.values()];
}

export async function accessContext(
  db: DB | Transaction<Schema>,
  actor: Actor | null,
  ids: readonly (string | null | undefined)[],
  subtrees: readonly string[] = [],
) {
  await activeActor(db, actor);
  const resources = await loadResources(db, ids, subtrees);
  return {
    resources,
    grants: await effectiveGrants(
      db,
      resources.map((r) => r.id),
    ),
    actor,
  };
}

export async function authorize(
  db: DB | Transaction<Schema>,
  actor: Actor | null,
  id: string,
  minimum: number | Action = "read_content",
  trash = false,
) {
  const ctx = await accessContext(db, actor, [id]);
  const resource = ctx.resources.find((r) => r.id === id);
  const rank = resource
    ? permission(resource, actor, ctx.resources, ctx.grants)
    : 0;
  if (
    !resource ||
    !rank ||
    (!trash &&
      (resource.deleted_at ||
        ctx.resources.find((r) => r.id === resource.library_id)?.deleted_at))
  )
    fail(404, "资源不存在或无权访问");
  if (
    !(
      (minimum === "trash" || minimum === "purge") &&
      canRemoveResource(resource, actor, ctx.resources, ctx.grants)
    ) &&
    rank <
      (typeof minimum === "number"
        ? minimum
        : actionMinimum(effectiveResource(resource, ctx.resources), minimum))
  )
    fail(403, "没有执行此操作的权限");
  return { resource, rank, ...ctx };
}

export function projectResource(
  resource: Resource,
  actor: Actor | null,
  resources: Resource[],
  grants: Awaited<ReturnType<typeof effectiveGrants>>,
  managerInfoVisible = false,
) {
  const visible = (id: string | null) => {
    const r = resources.find((r) => r.id === id);
    return r && !r.deleted_at && permission(r, actor, resources, grants) > 0
      ? id
      : null;
  };
  return {
    ...resource,
    visibility:
      resource.visibility === "invited" && resource.requests_enabled
        ? ("requestable" as const)
        : resource.visibility,
    owner_id:
      managerInfoVisible || permission(resource, actor, resources, grants) >= 4
        ? resource.owner_id
        : "",
    parent_id: visible(resource.parent_id),
    library_id: visible(resource.library_id),
    role: label(permission(resource, actor, resources, grants)),
    can_remove: canRemoveResource(resource, actor, resources, grants),
  };
}
