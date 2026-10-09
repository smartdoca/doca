import { z } from "zod";
import { readSnapshot, type DB } from "@db/index.js";
import { fail } from "@core/shared/errors.js";
import { batchSourceSchema } from "./image-batch-requirements.js";
import { aiSessionFolderId, fileExplorerHref } from "./file-locations.js";
import {
  aiSessionFolderLocation,
  requireAISessionFolder,
} from "./session-file-folders.js";

const deliveryEntrySchema = z
  .object({
    bookIndex: z.number().int().positive(),
    source: batchSourceSchema,
    sourceFilename: z.string().min(1),
    physicalPage: z.number().int().positive(),
    referenceImageId: z.string().uuid(),
    assetId: z.string().uuid(),
    sourcePageFilename: z.string().min(1),
    reviewPassed: z.boolean(),
  })
  .strict();
const sessionBindingSchema = z
  .object({ sessionId: z.string().uuid(), title: z.string().min(1) })
  .strict();
const deliveryMetadataSchema = z
  .object({
    assetId: z.string().uuid(),
    aiSessionFolder: sessionBindingSchema,
  })
  .passthrough();

export type ImageBatchFileDeliveryEntry = z.infer<typeof deliveryEntrySchema>;
export type ImageBatchFileDelivery = ImageBatchFileDeliveryEntry & {
  fileId: string;
  name: string;
  mime: string;
  path: string;
  href: string;
  contentUrl: string;
  downloadUrl: string;
};

/** Resolve existing host file nodes; never create or repair missing deliveries. */
export async function imageBatchFileDeliveries(
  db: DB,
  actorId: string,
  sessionId: string,
  entries: readonly ImageBatchFileDeliveryEntry[],
): Promise<ImageBatchFileDelivery[]> {
  if (!db.isTransaction)
    return readSnapshot(db, (tx) =>
      imageBatchFileDeliveries(tx, actorId, sessionId, entries),
    );
  const parsed = z.array(deliveryEntrySchema).safeParse(entries);
  if (
    !z.string().uuid().safeParse(actorId).success ||
    !z.string().uuid().safeParse(sessionId).success ||
    !parsed.success
  )
    fail(400, "批次交付文件的来源或页码无效。");
  const folder = await requireAISessionFolder(
    db,
    actorId,
    aiSessionFolderId(sessionId),
  );
  const location = aiSessionFolderLocation(folder);
  const assetIds = [...new Set(parsed.data.map((entry) => entry.assetId))];
  const filesByAsset = new Map<string, Awaited<ReturnType<typeof findFiles>>>();
  // Bound SQL parameter counts without truncating the delivery list.
  async function findFiles(ids: string[]) {
    return db
      .selectFrom("file_items")
      .select(["id", "storage_object_id", "name", "mime", "metadata"])
      .where("owner_id", "=", actorId)
      .where("storage_namespace", "=", "host")
      .where("parent_type", "=", "system")
      .where("parent_id", "=", "ai")
      .where("deleted_at", "is", null)
      .where("storage_object_id", "in", ids)
      .execute();
  }
  for (let offset = 0; offset < assetIds.length; offset += 500) {
    for (const file of await findFiles(assetIds.slice(offset, offset + 500))) {
      const files = filesByAsset.get(file.storage_object_id) ?? [];
      files.push(file);
      filesByAsset.set(file.storage_object_id, files);
    }
  }
  return parsed.data.map((entry) => {
    const files = filesByAsset.get(entry.assetId) ?? [];
    if (files.length !== 1)
      fail(
        409,
        files.length
          ? "批次图片对应多个文件节点，无法确定交付文件。原记录已保留。"
          : "批次图片的文件节点不存在或不可访问。原记录已保留，不自动补造。",
      );
    const file = files[0]!;
    let metadata: unknown;
    try {
      metadata = JSON.parse(file.metadata);
    } catch {
      fail(409, "批次图片的文件来源绑定无效。原记录已保留。");
    }
    const binding = deliveryMetadataSchema.safeParse(metadata);
    if (
      !binding.success ||
      binding.data.assetId !== entry.assetId ||
      binding.data.aiSessionFolder.sessionId !== sessionId ||
      !file.name ||
      !file.mime
    )
      fail(409, "批次图片的文件来源绑定无效。原记录已保留。");
    const contentUrl = `/api/v1/files/items/${file.id}/content`;
    return {
      ...entry,
      fileId: file.id,
      name: file.name,
      mime: file.mime,
      path: location.path,
      href: `#${fileExplorerHref(location.href, file.id)}&session=${encodeURIComponent(sessionId)}`,
      contentUrl,
      downloadUrl: `${contentUrl}?download=1`,
    };
  });
}
