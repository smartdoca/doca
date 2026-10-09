import type { DB } from "@db/index.js";
import type { Actor } from "../identity/passwords.js";
import { authorize } from "./queries.js";
import { fail } from "../../shared/errors.js";
import { authorizeKnowledgeFile } from "../knowledge/file-folders.js";

export async function authorizeFileFolder(
  tx: DB,
  actor: Actor,
  id: string,
  minimumRole = 1,
) {
  const folder = await tx
    .selectFrom("file_folders")
    .selectAll()
    .where("id", "=", id)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  if (!folder) fail(404, "文件夹不存在");
  if (folder.owner_id === actor.id)
    return {
      folder,
      role: "owner" as const,
      shareRootId: folder.parent_id === "shared" ? folder.id : null,
    };
  let cursor = folder;
  const visited = new Set<string>([folder.id]);
  while (cursor.parent_id && cursor.parent_id !== "shared") {
    const parent = await tx
      .selectFrom("file_folders")
      .selectAll()
      .where("id", "=", cursor.parent_id)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!parent) fail(404, "文件夹不存在");
    if (visited.has(parent.id)) fail(409, "文件夹层级存在循环");
    visited.add(parent.id);
    cursor = parent;
  }
  const published = await tx
    .selectFrom("folder_publications")
    .select("folder_id")
    .where("folder_id", "in", [...visited])
    .where("enabled", "=", 1)
    .executeTakeFirst();
  if (cursor.parent_id !== "shared") {
    if (published && minimumRole <= 1)
      return { folder, role: "reader" as const, shareRootId: null };
    fail(404, "文件夹不存在");
  }
  const share = await tx
    .selectFrom("file_folder_shares")
    .selectAll()
    .where("folder_id", "=", cursor.id)
    .where("user_id", "=", actor.id)
    .executeTakeFirst();
  const level = share?.role === "admin" ? 3 : share?.role === "reader" ? 1 : 0;
  if (level < minimumRole && published && minimumRole <= 1)
    return { folder, role: "reader" as const, shareRootId: cursor.id };
  if (level < minimumRole)
    fail(
      minimumRole > 1 ? 403 : 404,
      minimumRole > 1 ? "没有管理这个共享文件夹的权限" : "文件夹不存在",
    );
  return { folder, role: share!.role, shareRootId: cursor.id };
}

export async function authorizeFileItem(db: DB, actor: Actor, id: string) {
  const row = await db
    .selectFrom("file_items")
    .selectAll()
    .where("id", "=", id)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  if (!row) fail(404, "文件不存在");
  if (await authorizeKnowledgeFile(db, actor, row)) return row;
  if (row.parent_type === "document")
    await authorize(db, actor, row.parent_id, 1);
  else if (row.parent_type === "folder")
    await authorizeFileFolder(db, actor, row.parent_id, 1);
  else if (row.owner_id !== actor.id) fail(404, "文件不存在");
  return row;
}
