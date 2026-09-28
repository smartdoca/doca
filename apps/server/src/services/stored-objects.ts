import type { DB, Schema } from "@db/index.js";
import { enqueueProjection } from "@core/modules/automation/jobs.js";
import { filePolicy } from "./storage-policy.js";
import { fail } from "@core/shared/errors.js";

/** Register physical files in the same transaction as their business references. */
export async function registerStoredObject(
  db: DB,
  object: Schema["file_storage_objects"],
) {
  const policy = filePolicy(object.mime, object.size);
  await db
    .insertInto("file_storage_objects")
    .values({ ...object, category: policy.category })
    .execute();
  if (policy.thumbnail)
    await enqueueProjection(db, "file-thumbnail", object.id, {
      objectId: object.id,
    });
}

/** Call only after authorizing the original business reference. */
export async function thumbnailFor(db: DB, objectKey: string) {
  const row = await db
    .selectFrom("file_derivatives as d")
    .innerJoin("file_storage_objects as o", "o.id", "d.source_id")
    .selectAll("d")
    .where("o.object_key", "=", objectKey)
    .where("d.kind", "=", "thumbnail")
    .where("d.recipe", "=", "thumbnail-v1")
    .executeTakeFirst();
  if (!row) fail(404, "缩略图尚未生成");
  return { ...row, filename: "thumbnail.webp" };
}
