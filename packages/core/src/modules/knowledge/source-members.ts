import type { DB } from "@db/index.js";
import type { Schema } from "@db/schema.js";
import type { Actor } from "../identity/passwords.js";
import { authorize } from "../access/queries.js";
import {
  authorizeFileFolder,
  authorizeFileItem,
} from "../access/file-access.js";

/** Resolve live descendants on each scan. Access is checked at every boundary,
 * including folders, so selecting a parent never bypasses a restricted subtree. */
export async function knowledgeSourceMembers(
  db: DB,
  actor: Actor,
  source: Schema["knowledge_subscriptions"],
  excluded: string[] = [],
) {
  const denied = new Set(excluded),
    seen = new Set<string>();
  const items: Array<{
    id: string;
    kind: "document" | "file";
    title: string;
    version: string;
  }> = [];
  const queue = [source.source_id];
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id) || denied.has(id)) continue;
    seen.add(id);
    try {
      if (
        source.source_kind === "document" ||
        source.source_kind === "library"
      ) {
        const access = await authorize(db, actor, id, 1);
        if (access.resource.deleted_at) continue;
        if (access.resource.kind === "document") {
          const state = await db
            .selectFrom("document_states")
            .select("seq")
            .where("resource_id", "=", id)
            .executeTakeFirst();
          items.push({
            id,
            kind: "document",
            title: access.resource.title,
            version: String(state?.seq ?? access.resource.version),
          });
        }
        const children = await db
          .selectFrom("resources")
          .select("id")
          .where((q) =>
            access.resource.kind === "library"
              ? q.and([q("library_id", "=", id), q("parent_id", "is", null)])
              : q("parent_id", "=", id),
          )
          .where("deleted_at", "is", null)
          .orderBy("id")
          .execute();
        queue.push(...children.map((x) => x.id));
      } else if (source.source_kind === "folder") {
        await authorizeFileFolder(db, actor, id);
        const children = await db
          .selectFrom("file_folders")
          .select("id")
          .where("parent_id", "=", id)
          .where("deleted_at", "is", null)
          .orderBy("id")
          .execute();
        queue.push(...children.map((x) => x.id));
        const files = await db
          .selectFrom("file_items")
          .select(["id", "name", "updated_at"])
          .where("parent_type", "=", "folder")
          .where("parent_id", "=", id)
          .where("deleted_at", "is", null)
          .orderBy("id")
          .execute();
        for (const file of files) {
          if (denied.has(file.id)) continue;
          try {
            await authorizeFileItem(db, actor, file.id);
            items.push({
              id: file.id,
              kind: "file",
              title: file.name,
              version: file.updated_at,
            });
          } catch (error) {
            if (
              ![403, 404].includes((error as { status?: number }).status ?? 0)
            )
              throw error;
          }
        }
      } else if (source.source_kind === "file") {
        await authorizeFileItem(db, actor, id);
        const file = await db
          .selectFrom("file_items")
          .select(["name", "updated_at"])
          .where("id", "=", id)
          .where("deleted_at", "is", null)
          .executeTakeFirstOrThrow();
        items.push({
          id,
          kind: "file",
          title: file.name,
          version: file.updated_at,
        });
      }
    } catch (error) {
      if (![403, 404].includes((error as { status?: number }).status ?? 0))
        throw error;
    }
  }
  return items.sort((a, b) => a.id.localeCompare(b.id));
}
