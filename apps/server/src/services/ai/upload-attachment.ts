import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import type { Readable } from "node:stream";
import sharp from "sharp";
import type { DB, Schema } from "@db/index.js";
import { transact } from "@db/transactions.js";
import {
  checkStorage,
  requireCapability,
} from "@core/modules/access/operation-policy.js";
import {
  checkUploadLimits,
  userUploadLimits,
} from "@core/modules/ai/upload-policy.js";
import { fail } from "@core/shared/errors.js";
import {
  createStorage,
  storageConfigForProfile,
  type StorageRuntime,
} from "../../adapters/storage.js";
import { objectKey } from "../storage-policy.js";
import { stageUpload } from "../upload-stream.js";
import { registerStoredObject } from "../stored-objects.js";
import { enqueueProjection } from "@core/modules/automation/jobs.js";
import { beginFileExtract } from "./file-extract.js";
import { pendingAISessionFolder } from "./session-file-folders.js";

export async function uploadAIAttachment(
  db: DB,
  userId: string,
  name: string,
  source: Readable | Buffer,
  runtime: StorageRuntime,
) {
  await requireCapability(db, userId, "ai.create");
  await requireCapability(db, userId, "assets.upload");
  const limits = await userUploadLimits(db, userId);
  const filename = Array.from(name.replace(/[\x00-\x1f\x7f/\\]/g, "_"))
    .slice(0, 240)
    .join("");
  const storage = createStorage(runtime);
  const profile = await db
    .selectFrom("storage_profiles")
    .selectAll()
    .where("active", "=", 1)
    .executeTakeFirstOrThrow();
  const config = storageConfigForProfile(runtime, profile);
  const staged = await stageUpload(
    runtime.root || tmpdir(),
    source,
    filename,
    limits.maxFileBytes || Number.MAX_SAFE_INTEGER,
  );
  const id = randomUUID();
  const key = objectKey(id, staged.mime);
  let stored = false,
    committed = false;
  let createdFileId: string | undefined;
  try {
    checkUploadLimits(limits, [staged.size]);
    const image = staged.mime.startsWith("image/");
    if (image) {
      if (
        !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(
          staged.mime,
        )
      )
        fail(400, "upload_format_unsupported");
      await sharp(staged.path, { limitInputPixels: 25000000 }).metadata();
    } else if (!image &&
      !/\.(txt|md|csv|json|log|yaml|yml|pdf|docx|pptx|xlsx)$/i.test(filename)
    )
      fail(400, "upload_format_unsupported");
    if (/\.pdf$/i.test(filename) && staged.mime !== "application/pdf")
      fail(400, "upload_format_unsupported");
    await checkStorage(db, userId, staged.size);
    await storage.putStream(
      config,
      key,
      staged.stream(),
      staged.size,
      staged.mime,
      filename,
    );
    stored = true;
    const now = new Date().toISOString();
    const row = {
      id,
      owner_id: userId,
      uploaded_by: userId,
      resource_id: null,
      purpose: "ai_attachment",
      profile_id: profile.id,
      object_key: key,
      filename,
      mime: staged.mime,
      size: staged.size,
      created_at: now,
      deleted_at: null,
    };
    await transact(db, async (tx) => {
      await requireCapability(tx, userId, "ai.create");
      await requireCapability(tx, userId, "assets.upload");
      checkUploadLimits(await userUploadLimits(tx, userId), [staged.size]);
      await checkStorage(tx, userId, staged.size);
      await tx.insertInto("assets").values(row).execute();
      await registerStoredObject(tx, {
        id,
        profile_id: profile.id,
        object_key: key,
        sha256: staged.sha256,
        size: staged.size,
        mime: staged.mime,
        ai_description: null,
        ai_status: "skipped",
        ai_model: null,
        ai_generated_at: null,
        created_at: now,
      });
      const fileId = randomUUID();
      const file: Schema["file_items"] = {
          id: fileId,
          owner_id: userId,
          parent_type: "system",
          parent_id: "ai",
          storage_object_id: id,
          name: filename,
          mime: staged.mime,
          size: staged.size,
          metadata: JSON.stringify({ assetId: id, aiSessionFolder: pendingAISessionFolder }),
          ai_description_override: null,
          locked: 0,
          version: 1,
          created_at: now,
          updated_at: now,
          deleted_at: null,
          delete_batch: null,
        };
      await tx.insertInto("file_items").values(file).execute();
      createdFileId = fileId;
      await enqueueProjection(tx, "search-file", fileId, { fileId });
      await tx
        .insertInto("audit_events")
        .values({
          id: randomUUID(),
          actor_id: userId,
          resource_id: null,
          action: "asset.uploaded",
          created_at: now,
        })
        .execute();
    });
    committed = true;
    beginFileExtract(db, id, runtime);
    return { ...row, fileId: createdFileId!, extractStatus: image ? "ready" : "pending" };
  } finally {
    await staged.cleanup();
    if (stored && !committed) await storage.remove(config, key);
  }
}
