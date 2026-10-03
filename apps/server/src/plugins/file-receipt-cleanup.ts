import type { DB } from "@db/index.js";
import { transact } from "@db/transactions.js";
import {
  createStorage,
  storageConfigForProfile,
  type StorageConfig,
  type StorageRuntime,
} from "../adapters/storage.js";
import { findReceipt, lockFileActor } from "./file-receipts.js";

/** Reclaims only reserved staging bytes. Receipts and referenced objects survive. */
export async function cleanupFileReceipts(
  db: DB,
  runtime: StorageRuntime,
  now = new Date(),
) {
  const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const rows = await db
    .selectFrom("file_operation_receipts")
    .selectAll()
    .where("object_key", "is not", null)
    .where((eb) =>
      eb.or([eb("status", "=", "completed"), eb("created_at", "<", cutoff)]),
    )
    .where((eb) =>
      eb.or([eb("cleanup_at", "is", null), eb("cleanup_at", "<", cutoff)]),
    )
    .orderBy("created_at")
    .limit(100)
    .execute();
  const storage = createStorage(runtime);
  let cleaned = 0;
  for (const row of rows) {
    const identity = {
      plugin_id: row.plugin_id,
      user_id: row.user_id,
      operation: row.operation,
      operation_key: row.operation_key,
    };
    await transact(db, async (tx) => {
      await lockFileActor(tx, row.user_id);
      const current = await findReceipt(tx, identity);
      if (
        !current?.object_key ||
        !current.profile_id ||
        (current.cleanup_at && current.cleanup_at >= cutoff)
      )
        return;
      const profile = await tx
        .selectFrom("storage_profiles")
        .selectAll()
        .where("id", "=", current.profile_id)
        .executeTakeFirstOrThrow();
      const config = storageConfigForProfile(runtime, profile);
      const referenced = await tx
        .selectFrom("file_storage_objects")
        .select("id")
        .where("profile_id", "=", current.profile_id)
        .where("object_key", "=", current.object_key)
        .executeTakeFirst();
      if (!referenced)
        await storage
          .remove(config, current.object_key)
          .catch((error: { code?: string; name?: string }) => {
            if (error.code !== "ENOENT" && error.name !== "NoSuchKey")
              throw error;
          });
      await storage.removeReservedTemporaries(config, current.object_key);
      let update = tx
        .updateTable("file_operation_receipts")
        .set({
          cleanup_at: now.toISOString(),
          ...(current.status === "completed"
            ? { object_id: null, profile_id: null, object_key: null }
            : {}),
        });
      for (const [column, value] of Object.entries(identity))
        update = update.where(column as keyof typeof identity, "=", value);
      await update.execute();
      cleaned++;
    });
  }
  return cleaned;
}
