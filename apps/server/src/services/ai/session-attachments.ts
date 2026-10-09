import { createHash, randomUUID } from "node:crypto";
import type { DB } from "@db/index.js";
import type { ToolContext } from "@core/workflows/ai-documents.js";
import { authorizeFileItem } from "@core/modules/access/file-access.js";
import { fail } from "@core/shared/errors.js";
import type { StoredExtractPart } from "./file-extract.js";

export async function sessionAttachmentIds(db: DB, ctx: ToolContext) {
  if (!ctx.jobId) fail(404, "attachment_session_required");
  const job = await db
    .selectFrom("ai_jobs as j")
    .innerJoin("ai_sessions as s", "s.id", "j.session_id")
    .select(["j.session_id", "j.created_at"])
    .where("j.id", "=", ctx.jobId)
    .where("j.user_id", "=", ctx.actor.id)
    .where("s.user_id", "=", ctx.actor.id)
    .executeTakeFirst();
  if (!job) fail(404, "attachment_session_missing");
  const jobs = await db
    .selectFrom("ai_jobs")
    .select("input")
    .where("session_id", "=", job.session_id)
    .where("user_id", "=", ctx.actor.id)
    .where("created_at", "<=", job.created_at)
    .orderBy("created_at", "asc")
    .execute();
  const ids = new Set<string>();
  for (const item of jobs)
    for (const id of JSON.parse(item.input).attachments ?? []) ids.add(id);
  return [...ids];
}
export async function sessionAttachments(db: DB, ctx: ToolContext) {
  const ids = await sessionAttachmentIds(db, ctx);
  if (!ids.length) return [];
  const rows = await db
    .selectFrom("assets")
    .select(["id", "filename", "mime", "size", "deleted_at"])
    .where("id", "in", ids)
    .where("owner_id", "=", ctx.actor.id)
    .where("purpose", "=", "ai_attachment")
    .execute();
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.map((id) => {
    const row = byId.get(id);
    return row
      ? {
          assetId: row.id,
          filename: row.filename,
          mime: row.mime,
          size: row.size,
          available: row.deleted_at === null,
        }
      : { assetId: id, available: false };
  });
}

/** Only the authorized source binding grants access to a derived page, including after refresh. */
export async function visualSourceAccess(
  db: DB,
  ctx: ToolContext,
  source: { assetId?: string; fileId?: string },
) {
  if (source.assetId) {
    if (!(await sessionAttachmentIds(db, ctx)).includes(source.assetId))
      fail(404, "附件不属于当前会话");
    const asset = await db
      .selectFrom("assets")
      .selectAll()
      .where("id", "=", source.assetId)
      .where("owner_id", "=", ctx.actor.id)
      .where("purpose", "=", "ai_attachment")
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!asset) fail(404, "附件不存在或无权访问");
    const object = await db
      .selectFrom("file_storage_objects")
      .select("id")
      .where("object_key", "=", asset.object_key)
      .executeTakeFirstOrThrow();
    return object.id;
  }
  if (source.fileId)
    return (await authorizeFileItem(db, ctx.actor, source.fileId))
      .storage_object_id;
  return fail(400, "image_reference_source_required");
}

export async function registerVisualReferences(
  db: DB,
  ctx: ToolContext,
  source: { assetId?: string; fileId?: string },
  objectId: string,
  parts: StoredExtractPart[],
) {
  if ((await visualSourceAccess(db, ctx, source)) !== objectId)
    fail(409, "image_reference_source_changed");
  const result: { referenceImageId: string; filename: string }[] = [];
  for (const part of parts) {
    if (part.type !== "image") continue;
    const row = await db
      .selectFrom("file_derivatives")
      .select("id")
      .where("source_id", "=", objectId)
      .where("kind", "=", "extract-image")
      .where("recipe", "=", part.recipe)
      .executeTakeFirst();
    if (!row) fail(409, "image_reference_missing");
    const receipt = {
      kind: "file_image_reference",
      referenceImageId: row.id,
      source,
      objectId,
      filename: part.filename,
    };
    const digest = createHash("sha256")
      .update(JSON.stringify(receipt))
      .digest("hex");
    const operation = `${ctx.jobId}:${digest}`;
    const hash = createHash("sha256").update(operation).digest("hex");
    const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
    await db
      .insertInto("ai_operations")
      .values({
        id,
        user_id: ctx.actor.id,
        job_id: ctx.jobId!,
        digest,
        result: JSON.stringify(receipt),
        created_at: new Date().toISOString(),
      })
      .onConflict((oc) => oc.column("id").doNothing())
      .execute();
    result.push({ referenceImageId: row.id, filename: part.filename });
  }
  return result;
}
