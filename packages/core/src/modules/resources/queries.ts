import { distributionBehavior } from "../access/distribution-behavior.js";
import { policyFieldQuery } from "../access/queries.js";
import { sql } from "kysely";
import { createHash } from "node:crypto";
import type { DB } from "../../../../db/src/index.js";
import { readSnapshot } from "../../../../db/src/transactions.js";
import { fail } from "../../shared/errors.js";
import {
  accessContext,
  accessibleQuery,
  authorize,
  projectResource,
} from "../access/queries.js";
import { permission } from "../access/policy.js";
import { distributionPolicy, resourceDistribution } from "../deployment/policies.js";
import type { Actor } from "../identity/passwords.js";
export type ResourceQuery = {
  scope?: string;
  kind?: string;
  q?: string;
  libraryId?: string;
  libraryIds?: string[];
  ownerIds?: string[];
  visitedWithinDays?: number;
  likedOnly?: boolean;
  favoritesOnly?: boolean;
  location?: "personal" | "library";
  offset?: number;
  format?: string;
  sort?: string;
  order?: string;
  matchedIds?: string[];
  parentId?: string;
  cursor?: string;
  includeAncestors?: boolean;
};
/** Personal entry intent is independent of the right to open a resource. */
export function entryQuery(
  id: ReturnType<typeof sql.ref>,
  userId: string,
  allowGranted = false,
  allowPublic = false,
) {
  return sql<boolean>`exists(select 1 from resources entry where entry.id = ${id}
    and not exists(select 1 from resource_entries hidden where hidden.resource_id = entry.id and hidden.user_id = ${userId} and hidden.state = 'hidden')
    and (entry.owner_id = ${userId}
      or exists(select 1 from resource_entries joined where joined.resource_id = entry.id and joined.user_id = ${userId} and joined.state = 'joined')
      or exists(select 1 from access_invitations invitation where invitation.resource_id = entry.id and invitation.user_id = ${userId} and invitation.state = 'accepted')
      ${allowGranted ? sql`or exists(select 1 from grants g where g.resource_id = entry.id and g.user_id = ${userId} and g.status = 'active')` : sql``}
      ${allowPublic ? sql`or (entry.kind = 'library' and entry.access_mode = 'custom' and entry.visibility in ('public', 'authenticated'))` : sql``}
    ))`;
}
export async function queryResourcePage(
  db: DB,
  actor: Actor,
  input: ResourceQuery,
) {
  return readSnapshot(db, async (tx) => {
    await accessContext(tx, actor, []);
    const policy = await distributionPolicy(tx);
    const libraryIds =
      input.libraryIds ?? (input.libraryId ? [input.libraryId] : []);
    if (input.location === "personal" && libraryIds.length)
      fail(400, "个人文档不能同时限定知识库");
    for (const id of libraryIds)
      if ((await authorize(tx, actor, id)).resource.kind !== "library")
        fail(400, "知识库筛选条件无效");
    if (input.parentId) await authorize(tx, actor, input.parentId);
    const visited = sql<
      string | null
    >`(select v.visited_at from resource_visits v where v.resource_id = r.id and v.user_id = ${actor.id})`;
    const pinStamp = sql<string>`coalesce((select pin.created_at from reactions pin where pin.resource_id = r.id and pin.user_id = ${actor.id} and pin.kind = 'pin'), '')`;
    const enrolled = entryQuery(
      sql.ref("r.id"),
      actor.id,
      distributionBehavior(policy, "document").includeGranted,
    );
    const libraryEnrolled = entryQuery(
      sql.ref("r.library_id"),
      actor.id,
      distributionBehavior(policy, "library").includeGranted,
      policy.publicLibraries,
    );
    const treeMode = !!input.includeAncestors && libraryIds.length > 0;
    let query = tx.selectFrom("resources as r");
    if (!treeMode)
      query = query.where(
        accessibleQuery(
          sql.ref("r.id"),
          actor,
          input.scope === "trash" ? 4 : 1,
          input.scope === "trash",
        ),
      );
    query =
      input.scope === "trash"
        ? query.where("r.deleted_at", "is not", null)
        : query.where("r.deleted_at", "is", null);
    if (input.kind)
      query = query.where("r.kind", "=", input.kind as "document" | "library");
    if (input.format) query = query.where("r.format", "=", input.format as any);
    if (input.location)
      query = query
        .where("r.kind", "=", "document")
        .where(
          "r.library_id",
          input.location === "personal" ? "is" : "is not",
          null,
        );
    if (libraryIds.length)
      query = query.where("r.library_id", "in", libraryIds);
    if (input.ownerIds?.length) {
      query = query.where("r.owner_id", "in", input.ownerIds);
      // An owner filter must not reveal ownership hidden by the site's policy.
      if (!resourceDistribution(policy, "document").managerInfoVisible)
        query = query.where(accessibleQuery(sql.ref("r.id"), actor, 4));
    }
    if (input.visitedWithinDays !== undefined) {
      if (!Number.isInteger(input.visitedWithinDays) || input.visitedWithinDays < 1 || input.visitedWithinDays > 3650)
        fail(400, "最近浏览天数需为1到3650的整数");
      const since = new Date(Date.now() - input.visitedWithinDays * 86400000).toISOString();
      query = query.where(sql<boolean>`${visited} >= ${since}`);
    }
    if (input.likedOnly)
      query = query.where(sql<boolean>`exists(select 1 from reactions f where f.resource_id = r.id and f.user_id = ${actor.id} and f.kind = 'like')`);
    if (input.favoritesOnly)
      query = query.where(sql<boolean>`exists(select 1 from reactions f where f.resource_id = r.id and f.user_id = ${actor.id} and f.kind = 'favorite')`);
    if (input.parentId)
      query = query.where((eb) =>
        eb.or([
          eb("r.parent_id", "=", input.parentId!),
          eb.and([
            eb("r.library_id", "=", input.parentId!),
            eb("r.parent_id", "is", null),
          ]),
        ]),
      );
    switch (input.scope) {
      case "mine":
        query = query
          .where("r.library_id", "is", null)
          .where("r.kind", "=", "document")
          .where("r.owner_id", "=", actor.id);
        break;
      case "owned":
        query = query
          .where("r.owner_id", "=", actor.id)
          .where("r.kind", "=", "document");
        break;
      case "recent":
        query = query.where(sql<boolean>`${visited} is not null`);
        break;
      case "favorites":
        query = query.where(
          sql<boolean>`exists(select 1 from reactions f where f.resource_id = r.id and f.user_id = ${actor.id} and f.kind = 'favorite')`,
        );
        break;
      case "pins":
        query = query
          .where("r.kind", "=", "document")
          .where(
            sql<boolean>`exists(select 1 from reactions pin where pin.resource_id = r.id and pin.user_id = ${actor.id} and pin.kind = 'pin')`,
          );
        break;
      case "libraries":
        query = query
          .where("r.kind", "=", "library")
          .where(
            entryQuery(
              sql.ref("r.id"),
              actor.id,
              distributionBehavior(policy, "library").includeGranted,
              policy.publicLibraries,
            ),
          );
        break;
      case "shared":
        query = query
          .where("r.kind", "=", "document")
          .where("r.owner_id", "!=", actor.id)
          .where(enrolled);
        break;
      case "discover":
        if (!policy.publicDiscovery) fail(403, "本站未开放公共发现");
        query = query
          .where(policyFieldQuery(sql.ref("r.id"), "discoverable"), "=", 1)
          .where(policyFieldQuery(sql.ref("r.id"), "visibility"), "in", ["public", "authenticated"]);
        break;
      default:
        // Explicit library/tree navigation already establishes its candidate scope.
        if (
          !libraryIds.length &&
          !input.parentId &&
          input.scope !== "trash" &&
          distributionBehavior(policy, "document").requireSearchIntersection
        )
          query = query.where(
            sql<boolean>`(r.owner_id = ${actor.id} or ${enrolled} or ${libraryEnrolled})`,
          );
    }
    if (input.matchedIds)
      query = query.where(
        "r.id",
        "in",
        input.matchedIds.length ? input.matchedIds : [""],
      );
    const text = input.q?.trim().toLowerCase();
    if (text) {
      const pattern =
        "%" +
        text.replaceAll("!", "!!").replaceAll("%", "!%").replaceAll("_", "!_") +
        "%";
      query = query
        .where("r.kind", "=", "document")
        .where(
          sql<boolean>`(lower(r.title) like ${pattern} escape '!' or exists(select 1 from document_states s where s.resource_id = r.id and lower(s.text) like ${pattern} escape '!'))`,
        );
    }
    const key =
      input.sort ?? (input.scope === "recent" ? "visited_at" : "updated_at");
    const orderKey =
      input.scope === "pins"
        ? pinStamp
        : key === "visited_at"
          ? sql<string>`coalesce(${visited}, '')`
          : sql.ref(key === "created_at" ? "r.created_at" : "r.updated_at");
    const ascending = input.order === "asc";
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          ...input,
          offset: undefined,
          cursor: undefined,
          matchedIds: undefined,
          actor: actor.id,
        }),
      )
      .digest("hex");
    let total = Number(
      (
        await query
          .select((eb) => eb.fn.countAll().as("n"))
          .executeTakeFirstOrThrow()
      ).n,
    );
    if (input.cursor) {
      try {
        const c = JSON.parse(Buffer.from(input.cursor, "base64url").toString());
        if (
          c.fingerprint !== fingerprint ||
          typeof c.value !== "string" ||
          typeof c.id !== "string"
        )
          throw Error();
        query = query.where(
          sql<boolean>`(${orderKey} ${ascending ? sql`>` : sql`<`} ${c.value} or (${orderKey} = ${c.value} and r.id > ${c.id}))`,
        );
      } catch {
        fail(400, "分页游标无效，请重新查询");
      }
    }
    const offset = input.cursor ? 0 : (input.offset ?? 0);
    const rows = await query
      .leftJoin("users as owner", "owner.id", "r.owner_id")
      .selectAll("r")
      .select([
        sql<string>`coalesce(nullif(owner.display_name, ''), owner.public_id, owner.login)`.as(
          "ownerName",
        ),
        visited.as("visited_at"),
        orderKey.as("cursorValue"),
        sql<number>`exists(select 1 from reactions fav where fav.resource_id = r.id and fav.user_id = ${actor.id} and fav.kind = 'favorite')`.as(
          "favorite",
        ),
        sql<number>`exists(select 1 from reactions pin where pin.resource_id = r.id and pin.user_id = ${actor.id} and pin.kind = 'pin')`.as(
          "pinned",
        ),
      ])
      .orderBy(orderKey, ascending ? "asc" : "desc")
      .orderBy("r.id")
      .offset(offset)
      .limit(treeMode ? 10000 : 101)
      .execute();
    const ctx = await accessContext(
      tx,
      actor,
      rows.map((r) => r.id),
    );
    let page = rows.slice(0, 100);
    if (treeMode) {
      const included = new Set(
        rows
          .filter((r) => permission(r, actor, ctx.resources, ctx.grants) > 0)
          .map((r) => r.id),
      );
      for (const row of rows) {
        if (!included.has(row.id)) continue;
        let parent = row.parent_id;
        const seen = new Set<string>();
        while (parent && !seen.has(parent)) {
          seen.add(parent);
          included.add(parent);
          parent = rows.find((candidate) => candidate.id === parent)?.parent_id ?? null;
        }
      }
      page = rows.filter((r) => included.has(r.id));
      total = page.length;
    }
    const last = page.at(-1);
    return {
      items: page.map(({ cursorValue, ...r }) => {
        const projected = projectResource(
          r,
          actor,
          ctx.resources,
          ctx.grants,
          resourceDistribution(policy,r.kind).managerInfoVisible,
        );
        return {
          ...projected,
          ...(treeMode ? { parent_id: r.parent_id } : {}),
          ownerName: projected.owner_id ? r.ownerName : "",
          favorite: Number(r.favorite) === 1,
          pinned: Number(r.pinned) === 1,
          inLibrary: !!r.library_id,
          libraryName:
            ctx.resources.find((x) => x.id === projected.library_id)?.title ??
            null,
        };
      }),
      total,
      nextOffset: treeMode ? null : rows.length > 100 ? offset + 100 : null,
      nextCursor:
        rows.length > 100 && last
          ? Buffer.from(
              JSON.stringify({
                fingerprint,
                value: last.cursorValue,
                id: last.id,
              }),
            ).toString("base64url")
          : null,
    };
  });
}
