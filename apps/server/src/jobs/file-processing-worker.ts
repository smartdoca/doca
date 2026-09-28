import { randomUUID } from "node:crypto";
import sharp from "sharp";
import type { DB } from "@db/index.js";
import { processProjections } from "@core/modules/automation/jobs.js";
import {
  createStorage,
  storageDefaults,
  type StorageConfig,
  type StorageRuntime,
} from "../adapters/storage.js";
import { derivativeKey, filePolicy } from "../services/storage-policy.js";
import { cleanupTemporaryUploads } from "../services/upload-stream.js";
import { processFileExtract } from "../services/ai/file-extract.js";

const recipe = "thumbnail-v1";
export function createFileProcessingWorker(db: DB, runtime: StorageRuntime) {
  const storage = createStorage(runtime);
  let lastCleanup = 0;
  return {
    async pump() {
      if (Date.now() - lastCleanup > 60 * 60 * 1000) {
        await cleanupTemporaryUploads(runtime.root);
        lastCleanup = Date.now();
      }
      const thumbnails = await processProjections(
        db,
        "file-thumbnail",
        async (payload) => {
          const sourceId = String(payload.objectId);
          if (
            await db
              .selectFrom("file_derivatives")
              .select("id")
              .where("source_id", "=", sourceId)
              .where("kind", "=", "thumbnail")
              .where("recipe", "=", recipe)
              .executeTakeFirst()
          )
            return;
          const object = await db
            .selectFrom("file_storage_objects")
            .selectAll()
            .where("id", "=", sourceId)
            .executeTakeFirst();
          if (
            !object ||
            !filePolicy(object.mime, Number(object.size)).thumbnail
          )
            return;
          const profile = await db
            .selectFrom("storage_profiles")
            .selectAll()
            .where("id", "=", object.profile_id)
            .executeTakeFirstOrThrow();
          const config = {
            ...storageDefaults,
            ...JSON.parse(profile.config),
            provider: profile.provider,
          } as StorageConfig;
          const original = await storage.read(config, object.object_key);
          const thumbnail = await sharp(original, {
            limitInputPixels: 25000000,
            animated: false,
          })
            .rotate()
            .resize(480, 480, { fit: "inside", withoutEnlargement: true })
            .webp({ quality: 80 })
            .toBuffer();
          // Unique attempt IDs avoid overwriting a result produced by another worker
          // whose lease overlapped. The database selects the winning result.
          const id = randomUUID();
          const key = derivativeKey(
            object.id,
            object.mime,
            recipe,
            `${id}.webp`,
          );
          await storage.put(
            config,
            key,
            thumbnail,
            "image/webp",
            "thumbnail.webp",
          );
          let retained = false;
          try {
            const result = await db
              .insertInto("file_derivatives")
              .values({
                id,
                source_id: sourceId,
                profile_id: profile.id,
                object_key: key,
                kind: "thumbnail",
                recipe,
                mime: "image/webp",
                size: thumbnail.length,
                created_at: new Date().toISOString(),
              })
              .onConflict((oc) =>
                oc.columns(["source_id", "kind", "recipe"]).doNothing(),
              )
              .executeTakeFirst();
            retained = Number(result.numInsertedOrUpdatedRows) > 0;
          } finally {
            if (!retained) await storage.remove(config, key);
          }
        },
        2,
      );
      const extracts = await processProjections(
        db,
        "file-extract",
        (payload) =>
          processFileExtract(db, String(payload.objectId), runtime),
        2,
        5 * 60_000,
      );
      return thumbnails + extracts;
    },
  };
}
