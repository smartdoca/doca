import { createHash, randomUUID } from "node:crypto";
import type { DB, Schema } from "@db/index.js";
import { transact } from "@db/transactions.js";
import { enqueueProjection } from "@core/modules/automation/jobs.js";
import {
  checkStorage,
  requireCapability,
} from "@core/modules/access/operation-policy.js";
import { fail } from "@core/shared/errors.js";
import { lockAIUser } from "@core/modules/ai/config.js";
import {
  createStorage,
  storageConfigForProfile,
  type StorageRuntime,
  type StorageConfig,
} from "../../adapters/storage.js";
import { filePolicy, objectKey, uploadLimits } from "../storage-policy.js";
import { registerStoredObject } from "../stored-objects.js";

export function cleanFileName(value: string, fallback = "未命名") {
  const name = value.replace(/[\x00-\x1f\x7f/\\]/g, "_").trim();
  return (name || fallback).slice(0, 255);
}

export async function storeUserFile(
  db: DB,
  input: {
    actorId: string;
    ownerId: string;
    parentType: "system" | "folder";
    parentId: string;
    filename: string;
    mime: string;
    body: Buffer;
    storage?: StorageRuntime;
    storageNamespace?: string;
    /** Reserved by the durable plugin operation before writing bytes. */
    preparedObject?: { id: string; profileId: string };
    beforeCreate?: (tx: DB) => Promise<Schema["file_items"] | undefined>;
    afterCreate?: (tx: DB, row: Schema["file_items"]) => Promise<void>;
  },
) {
  if (!input.storage) fail(503, "文件存储未配置");
  if (!input.body.length) fail(400, "文件内容为空");
  if (input.body.length > uploadLimits.asset) fail(413, "文件超过 20MB 上限");
  const filename = cleanFileName(input.filename);
  const mime = input.mime.split(";")[0]!.trim() || "application/octet-stream";
  const sha256 = createHash("sha256").update(input.body).digest("hex");
  const size = input.body.length;
  const storage = createStorage(input.storage);
  const profile = await db
    .selectFrom("storage_profiles")
    .selectAll()
    .where(
      input.preparedObject ? "id" : "active",
      "=",
      input.preparedObject?.profileId ?? 1,
    )
    .executeTakeFirstOrThrow();
  const config = storageConfigForProfile(input.storage, profile);
  const findExisting = (tx: DB) =>
    tx
      .selectFrom("file_storage_objects")
      .selectAll()
      .where("profile_id", "=", profile.id)
      .where("object_key", "like", `${input.storageNamespace ?? "host"}/%`)
      .where("sha256", "=", sha256)
      .where("size", "=", size)
      .where("mime", "=", mime)
      .executeTakeFirst();
  let stored: { config: StorageConfig; key: string } | undefined;
  let committedKey: string | undefined;
  try {
    let candidate = await findExisting(db);
    if (!candidate) {
      const id = input.preparedObject?.id ?? randomUUID();
      const key = objectKey(id, mime, input.storageNamespace ?? "host");
      await storage.put(
        config,
        key,
        input.body,
        mime,
        filename,
        !!input.preparedObject,
      );
      stored = { config, key };
      candidate = {
        id,
        profile_id: profile.id,
        object_key: key,
        sha256,
        size,
        mime,
        category: filePolicy(mime, size).category,
        ai_description: null,
        ai_status: "skipped",
        ai_model: null,
        ai_generated_at: null,
        created_at: new Date().toISOString(),
      };
    }
    const result = await transact(db, async (tx) => {
      await lockAIUser(tx, input.actorId);
      const replay = await input.beforeCreate?.(tx);
      if (replay) {
        const object = await tx
          .selectFrom("file_storage_objects")
          .selectAll()
          .where("id", "=", replay.storage_object_id)
          .executeTakeFirstOrThrow();
        return { row: replay, object };
      }
      await requireCapability(tx, input.actorId, "assets.upload");
      await checkStorage(tx, input.ownerId, size);
      let object = await findExisting(tx);
      if (!object) {
        object = candidate!;
        await registerStoredObject(tx, object);
      }
      const now = new Date().toISOString();
      const row: Schema["file_items"] = {
        storage_namespace: input.storageNamespace ?? "host",
        id: randomUUID(),
        owner_id: input.ownerId,
        parent_type: input.parentType,
        parent_id: input.parentId,
        storage_object_id: object.id,
        name: filename,
        mime,
        size,
        metadata: "{}",
        ai_description_override: null,
        locked: 0,
        version: 1,
        created_at: now,
        updated_at: now,
        deleted_at: null,
        delete_batch: null,
      };
      await tx.insertInto("file_items").values(row).execute();
      await input.afterCreate?.(tx, row);
      await enqueueProjection(tx, "search-file", row.id, { fileId: row.id });
      return { row, object };
    });
    committedKey = result.object.object_key;
    return result.row;
  } finally {
    if (stored && committedKey !== stored.key && !input.preparedObject)
      await storage.remove(stored.config, stored.key).catch(() => undefined);
  }
}
