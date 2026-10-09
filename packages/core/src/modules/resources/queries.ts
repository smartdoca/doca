import { distributionBehavior } from "../access/distribution-behavior.js";
import { policyFieldQuery } from "../access/queries.js";
import { sql } from "kysely";
import type { DB } from "../../../../db/src/index.js";
import { readSnapshot } from "../../../../db/src/transactions.js";
import {
  cursorFingerprint,
  decodePageCursor,
  encodePageCursor,
} from "../../shared/cursor.js";
import { fail } from "../../shared/errors.js";
import {
  accessContext,
  accessibleQuery,
  authorize,
  projectResource,
} from "../access/queries.js";
import {
  distributionPolicy,
  resourceDistribution,
  publicMode,
} from "../deployment/policies.js";
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
  return sql<boolean>`(exists(select 1 from reactions fav where fav.resource_id=${id} and fav.user_id=${userId} and fav.kind='favorite') or exists(select 1 from resource_collections c where c.resource_id=${id} and c.resource_kind in ('document','library') and c.user_id=${userId}) or exists(select 1 from resources entry where entry.id = ${id}
    and not exists(select 1 from resource_entries hidden where hidden.resource_id = entry.id and hidden.user_id = ${userId} and hidden.state = 'hidden')
    and (entry.owner_id = ${userId}
      or exists(select 1 from resource_entries joined where joined.resource_id = entry.id and joined.user_id = ${userId} and joined.state = 'joined' and joined.source not in ('opened','manual'))
      or exists(select 1 from access_invitations invitation where invitation.resource_id = entry.id and invitation.user_id = ${userId} and invitation.state = 'accepted')
      ${allowGranted ? sql`or exists(select 1 from grants g where g.resource_id = entry.id and g.user_id = ${userId} and g.status = 'active')` : sql``}
      ${allowPublic ? sql`or (entry.kind = 'library' and entry.access_mode = 'custom' and entry.visibility in ('public', 'authenticated'))` : sql``}
    )))`;
}
/** Titles stay visible inside a library the caller can read; opening still requires document permission. */
function redactClosed<T extends { role: string }>(resource: T) {
  return resource.role === "none"
    ? {
        ...resource,
        owner_id: "",
        last_editor_id: null,
        cover_asset_id: null,
        content_bytes: null,
      }
    : resource;
}

/** Anonymous callers may outline one library they can read. Search and personal scopes stay signed-in. */
async function anonymousLibraryPage(db: DB, input: ResourceQuery) {
  const libraryIds =
    input.libraryIds ?? (input.libraryId ? [input.libraryId] : []);
  if (
    libraryIds.length !== 1 ||
    input.q ||
    input.ownerIds?.length ||
    input.favoritesOnly ||
    input.likedOnly ||
    input.visitedWithinDays !== undefined ||
    input.matchedIds ||
    input.location ||
    input.sort === "visited_at" ||
    (input.scope && input.scope !== "all")
  )
    fail(401, "请先登录");
  return readSnapshot(db, async (tx) => {
    const libraryId = libraryIds[0]!;
    const allowed = await authorize(tx, null, libraryId);
    if (allowed.resource.kind !== "library") fail(400, "知识库筛选条件无效");
    if (input.parentId) await authorize(tx, null, input.parentId);
    const treeMode = !!input.includeAncestors;
    const policy = await distributionPolicy(tx);
    const column = input.sort === "created_at" ? "created_at" : "updated_at";
    const ascending = input.order === "asc";
    const fingerprint = cursorFingerprint({
      ...input,
      cursor: undefined,
      actor: "anonymous",
    });
    let query = tx
      .selectFrom("resources as r")
      .where("r.deleted_at", "is", null)
      .where("r.library_id", "=", libraryId);
    if (input.kind)
      query = query.where("r.kind", "=", input.kind as "document" | "library");
    if (input.format) query = query.where("r.format", "=", input.format as any);
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
    if (!treeMode)
      query = query.where(accessibleQuery(sql.ref("r.id"), null, 1));
    const orderKey = sql.ref(`r.${column}`);
    let total: number | null = null;
    if (!input.cursor && !treeMode)
      total = Number(
        (
          await query
            .select((eb) => eb.fn.countAll().as("n"))
            .executeTakeFirstOrThrow()
        ).n,
      );
    if (input.cursor) {
      const c = decodePageCursor(input.cursor, fingerprint);
      query = query.where(
        sql<boolean>`(${orderKey} ${ascending ? sql`>` : sql`<`} ${c.value} or (${orderKey} = ${c.value} and r.id > ${c.id}))`,
      );
    }
    const rows = await query
      .selectAll("r")
      .orderBy(orderKey, ascending ? "asc" : "desc")
      .orderBy("r.id")
      .limit(treeMode ? 10001 : 101)
      .execute();
    const ctx = await accessContext(tx, null, [
      libraryId,
      ...rows.map((r) => r.id),
    ]);
    const page = rows.slice(0, treeMode ? 10000 : 100);
    const last = page.at(-1);
    if (treeMode) total = page.length;
    return {
      items: page.filter(r => ctx.resources.some(resource => resource.id === r.id)).map((r) => {
        const projected = redactClosed(
          projectResource(
            r,
            null,
            ctx.resources,
            ctx.grants,
            resourceDistribution(policy, r.kind).managerInfoVisible,
          ),
        );
        return {
          ...projected,
          ...(treeMode
            ? { parent_id: r.parent_id, library_id: r.library_id }
            : {}),
          ownerName: "",
          collected: false,
          is_public: true,
          favorite: false,
          pinned: false,
          inLibrary: true,
          libraryName: allowed.resource.title,
        };
      }),
      total,
      nextCursor:
        !treeMode && rows.length > 100 && last
          ? encodePageCursor(fingerprint, last[column], last.id)
          : null,
      truncated: treeMode && rows.length > 10000,
    };
  });
}

