import type { DB } from "@db/index.js";

/** Resolve only the explicitly supplied directory tree; no name or global lookup. */
export async function inputFolderFiles(
  db: DB,
  folderId: string,
  authorizeFolder: (id: string) => Promise<unknown>,
) {
  const files: Array<{
    fileId: string;
    name: string;
    path: string;
    mime: string;
    size: number;
  }> = [];
  const pending = [{ id: folderId, path: "" }];
  const visited = new Set<string>();
  while (pending.length) {
    const folder = pending.shift()!;
    if (visited.has(folder.id)) continue;
    visited.add(folder.id);
    await authorizeFolder(folder.id);
    const children = await db
      .selectFrom("file_folders")
      .select(["id", "name"])
      .where("parent_id", "=", folder.id)
      .where("deleted_at", "is", null)
      .orderBy("name", "asc")
      .orderBy("id", "asc")
      .execute();
    const rows = await db
      .selectFrom("file_items")
      .select(["id", "name", "mime", "size"])
      .where("parent_type", "=", "folder")
      .where("parent_id", "=", folder.id)
      .where("deleted_at", "is", null)
      .orderBy("name", "asc")
      .orderBy("id", "asc")
      .execute();
    files.push(
      ...rows.map(({ id, ...file }) => ({
        ...file,
        fileId: id,
        path: folder.path + file.name,
      })),
    );
    pending.push(
      ...children.map((child) => ({
        id: child.id,
        path: folder.path + child.name + "/",
      })),
    );
  }
  return files;
}
