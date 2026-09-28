import { sql } from "kysely";
import type { DB, Schema } from "../../../../db/src/index.js";
import { transact } from "../../../../db/src/transactions.js";
import { fail } from "../../shared/errors.js";
import {
  noteBodySchema,
  noteText,
  noteHasText,
  inlineNoteAssets,
  type QuickNote,
  type NoteAsset,
} from "../../shared/quick-notes.js";

export async function noteOwner(
  db: DB,
  owner: string,
  id: string,
  trash = false,
) {
  const row = await db
    .selectFrom("quick_notes")
    .selectAll()
    .where("id", "=", id)
    .where("owner_id", "=", owner)
    .executeTakeFirst();
  if (!row || (!trash && row.deleted_at)) fail(404, "随手记不存在或无权访问");
  return row;
}
export async function noteAssets(
  db: DB,
  owner: string,
  ids: string[],
  noteId?: string,
): Promise<Schema["assets"][]> {
  if (new Set(ids).size !== ids.length) fail(400, "附件不能重复");
  const rows = [];
  for (const id of ids) {
    const row = await db
      .selectFrom("assets")
      .selectAll()
      .where("id", "=", id)
      .where("owner_id", "=", owner)
      .where("purpose", "=", "note_attachment")
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!row || (noteId && row.note_id && row.note_id !== noteId))
      fail(404, "附件不存在或无权使用");
    rows.push(row);
  }
  return rows;
}
export const noteAssetInfo = ({
  id,
  filename,
  mime,
  size,
}: NoteAsset): NoteAsset => ({ id, filename, mime, size });
export async function presentNote(
  db: DB,
  row: Schema["quick_notes"],
): Promise<QuickNote> {
  // A blocked/deleted asset does not prevent recovering or editing the text.
  const ids: string[] = JSON.parse(row.asset_ids);
  const assets = ids.length
    ? await db
        .selectFrom("assets")
        .select(["id", "filename", "mime", "size"])
        .where("id", "in", ids)
        .where("owner_id", "=", row.owner_id)
        .where("note_id", "=", row.id)
        .execute()
    : [];
  return {
    id: row.id,
    content: JSON.parse(row.content),
    assets: ids.flatMap((id) => assets.filter((a) => a.id === id)),
    version: row.version,
    created_at: row.created_at,
    updated_at: row.updated_at,
    deleted_at: row.deleted_at,
  };
}
export async function listNotes(
  db: DB,
  owner: string,
  q: string,
  trash: boolean,
  offset: number,
) {
  let query = db
    .selectFrom("quick_notes")
    .where("owner_id", "=", owner)
    .where("deleted_at", trash ? "is not" : "is", null);
  if (q)
    query = query.where(
      sql<boolean>`lower(plain_text) like ${"%" + q.toLowerCase().replace(/[\\%_]/g, "\\$&") + "%"} escape ${"\\"}`,
    );
  const rows = await query
    .selectAll()
    .orderBy("updated_at", "desc")
    .orderBy("id", "desc")
    .offset(offset)
    .limit(31)
    .execute();
  return {
    items: await Promise.all(
      rows.slice(0, 30).map((row) => presentNote(db, row)),
    ),
    nextOffset: rows.length > 30 ? offset + 30 : null,
  };
}
export async function saveNote(
  db: DB,
  owner: string,
  id: string,
  input: unknown,
  version?: number,
) {
  const parsed = noteBodySchema.safeParse(input);
  if (!parsed.success) fail(400, "随手记格式无效");
  const { content, assetIds } = parsed.data;
  const encoded = JSON.stringify(content),
    plain = noteText(content);
  if (Buffer.byteLength(encoded) > 128 * 1024 || plain.length > 30000)
    fail(413, "单条随手记最多 3 万字或 128 KB");
  if (!noteHasText(content) && !assetIds.length)
    fail(400, "先写点内容或添加图片附件");
  if (
    content.some(
      (n) => (n.type === "image" || n.type === "attachment") && !n.path,
    )
  )
    fail(400, "请等待图片或附件上传完成，或移除失败的上传");
  if (inlineNoteAssets(content).some((id) => !assetIds.includes(id)))
    fail(400, "正文中的图片附件必须属于此记录");
  const ids = content.flatMap((n) => [
    n.id,
    ...n.children.flatMap((c) => ("id" in c ? [c.id] : [])),
  ]);
  if (new Set(ids).size !== ids.length) fail(400, "内容节点标识重复");
  return transact(db, async (tx) => {
    const now = new Date().toISOString();
    if (version === undefined) {
      const inserted = await tx
        .insertInto("quick_notes")
        .values({
          id,
          owner_id: owner,
          content: encoded,
          plain_text: plain,
          asset_ids: JSON.stringify(assetIds),
          version: 1,
          created_at: now,
          updated_at: now,
          deleted_at: null,
        })
        .onConflict((c) => c.column("id").doNothing())
        .returning("id")
        .executeTakeFirst();
      if (!inserted) {
        const old = await noteOwner(tx, owner, id);
        if (
          old.content !== encoded ||
          old.asset_ids !== JSON.stringify(assetIds)
        )
          fail(409, "记录已存在且内容不同，请刷新后检查");
        return presentNote(tx, old);
      }
    } else {
      const old = await noteOwner(tx, owner, id);
      if (old.version !== version) {
        if (
          old.version === version + 1 &&
          old.content === encoded &&
          old.asset_ids === JSON.stringify(assetIds)
        )
          return presentNote(tx, old);
        fail(
          409,
          "这条随手记已在其他页面修改，本地草稿已保留，请重新打开后合并",
        );
      }
      if (old.content === encoded && old.asset_ids === JSON.stringify(assetIds))
        return presentNote(tx, old);
      const updated = await tx
        .updateTable("quick_notes")
        .set({
          content: encoded,
          plain_text: plain,
          asset_ids: JSON.stringify(assetIds),
          updated_at: now,
          version: version + 1,
        })
        .where("id", "=", id)
        .where("owner_id", "=", owner)
        .where("version", "=", version)
        .returning("id")
        .executeTakeFirst();
      if (!updated) fail(409, "记录已更新，请重新打开后合并");
    }
    await noteAssets(tx, owner, assetIds, id);
    if (assetIds.length)
      await tx
        .updateTable("assets")
        .set({ note_id: id })
        .where("id", "in", assetIds)
        .where("owner_id", "=", owner)
        .execute();
    return presentNote(tx, await noteOwner(tx, owner, id));
  });
}
export async function trashNote(
  db: DB,
  owner: string,
  id: string,
  version: number,
  deleted: boolean,
) {
  return transact(db, async (tx) => {
    const row = await noteOwner(tx, owner, id, true);
    if (row.version !== version) fail(409, "记录已更新，请刷新后重试");
    const now = new Date().toISOString();
    const result = await tx
      .updateTable("quick_notes")
      .set({
        deleted_at: deleted ? now : null,
        updated_at: now,
        version: version + 1,
      })
      .where("id", "=", id)
      .where("owner_id", "=", owner)
      .where("version", "=", version)
      .returningAll()
      .executeTakeFirst();
    if (!result) fail(409, "记录已更新，请刷新后重试");
    return presentNote(tx, result);
  });
}
