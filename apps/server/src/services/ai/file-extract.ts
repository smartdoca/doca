import { randomUUID } from "node:crypto";
import { fail } from "@core/shared/errors.js";
import { z } from "zod";
import sharp from "sharp";
import type { DB, Schema } from "@db/index.js";
import {
  createStorage,
  storageConfigForProfile,
  storageRuntime,
  type StorageRuntime,
  type StorageConfig,
} from "../../adapters/storage.js";
import { derivativeKey } from "../storage-policy.js";
import { extractFilePartsStream } from "./extract-content.js";
import {
  enqueueProjectionOnce,
  processProjections,
} from "@core/modules/automation/jobs.js";

export type StoredExtractPart =
  | { type: "text"; text: string }
  | { type: "image"; recipe: string; mime: string; filename: string };

export type FileExtract = {
  status: "pending" | "ready" | "failed";
  error?: string;
  parts: StoredExtractPart[];
  markdown: string;
};

export const PARSER_VERSION = 4;
const activeByDatabase = new WeakMap<DB, Set<Promise<void>>>();

function profileConfig(
  runtime: StorageRuntime,
  profile: Schema["storage_profiles"],
): StorageConfig {
  return storageConfigForProfile(runtime, profile);
}

const extractResultSchema = z
  .object({
    parserVersion: z.literal(PARSER_VERSION),
    parts: z.array(
      z.discriminatedUnion("type", [
        z.object({ type: z.literal("text"), text: z.string() }).strict(),
        z
          .object({
            type: z.literal("image"),
            recipe: z.string(),
            mime: z.string(),
            filename: z.string(),
          })
          .strict(),
      ]),
    ),
  })
  .strict();

function markdownOf(parts: StoredExtractPart[]) {
  return parts
    .filter(
      (part): part is StoredExtractPart & { type: "text" } =>
        part.type === "text",
    )
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
  if (!row) fail(409, "attachment_storage_object_missing");
  return row.id;
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
  if (row.status !== "ready")
    return {
      status: row.status === "failed" ? "failed" : "pending",
      error: row.error ?? undefined,
      parts: [],
      markdown: "",
    };
  let value: unknown;
  try {
    value = JSON.parse(row.result);
  } catch {
    fail(409, "file_parser_version_or_format_invalid");
  }
  const result = extractResultSchema.safeParse(value);
  if (!result.success) fail(409, "file_parser_version_or_format_invalid");
  return {
    status: "ready",
    error: row.error ?? undefined,
    parts: result.data.parts,
    markdown: markdownOf(result.data.parts),
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
      .resize(2000, 2000, { fit: "inside", withoutEnlargement: true })
      .png()
      .toBuffer();
    return out;
  } catch {
    return null;
  }
}

export async function processFileExtract(
  db: DB,
  objectId: string,
  runtime: StorageRuntime,
) {
  const current = await loadFileExtract(db, objectId);
  if (current?.status === "ready") return;
  try {
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
    const config = profileConfig(runtime, profile);
    const storage = createStorage(runtime);
    const body = await storage.read(config, object.object_key, object.size);
    if (body.length !== object.size) fail(409, "file_content_size_changed");
    const filename = item?.name || object.object_key;
    const raw = object.mime.startsWith("image/")
      ? [
          {
            type: "image" as const,
            mime: object.mime,
            filename,
            data: Buffer.from(body),
          },
        ]
      : extractFilePartsStream(filename, Buffer.from(body));
    const parts: StoredExtractPart[] = [];
    let index = 0;
    for await (const part of raw) {
      if (part.type === "text") {
        parts.push(part);
        continue;
      }
      const png = await normalizeImage(part.data);
      if (!png) {
        parts.push({
          type: "text",
          text: `[图片 ${part.filename} 解码失败，未识别]`,
        });
        continue;
      }
      const recipe = `v${PARSER_VERSION}-img-${index++}`;
      const id = randomUUID();
      const key = derivativeKey(object.id, object.mime, recipe, `${id}.png`);
      await storage.put(config, key, png, "image/png", part.filename);
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
            mime: "image/png",
            size: png.length,
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
          mime: "image/png",
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
      JSON.stringify({ parserVersion: PARSER_VERSION, parts }),
    );
  } catch (error) {
    await markExtract(
      db,
      objectId,
      "failed",
      "{}",
      error instanceof Error ? error.message : "解析失败",
    );
  }
}

export function beginFileExtract(
  db: DB,
  objectId: string,
  runtime: StorageRuntime = storageRuntime(),
) {
  const active = activeByDatabase.get(db) ?? new Set<Promise<void>>();
  activeByDatabase.set(db, active);
  const task = (async () => {
    const current = await loadFileExtract(db, objectId);
    if (current?.status === "ready") return;
    await enqueueProjectionOnce(
      db,
      "file-extract",
      `${objectId}:v${PARSER_VERSION}`,
      { objectId },
    );
    await processProjections(
      db,
      "file-extract",
      (payload) => processFileExtract(db, String(payload.objectId), runtime),
      1,
      5 * 60_000,
    );
  })()
    .catch(() => undefined)
    .finally(() => {
      active.delete(task);
    });
  active.add(task);
  return task;
}

export async function waitForFileExtracts(db: DB) {
  const active = activeByDatabase.get(db);
  while (active?.size) await Promise.allSettled([...active]);
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
  const config = profileConfig(runtime, profile);
  const images: {
    part: StoredExtractPart & { type: "image" };
    data: Buffer;
  }[] = [];
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
