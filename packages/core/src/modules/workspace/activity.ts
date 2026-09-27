import { sql } from "kysely";
import type { DB } from "@db/index.js";
import type { Actor } from "../identity/passwords.js";
import {
  activeActor,
  authorize,
  accessibleQuery,
  policyFieldQuery,
} from "../access/queries.js";
import {
  authorizeFileFolder,
  authorizeFileItem,
} from "../access/file-access.js";
import { knowledgeAssistantAccess } from "../knowledge/system.js";
import { AppError, fail } from "../../shared/errors.js";

export async function recordActivity(
  db: DB,
  userId: string,
  kind: "folder" | "file",
  id: string,
) {
  const stamp = new Date().toISOString();
  await db
    .insertInto("workspace_activity")
    .values({
      user_id: userId,
      resource_kind: kind,
      resource_id: id,
      visited_at: stamp,
      favorite: 0,
    })
    .onConflict((oc) =>
      oc
        .columns(["user_id", "resource_kind", "resource_id"])
        .doUpdateSet({ visited_at: stamp }),
    )
    .execute();
}
export async function setAssistantFavorite(
  db: DB,
  actor: Actor,
  id: string,
  favorite: boolean,
) {
  await activeActor(db, actor);
  const bot = await db
    .selectFrom("knowledge_assistants")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();
  if (!bot || !(await knowledgeAssistantAccess(db, actor, bot)).accessible)
    fail(404, "问答不存在");
  await db
    .insertInto("workspace_activity")
    .values({
      user_id: actor.id,
      resource_kind: "assistant",
      resource_id: id,
      visited_at: null,
      favorite: Number(favorite),
    })
    .onConflict((oc) =>
      oc
        .columns(["user_id", "resource_kind", "resource_id"])
        .doUpdateSet({ favorite: Number(favorite) }),
    )
    .execute();
  return { favorite };
}
export type RecentItem = {
  id: string;
  kind: "document" | "library" | "assistant" | "folder" | "file";
  title: string;
  visited_at: string;
  updated_at: string;
  collected: boolean;
  public: boolean;
  href: string;
};
export async function recentActivity(
  db: DB,
  actor: Actor,
  input: {
    kind?: string;
    publicOnly?: boolean;
    q?: string;
    offset?: number;
  } = {},
) {
  await activeActor(db, actor);
  const pattern = `%${(input.q ?? "").trim().toLowerCase().replaceAll("!", "!!").replaceAll("%", "!%").replaceAll("_", "!_")}%`;
  const union = sql`
    select r.id,r.kind,r.title,v.visited_at,r.updated_at from resource_visits v join resources r on r.id=v.resource_id where v.user_id=${actor.id} and ${accessibleQuery(sql.ref("r.id"), actor)}
    union all select b.id,'assistant',b.title,v.visited_at,b.updated_at from knowledge_assistant_users v join knowledge_assistants b on b.id=v.assistant_id where v.user_id=${actor.id} and v.visited_at is not null
    union all select f.id,'folder',f.name,v.visited_at,f.updated_at from workspace_activity v join file_folders f on f.id=v.resource_id where v.user_id=${actor.id} and v.resource_kind='folder' and v.visited_at is not null and f.deleted_at is null
    union all select f.id,'file',f.name,v.visited_at,f.updated_at from workspace_activity v join file_items f on f.id=v.resource_id where v.user_id=${actor.id} and v.resource_kind='file' and v.visited_at is not null and f.deleted_at is null`;
  const items: RecentItem[] = [];
  let scan = 0,
    accepted = 0,
    done = false;
  const offset = input.offset ?? 0;
  while (items.length < 51 && !done) {
    const rows = await sql<
      Omit<RecentItem, "collected" | "public" | "href">
    >`select * from (${union}) v where lower(title) like ${pattern} escape '!' ${input.kind ? sql`and kind=${input.kind}` : sql``} order by visited_at desc,kind,id limit 100 offset ${scan}`.execute(
      db,
    );
    scan += rows.rows.length;
    done = rows.rows.length < 100;
    for (const row of rows.rows) {
      let isPublic = false;
      let href = `#/r/${row.id}`;
      try {
        if (row.kind === "document" || row.kind === "library") {
          await authorize(db, actor, row.id);
          const visibility = await sql<{
            v: string;
          }>`select ${policyFieldQuery(sql.val(row.id) as ReturnType<typeof sql.ref>, "visibility")} as v`.execute(
            db,
          );
          isPublic = ["public", "authenticated"].includes(
            visibility.rows[0]?.v ?? "",
          );
        } else if (row.kind === "assistant") {
          const bot = await db
            .selectFrom("knowledge_assistants")
            .selectAll()
            .where("id", "=", row.id)
            .executeTakeFirstOrThrow();
          if (!(await knowledgeAssistantAccess(db, actor, bot)).accessible)
            continue;
          isPublic = ["public", "authenticated"].includes(
            bot.visibility ?? "invited",
          );
          href = `#/knowledge-assistants?bot=${row.id}`;
        } else if (row.kind === "folder") {
          await authorizeFileFolder(db, actor, row.id);
          const pub = await sql<{
            id: string;
          }>`with recursive ancestors as (select id,parent_id,0 as depth from file_folders where id=${row.id} union all select f.id,f.parent_id,a.depth+1 from file_folders f join ancestors a on f.id=a.parent_id where a.depth<1000) select a.id from ancestors a join folder_publications p on p.folder_id=a.id where p.enabled=1`.execute(
            db,
          );
          isPublic = pub.rows.length > 0;
          href = `#/shared-files/${row.id}`;
        } else {
          const file = await authorizeFileItem(db, actor, row.id);
          const trail: { type: string; id: string; name: string }[] = [];
          if (file.parent_type === "folder") {
            let folderId: string | null = file.parent_id;
            const seen = new Set<string>();
            while (
              folderId &&
              !["root", "shared"].includes(folderId) &&
              !seen.has(folderId)
            ) {
              seen.add(folderId);
              const folder = await db
                .selectFrom("file_folders")
                .selectAll()
                .where("id", "=", folderId)
                .executeTakeFirst();
              if (!folder) break;
              trail.unshift({
                type: "folder",
                id: folder.id,
                name: folder.name,
              });
              folderId = folder.parent_id;
            }
            if (folderId === "shared" && trail.length)
              href = `#/shared-files/${trail[0]!.id}?path=${encodeURIComponent(JSON.stringify(trail))}&focus=${row.id}`;
            else {
              trail.unshift({ type: "system", id: "root", name: "" });
              href = `#/files?path=${encodeURIComponent(JSON.stringify(trail))}&focus=${row.id}`;
            }
          } else {
            if (file.parent_type === "document") {
              trail.push(
                { type: "system", id: "root", name: "" },
                { type: "system", id: "documents", name: "" },
              );
            }
            trail.push({
              type: file.parent_type,
              id: file.parent_id,
              name: "",
            });
            href = `#/files?path=${encodeURIComponent(JSON.stringify(trail))}&focus=${row.id}`;
          }
        }
      } catch (e) {
        if (e instanceof AppError && [401, 403, 404].includes(e.status))
          continue;
        throw e;
      }
      if (input.publicOnly && !isPublic) continue;
      if (accepted++ < offset) continue;
      const saved =
        row.kind === "file"
          ? null
          : await db
              .selectFrom("resource_collections")
              .select("resource_id")
              .where("user_id", "=", actor.id)
              .where("resource_kind", "=", row.kind)
              .where("resource_id", "=", row.id)
              .executeTakeFirst();
      items.push({ ...row, collected: !!saved, public: isPublic, href });
      if (items.length === 51) break;
    }
  }
  return {
    items: items.slice(0, 50),
    total: null,
    nextOffset: items.length > 50 ? offset + 50 : null,
  };
}
