import { withContentDocumentAccess } from "../knowledge/content-access.js";
import { effectiveResource } from "../access/inheritance.js";
import type { Transaction } from "kysely";
import { randomUUID } from "node:crypto";
import type { DB, Resource, Schema } from "../../../../db/src/index.js";
import { transact } from "../../../../db/src/transactions.js";
import { fail } from "../../shared/errors.js";
import {
  actionMinimum,
  canRemoveResource,
  isResourceOwnerLike,
  label,
  permission,
  type Action,
  type Grant,
} from "../access/policy.js";
import { accessContext } from "../access/queries.js";
import { emitIntegrationEvent } from "../automation/events.js";
import type { Actor } from "../identity/passwords.js";
import { distributionPolicy, resourceDistribution, type Distribution } from "../deployment/policies.js";
import { notify } from "../interactions/community.js";
export function createResourceRunner(db: DB) {
  return async function run<T>(
    actor: Actor | null,
    ids: (string | null | undefined)[],
    subtreesOrFn: string[] | ((ctx: Context) => Promise<T>),
    maybeFn?: (ctx: Context) => Promise<T>,
  ) {
    const fn = typeof subtreesOrFn === "function" ? subtreesOrFn : maybeFn!;
    const subtrees = Array.isArray(subtreesOrFn) ? subtreesOrFn : [];
    return withContentDocumentAccess(db, actor, () => transact(db, async (tx) => {
      const ctx: Context = {
        tx,
        distribution: await distributionPolicy(tx),
        ...(await accessContext(tx, actor, ids, subtrees)),
      };
      return fn(ctx);
    }), [...ids,...subtrees].filter((id):id is string=>!!id));
  };
}
export interface Context {
  tx: Transaction<Schema>;
  resources: Resource[];
  grants: Grant[];
  actor: Actor | null;
  managerInfoVisible?: boolean;
  distribution?: Distribution;
}
export function get(
  ctx: Context,
  id: string,
  minimum: number | Action,
  trash = false,
) {
  const r = ctx.resources.find((x) => x.id === id);
  if (!r || permission(r, ctx.actor, ctx.resources, ctx.grants) < 1)
    fail(404, "内容不存在或无权访问");
  if (
    !trash &&
    (r.deleted_at ||
      ctx.resources.find((x) => x.id === r.library_id)?.deleted_at)
  )
    fail(404, "内容不存在或无权访问");
  if (
    !((minimum === "trash" || minimum === "purge") && canRemoveResource(r, ctx.actor, ctx.resources, ctx.grants)) &&
    permission(r, ctx.actor, ctx.resources, ctx.grants) <
    (typeof minimum === "number" ? minimum : actionMinimum(effectiveResource(r, ctx.resources), minimum))
  )
    fail(403, "没有执行此操作的权限");
  return r;
}
export function project(ctx: Context, r: Resource) {
  const visible = (id: string | null) =>
    id &&
    ctx.resources.some(
      (x) =>
        x.id === id &&
        !x.deleted_at &&
        permission(x, ctx.actor, ctx.resources, ctx.grants) > 0,
    )
      ? id
      : null;
  return {
    ...r,
    visibility:
      r.visibility === "invited" && r.requests_enabled
        ? ("requestable" as const)
        : r.visibility,
    owner_id:
      (ctx.distribution ? resourceDistribution(ctx.distribution,r.kind).managerInfoVisible : ctx.managerInfoVisible) ||
      permission(r, ctx.actor, ctx.resources, ctx.grants) >= 4
        ? r.owner_id
        : "",
    parent_id: visible(r.parent_id),
    library_id: visible(r.library_id),
    role: label(permission(r, ctx.actor, ctx.resources, ctx.grants)),
    can_remove: canRemoveResource(r, ctx.actor, ctx.resources, ctx.grants),
  };
}
export function clean(value: string) {
  const t = value.trim();
  if (!t || t.length > 160) fail(400, "名称需为1–160字");
  return t;
}
export function check(r: Resource, version: number) {
  if (r.version !== version) fail(409, "内容已被修改，请刷新后重试");
}
export async function nextTreeOrder(
  ctx: Context,
  parentId: string | null,
  libraryId: string | null,
) {
  const row = await ctx.tx
    .selectFrom("resources")
    .select((eb) => eb.fn.max<number>("tree_order").as("last"))
    .where("parent_id", parentId ? "=" : "is", parentId)
    .where("library_id", libraryId ? "=" : "is", libraryId)
    .$if(!parentId && !libraryId, (q) =>
      q.where("owner_id", "=", ctx.actor!.id),
    )
    .executeTakeFirst();
  return Number(row?.last ?? -1) + 1;
}
export async function update(
  ctx: Context,
  r: Resource,
  value: Partial<Resource>,
) {
  await ctx.tx
    .updateTable("resources")
    .set({
      ...value,
      ...([
        "owner_id",
        "parent_id",
        "library_id",
        "access_mode",
        "visibility",
        "deleted_at",
      ].some((key) => Object.hasOwn(value, key))
        ? { authz_revision: (r.authz_revision ?? 1) + 1 }
        : {}),
      ...(value.title !== undefined && ctx.actor
        ? {
            last_editor_id: ctx.actor.id,
            last_edited_at: new Date().toISOString(),
          }
        : {}),
      version: r.version + 1,
      updated_at: new Date().toISOString(),
    })
    .where("id", "=", r.id)
    .execute();
}
export function descendants(ctx: Context, r: Resource) {
  const ids = new Set([r.id]);
  if (r.kind === "library")
    for (const x of ctx.resources) if (x.library_id === r.id) ids.add(x.id);
  let changed = true;
  while (changed) {
    changed = false;
    for (const x of ctx.resources)
      if (x.parent_id && ids.has(x.parent_id) && !ids.has(x.id)) {
        ids.add(x.id);
        changed = true;
      }
  }
  return ctx.resources.filter((x) => ids.has(x.id));
}
export async function event(
  ctx: Context,
  r: Resource,
  action: string,
  recipients: string[] = [],
) {
  const now = new Date().toISOString();
  await ctx.tx
    .insertInto("audit_events")
    .values({
      id: randomUUID(),
      actor_id: ctx.actor!.id,
      resource_id: r.id,
      action,
      created_at: now,
    })
    .execute();
  await notify(ctx.tx, ctx.actor!, r, action, recipients);
  await emitIntegrationEvent(ctx.tx, action, {
    resourceId: r.id,
    actorId: ctx.actor!.id,
    kind: r.kind,
    path: `#/r/${r.id}`,
  });
}

/** Structural operations cannot silently promote/demote managers of another owner's resource. */
export function protectManagers(
  ctx: Context,
  affected: Resource[],
  simulated: Resource[],
) {
  const ids = new Set([
    ...ctx.resources.map((x) => x.owner_id),
    ...ctx.grants.filter((g) => g.role === "manager").map((g) => g.user_id),
  ]);
  for (const doc of affected)
    if (!isResourceOwnerLike(doc, ctx.actor, ctx.resources))
      for (const id of ids) {
        const user = { id, display_name: "", admin: 0 };
        const before = permission(doc, user, ctx.resources, ctx.grants),
          after = permission(
            simulated.find((x) => x.id === doc.id)!,
            user,
            simulated,
            ctx.grants,
          );
        if ((before >= 4 || after >= 4) && before !== after)
          fail(403, "结构变更会调整管理权限，需要文档所有者操作");
      }
}
