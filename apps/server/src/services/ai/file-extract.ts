import { randomUUID } from "node:crypto";
import sharp from "sharp";
import type { DB, Schema } from "@db/index.js";
import {
  createStorage,
  storageDefaults,
  storageRuntime,
  type StorageRuntime,
  type StorageConfig,
} from "../../adapters/storage.js";
import { derivativeKey } from "../storage-policy.js";
import { extractFilePartsAsync } from "./extract-content.js";

export type StoredExtractPart =
  | { type: "text"; text: string }
  | { type: "image"; recipe: string; mime: string; filename: string };

export type FileExtract = {
  status: "pending" | "ready" | "failed";
  error?: string;
  parts: StoredExtractPart[];
  markdown: string;
};

const running = new Set<string>();

function profileConfig(profile: Schema["storage_profiles"]): StorageConfig {
  return {
    ...storageDefaults,
    ...JSON.parse(profile.config),
    provider: profile.provider,
  } as StorageConfig;
}

function parseResult(raw: string): StoredExtractPart[] {
  try {
    const value = JSON.parse(raw) as { parts?: StoredExtractPart[] };
    return Array.isArray(value.parts) ? value.parts : [];
  } catch {
    return [];
  }
}

function markdownOf(parts: StoredExtractPart[]) {
  return parts
    .filter((part): part is StoredExtractPart & { type: "text" } => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

export async function storageObjectIdForAsset(
  db: DB,
  asset: Pick<Schema["assets"], "id" | "object_key">,
) {
  const row = await db
    .selectFrom("file_storage_objects")
    .select("id")
    .where("object_key", "=", asset.object_key)
    .executeTakeFirst();
  return row?.id ?? asset.id;
}

export async function loadFileExtract(
  db: DB,
  objectId: string,
): Promise<FileExtract | null> {
  const row = await db
    .selectFrom("file_extracts")
    .selectAll()
    .where("storage_object_id", "=", objectId)
    .executeTakeFirst();
  if (!row) return null;
  const parts = parseResult(row.result);
  return {
    status: row.status === "ready" || row.status === "failed" ? row.status : "pending",
    error: row.error ?? undefined,
    parts,
    markdown: markdownOf(parts),
  };
}

async function markExtract(
  db: DB,
  objectId: string,
  status: FileExtract["status"],
  result = "{}",
  error: string | null = null,
) {
  const now = new Date().toISOString();
  const existing = await db
    .selectFrom("file_extracts")
    .select("storage_object_id")
    .where("storage_object_id", "=", objectId)
    .executeTakeFirst();
  if (existing)
    await db
      .updateTable("file_extracts")
      .set({ status, result, error, updated_at: now })
      .where("storage_object_id", "=", objectId)
      .execute();
  else
    await db
      .insertInto("file_extracts")
      .values({
        storage_object_id: objectId,
        status,
        result,
        error,
        updated_at: now,
      })
      .execute();
}

async function normalizeImage(data: Buffer) {
  try {
    const out = await sharp(data, {
      limitInputPixels: 25000000,
      animated: false,
    })
      .rotate()
      .resize(1600, 1600, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
    return out;
  } catch {
    return null;
  }
}

async function runExtract(
  db: DB,
  objectId: string,
  runtime: StorageRuntime,
) {
  if (running.has(objectId)) return;
  running.add(objectId);
  try {
    const current = await loadFileExtract(db, objectId);
    if (current?.status === "ready") return;
    await markExtract(db, objectId, "pending");
    const object = await db
      .selectFrom("file_storage_objects")
      .selectAll()
      .where("id", "=", objectId)
      .executeTakeFirst();
    if (!object) {
      await markExtract(db, objectId, "failed", "{}", "文件不存在");
      return;
    }
    if (object.mime.startsWith("image/")) {
      await markExtract(db, objectId, "ready", JSON.stringify({ parts: [] }));
      return;
    }
    const item = await db
      .selectFrom("file_items")
      .select("name")
      .where("storage_object_id", "=", objectId)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    const profile = await db
      .selectFrom("storage_profiles")
      .selectAll()
      .where("id", "=", object.profile_id)
      .executeTakeFirstOrThrow();
    const config = profileConfig(profile);
    const storage = createStorage(runtime);
    const body = await storage.read(config, object.object_key);
    const filename = item?.name || object.object_key;
    const raw = await extractFilePartsAsync(filename, Buffer.from(body));
    const parts: StoredExtractPart[] = [];
    let index = 0;
    for (const part of raw) {
      if (part.type === "text") {
        parts.push(part);
        continue;
      }
      const jpeg = await normalizeImage(part.data);
      if (!jpeg) continue;
      const recipe = `img-${index++}`;
      const id = randomUUID();
      const key = derivativeKey(object.id, object.mime, recipe, `${id}.jpg`);
      await storage.put(config, key, jpeg, "image/jpeg", part.filename);
      let retained = false;
      try {
        const inserted = await db
          .insertInto("file_derivatives")
          .values({
            id,
            source_id: objectId,
            profile_id: profile.id,
            object_key: key,
            kind: "extract-image",
            recipe,
            mime: "image/jpeg",
            size: jpeg.length,
            created_at: new Date().toISOString(),
          })
          .onConflict((oc) =>
            oc.columns(["source_id", "kind", "recipe"]).doNothing(),
          )
          .executeTakeFirst();
        retained = Number(inserted.numInsertedOrUpdatedRows) > 0;
        parts.push({
          type: "image",
          recipe,
          mime: "image/jpeg",
          filename: part.filename,
        });
      } finally {
        if (!retained) await storage.remove(config, key).catch(() => {});
      }
    }
    await markExtract(
      db,
      objectId,
      "ready",
      JSON.stringify({ parts }),
    );
  } catch (error) {
    await markExtract(
      db,
      objectId,
      "failed",
      "{}",
      error instanceof Error ? error.message : "解析失败",
    );
  } finally {
    running.delete(objectId);
  }
}

export function beginFileExtract(
  db: DB,
  objectId: string,
  runtime: StorageRuntime = storageRuntime(),
) {
  void runExtract(db, objectId, runtime);
}

export async function waitFileExtract(
  db: DB,
  objectId: string,
  runtime: StorageRuntime = storageRuntime(),
  timeout = 20000,
): Promise<FileExtract> {
  beginFileExtract(db, objectId, runtime);
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const row = await loadFileExtract(db, objectId);
    if (row && row.status !== "pending") return row;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  return (
    (await loadFileExtract(db, objectId)) ?? {
      status: "pending",
      parts: [],
      markdown: "",
    }
  );
}

export async function readExtractImages(
  db: DB,
  objectId: string,
  parts: StoredExtractPart[],
  runtime: StorageRuntime = storageRuntime(),
) {
  const object = await db
    .selectFrom("file_storage_objects")
    .select(["profile_id"])
    .where("id", "=", objectId)
    .executeTakeFirst();
  if (!object) return [];
  const profile = await db
    .selectFrom("storage_profiles")
    .selectAll()
    .where("id", "=", object.profile_id)
    .executeTakeFirstOrThrow();
  const storage = createStorage(runtime);
  const config = profileConfig(profile);
  const images: { part: StoredExtractPart & { type: "image" }; data: Buffer }[] =
    [];
  for (const part of parts) {
    if (part.type !== "image") continue;
    const row = await db
      .selectFrom("file_derivatives")
      .selectAll()
      .where("source_id", "=", objectId)
      .where("kind", "=", "extract-image")
      .where("recipe", "=", part.recipe)
      .executeTakeFirst();
    if (!row) continue;
    images.push({
      part,
      data: Buffer.from(await storage.read(config, row.object_key)),
    });
  }
  return images;
}