async function queryResourcePageUnchecked(
  db: DB,
  actor: Actor | null,
  input: ResourceQuery,
) {
  if (!actor) return anonymousLibraryPage(db, input);
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
    const visited = sql<string | null>`visit.visited_at`;
    const pinStamp = sql<string>`coalesce((select pin.created_at from reactions pin where pin.resource_id = r.id and pin.user_id = ${actor.id} and pin.kind = 'pin'), '')`;
    const enrolled = entryQuery(
      sql.ref("r.id"),
      actor.id,
      true,
    );
    const libraryEnrolled = entryQuery(
      sql.ref("r.library_id"),
      actor.id,
      distributionBehavior(policy, "library").includeGranted,
      input.scope !== "personal" && publicMode(policy, "library") === "search",
    );
    const treeMode = !!input.includeAncestors && libraryIds.length > 0;
    let query = tx
      .selectFrom("resources as r")
      .leftJoin("resource_visits as visit", (join) =>
        join
          .onRef("visit.resource_id", "=", "r.id")
          .on("visit.user_id", "=", actor.id),
      );
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
    // Knowledge books share library permissions but have their own catalogue.
    if (input.kind === "library" || input.scope === "libraries")
      query = query.where(
        sql<boolean>`not exists(select 1 from knowledge_books book where book.id = r.id)`,
      );
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
      if (
        !Number.isInteger(input.visitedWithinDays) ||
        input.visitedWithinDays < 1 ||
        input.visitedWithinDays > 3650
      )
        fail(400, "最近浏览天数需为1到3650的整数");
      const since = new Date(
        Date.now() - input.visitedWithinDays * 86400000,
      ).toISOString();
      query = query.where(sql<boolean>`${visited} >= ${since}`);
    }
    if (input.likedOnly)
      query = query.where(
        sql<boolean>`exists(select 1 from reactions f where f.resource_id = r.id and f.user_id = ${actor.id} and f.kind = 'like')`,
      );
    if (input.favoritesOnly)
      query = query.where(
        sql<boolean>`exists(select 1 from reactions f where f.resource_id = r.id and f.user_id = ${actor.id} and f.kind = 'favorite')`,
      );
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
          .where("r.owner_id", "=", actor.id);
        break;
      case "recent":
        query = query.where("visit.resource_id", "is not", null);
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
              false,
            ),
          );
        break;
      case "shared":
        query = query.where("r.kind", "=", input.kind === "library" ? "library" : "document")
          .where("r.owner_id", "!=", actor.id)
          .where(sql<boolean>`(exists(select 1 from grants g where g.user_id=${actor.id} and g.status='active' and (g.resource_id=r.id or (g.resource_id=r.library_id and g.include_descendants=1))) or exists(select 1 from access_invitations i where i.user_id=${actor.id} and i.state='accepted' and i.resource_id=r.id))`);
        break;
      case "collected":
        query = query.where(
          sql<boolean>`exists(select 1 from resource_collections e where e.resource_id = r.id and e.resource_kind = r.kind and e.user_id = ${actor.id})`,
        );
        break;
      case "discover":
        query = query
          .where("r.library_id", "is", null)
          .where(
            sql<boolean>`((r.kind = 'document' and ${publicMode(policy, "document") !== "link" ? 1 : 0} = 1) or (r.kind = 'library' and ${publicMode(policy, "library") !== "link" ? 1 : 0} = 1))`,
          )
          .where(policyFieldQuery(sql.ref("r.id"), "visibility"), "in", [
            "public",
            "authenticated",
          ]);
        break;
      default:
        // Explicit library/tree navigation already establishes its candidate scope.
        if (
          input.scope === "personal" ||
          input.scope === "public" ||
          (!libraryIds.length && !input.parentId && input.scope !== "trash")
        ) {
          const publiclySearchable = sql<boolean>`(${policyFieldQuery(sql.ref("r.id"), "visibility")} in ('public', 'authenticated') and
            ((r.library_id is not null and ${publicMode(policy, "library") === "search" ? 1 : 0} = 1)
             or (r.kind = 'library' and ${publicMode(policy, "library") === "search" ? 1 : 0} = 1)
             or (r.kind = 'document' and r.library_id is null and ${publicMode(policy, "document") === "search" ? 1 : 0} = 1)))`;
          query = query.where(
            input.scope === "public"
              ? publiclySearchable
              : sql<boolean>`(r.owner_id = ${actor.id} or ${enrolled} or ${libraryEnrolled} ${input.scope === "personal" ? sql`` : sql`or ${publiclySearchable}`})`,
          );
        }
    }
    if (input.matchedIds)
      query = query.where(
        "r.id",
        "in",
        input.matchedIds.length ? input.matchedIds : [""],
      );
    const text = input.q?.trim().toLowerCase();
    if (text) {
      if (input.scope !== "discover" && input.scope !== "collected")
        query = query.where("r.kind", "=", "document");
      const pattern =
        "%" +
        text.replaceAll("!", "!!").replaceAll("%", "!%").replaceAll("_", "!_") +
        "%";
      query = query.where(
        input.scope === "discover" || input.scope === "collected"
          ? sql<boolean>`lower(r.title) like ${pattern} escape '!'`
          : sql<boolean>`(lower(r.title) like ${pattern} escape '!' or exists(select 1 from document_states s where s.resource_id = r.id and lower(s.text) like ${pattern} escape '!'))`,
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
    const fingerprint = cursorFingerprint({
      ...input,
      cursor: undefined,
      matchedIds: undefined,
      actor: actor.id,
    });
    // Cursor pages do not need to repeat the expensive exact count. The recent
    // view is intentionally count-free because ordered retrieval is much cheaper
    // than evaluating permissions across the user's complete visit history.
    let total: number | null = null;
    if (!input.cursor && input.scope !== "recent")
      total = Number(
        (
          await query
            .select((eb) => eb.fn.countAll().as("n"))
            .executeTakeFirstOrThrow()
        ).n,
      );
    if (input.cursor) {
      const c = decodePageCursor(input.cursor, fingerprint);
      query = query.where(
        sql<boolean>`(${orderKey} ${ascending ? sql`>` : sql`<`} ${c.value} or (${orderKey} = ${c.value} and r.id > ${c.id}))`,
      );
    }
    const rows = await query
      .leftJoin("users as owner", "owner.id", "r.owner_id")
      .selectAll("r")
      .select([
        sql<string>`coalesce(nullif(owner.display_name, ''), owner.public_id, owner.login)`.as(
          "ownerName",
        ),
        visited.as("visited_at"),
        sql<number>`exists(select 1 from resource_collections c where c.resource_id=r.id and c.resource_kind=r.kind and c.user_id=${actor.id})`.as("collected"),
        sql<number>`case when ${policyFieldQuery(sql.ref("r.id"),"visibility")} in ('public','authenticated') then 1 else 0 end`.as("is_public"),
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
      .limit(treeMode ? 10001 : 101)
      .execute();
    const ctx = await accessContext(
      tx,
      actor,
      rows.map((r) => r.id),
    );
    let page = rows.slice(0, 100);
    if (treeMode) {
      // Library readers see the whole outline. Documents they cannot open stay in place with role none.
      page = rows.slice(0, 10000);
      total = page.length;
    }
    const last = page.at(-1);
    return {
      items: page.filter(r => ctx.resources.some(resource => resource.id === r.id)).map(({ cursorValue, ...r }) => {
        const projected = redactClosed(
          projectResource(
            r,
            actor,
            ctx.resources,
            ctx.grants,
            resourceDistribution(policy, r.kind).managerInfoVisible,
          ),
        );
        return {
          ...projected,
          ...(treeMode ? { parent_id: r.parent_id, library_id: r.library_id } : {}),
          ownerName: projected.owner_id ? r.ownerName : "",
          collected: Number(r.collected) === 1,
          is_public: Number(r.is_public) === 1,
          favorite: Number(r.favorite) === 1,
          pinned: Number(r.pinned) === 1,
          inLibrary: !!r.library_id,
          libraryName:
            ctx.resources.find((x) => x.id === projected.library_id)?.title ??
            null,
        };
      }),
      total,
      nextCursor:
        !treeMode && rows.length > 100 && last
          ? encodePageCursor(fingerprint, String(last.cursorValue), last.id)
          : null,
      truncated: treeMode && rows.length > 10000,
    };
  });
}

export async function queryResourcePage(db:DB, actor:Actor|null, input:ResourceQuery) {
  return queryResourcePageUnchecked(db, actor, input);
}
