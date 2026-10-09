import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { z } from "zod";
import type { DB, Schema } from "../../../../db/src/index.js";
import { databaseRuntimeScope } from "../../../../db/src/runtime-scope.js";
import { readSnapshot, transact } from "../../../../db/src/transactions.js";
import { enqueueProjection } from "../automation/jobs.js";
import { fail } from "../../shared/errors.js";

export const RECENT_HISTORY_COUNT = 20;
export const HISTORY_SAMPLE_INTERVAL = 10;
const limit = 32 * 1024 ** 2;
const snapshotSchema = z
  .object({
    id: z.string().uuid(),
    resource_id: z.string().uuid(),
    seq: z.number().int().nonnegative(),
    checkpoint: z.string().min(1),
    title: z.string(),
    author_id: z.string().uuid(),
    created_at: z.string().datetime(),
    recovery_json: z.string().nullable(),
  })
  .strict();
const envelopeSchema = z
  .object({ version: z.literal(1), snapshot: snapshotSchema })
  .strict();
const batchSchema = z
  .object({
    version: z.literal(1),
    snapshots: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
      )
      .length(HISTORY_SAMPLE_INTERVAL),
  })
  .strict();
export type HistorySnapshot = z.infer<typeof snapshotSchema>;
export interface HistoryFileStore {
  readonly currentId: string;
  putImmutable(
    key: string,
    bytes: Uint8Array,
    mime: string,
  ): Promise<{ storeId: string; key: string; size: number; sha256: string }>;
  read(
    storeId: string,
    key: string,
    size: number,
    sha256: string,
  ): Promise<Uint8Array>;
  remove(storeId: string, key: string): Promise<void>;
}
/** Host-owned storage port, inherited by database transactions; never exposed to business plugins. */
export function bindHistoryFileStore(db: DB, store: HistoryFileStore) {
  const scope = databaseRuntimeScope(db);
  scope.set("history-file-store", store);
  return () => {
    if (scope.get("history-file-store") === store)
      scope.delete("history-file-store");
  };
}
function fileStore(db: DB) {
  const store = databaseRuntimeScope(db).get("history-file-store") as
    HistoryFileStore | undefined;
  if (!store)
    fail(503, "历史快照暂时不可用", { code: "history_snapshot_unavailable" });
  return store;
}
const sha = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
function canonical(row: Schema["document_versions"]) {
  return snapshotSchema.parse(row);
}
function batchJson(rows: Schema["document_versions"][]) {
  return JSON.stringify({
    version: 1,
    snapshots: rows.map((row) => ({
      id: row.id,
      sha256: sha(JSON.stringify(canonical(row))),
    })),
  });
}
function encode(row: Schema["document_versions"]) {
  const snapshot = canonical(row);
  const json = Buffer.from(JSON.stringify({ version: 1, snapshot }));
  if (json.length > limit)
    throw new Error(
      "History snapshot exceeds 32 MiB; database originals retained",
    );
  const bytes = gzipSync(json);
  const hash = sha(bytes);
  return {
    snapshot,
    bytes,
    hash,
    key: `host/document-history/${snapshot.resource_id}/${snapshot.id}/${hash}.json.gz`,
  };
}
export async function readArchiveSnapshot(
  db: DB,
  index: Schema["document_version_archives"],
) {
  try {
    if (index.archive_version !== 1) fail(409, "不支持的历史版本格式");
    const data = await fileStore(db).read(
      index.store_id,
      index.object_key,
      index.size,
      index.sha256,
    );
    if (data.length !== Number(index.size) || sha(data) !== index.sha256)
      throw new Error("Invalid archive hash");
    const { snapshot } = envelopeSchema.parse(
      JSON.parse(gunzipSync(data, { maxOutputLength: limit }).toString("utf8")),
    );
    for (const key of [
      "id",
      "resource_id",
      "seq",
      "title",
      "author_id",
      "created_at",
    ] as const)
      if (snapshot[key] !== index[key])
        throw new Error("Archive index mismatch");
    return snapshot;
  } catch (error) {
    if ((error as { status?: number }).status === 409) throw error;
    fail(503, "历史快照暂时不可用", { code: "history_snapshot_unavailable" });
  }
}
/** Call only after checking the document's current read-history or restore permission. */
export async function readHistorySnapshot(
  db: DB,
  resourceId: string,
  id: string,
) {
  return transact(db, async (tx) => {
    const recent = await tx
      .selectFrom("document_versions")
      .selectAll()
      .where("resource_id", "=", resourceId)
      .where("id", "=", id)
      .executeTakeFirst();
    if (recent) return recent;
    const archived = await tx
      .selectFrom("document_version_archives")
      .selectAll()
      .where("resource_id", "=", resourceId)
      .where("id", "=", id)
      .executeTakeFirst();
    return archived ? readArchiveSnapshot(tx, archived) : undefined;
  });
}
async function candidates(db: DB, resourceId: string) {
  const enough = await db
    .selectFrom("document_versions")
    .select("id")
    .where("resource_id", "=", resourceId)
    .offset(RECENT_HISTORY_COUNT + HISTORY_SAMPLE_INTERVAL - 1)
    .limit(1)
    .executeTakeFirst();
  if (!enough) return [];
  return db
    .selectFrom("document_versions")
    .selectAll()
    .where("resource_id", "=", resourceId)
    .orderBy("created_at", "asc")
    .orderBy("id", "asc")
    .limit(HISTORY_SAMPLE_INTERVAL)
    .execute();
}
export async function queueHistoryRetention(db: DB, resourceId: string) {
  const enough = await db
    .selectFrom("document_versions")
    .select("id")
    .where("resource_id", "=", resourceId)
    .offset(RECENT_HISTORY_COUNT + HISTORY_SAMPLE_INTERVAL - 1)
    .limit(1)
    .executeTakeFirst();
  if (enough)
    await enqueueProjection(db, "history-retention", resourceId, {
      resourceId,
    });
}
async function garbage(db: DB, storeId: string, key: string) {
  await db
    .insertInto("document_history_garbage")
    .values({
      store_id: storeId,
      object_key: key,
      created_at: new Date().toISOString(),
    })
    .onConflict((oc) =>
      oc
        .columns(["store_id", "object_key"])
        .doUpdateSet({ created_at: new Date().toISOString() }),
    )
    .execute();
}

/** Upload and readback happen outside transactions; only verified bytes permit sampling. */
export async function retainDocumentHistory(db: DB, resourceId: string) {
  const store = fileStore(db);
  let sampled = 0;
  for (let round = 0; round < 25; round++) {
    const prepared = await transact(db, async (tx) => {
      const resource = await tx
        .selectFrom("resources")
        .select("id")
        .where("id", "=", resourceId)
        .where("deleted_at", "is", null)
        .executeTakeFirst();
      if (!resource) return null;
      const rows = await candidates(tx, resourceId);
      if (!rows.length) return null;
      const batch = batchJson(rows);
      const encoded = encode(rows.at(-1)!); // Newest rollback point in the oldest group of ten.
      const existing = await tx
        .selectFrom("document_history_archive_operations")
        .selectAll()
        .where("resource_id", "=", resourceId)
        .executeTakeFirst();
      if (existing) batchSchema.parse(JSON.parse(existing.batch_json));
      if (
        existing &&
        (existing.batch_json !== batch ||
          existing.store_id !== store.currentId ||
          existing.sha256 !== encoded.hash)
      ) {
        await garbage(tx, existing.store_id, existing.object_key);
        await tx
          .deleteFrom("document_history_archive_operations")
          .where("resource_id", "=", resourceId)
          .execute();
      }
      if (
        !existing ||
        existing.batch_json !== batch ||
        existing.store_id !== store.currentId ||
        existing.sha256 !== encoded.hash
      ) {
        await tx
          .insertInto("document_history_archive_operations")
          .values({
            resource_id: resourceId,
            snapshot_id: encoded.snapshot.id,
            store_id: store.currentId,
            object_key: encoded.key,
            size: encoded.bytes.length,
            sha256: encoded.hash,
            batch_json: batch,
            created_at: new Date().toISOString(),
          })
          .execute();
        // Reservation precedes external I/O, so even an interrupted upload has a durable cleanup reference.
        await garbage(tx, store.currentId, encoded.key);
      } else if (
        existing.object_key !== encoded.key ||
        Number(existing.size) !== encoded.bytes.length ||
        existing.snapshot_id !== encoded.snapshot.id
      ) {
        throw new Error(
          "History archive operation does not match its immutable snapshot",
        );
      }
      return { ...encoded, batch };
    });
    if (!prepared) break;
    const uploaded = await store.putImmutable(
      prepared.key,
      prepared.bytes,
      "application/gzip",
    );
    if (
      uploaded.storeId !== store.currentId ||
      uploaded.key !== prepared.key ||
      uploaded.size !== prepared.bytes.length ||
      uploaded.sha256 !== prepared.hash
    )
      throw new Error("History archive upload did not match its reservation");
    const readback = await store.read(
      uploaded.storeId,
      uploaded.key,
      uploaded.size,
      uploaded.sha256,
    );
    if (
      readback.length !== prepared.bytes.length ||
      sha(readback) !== prepared.hash
    )
      throw new Error(
        "History archive readback failed; database originals retained",
      );
    const committed = await transact(db, async (tx) => {
      const operation = await tx
        .selectFrom("document_history_archive_operations")
        .selectAll()
        .where("resource_id", "=", resourceId)
        .executeTakeFirst();
      if (
        !operation ||
        operation.object_key !== prepared.key ||
        operation.store_id !== uploaded.storeId ||
        operation.batch_json !== prepared.batch
      )
        return false;
      const resource = await tx
        .selectFrom("resources")
        .select("deleted_at")
        .where("id", "=", resourceId)
        .executeTakeFirst();
      const rows = await candidates(tx, resourceId);
      if (
        !resource ||
        resource.deleted_at ||
        rows.length !== HISTORY_SAMPLE_INTERVAL ||
        batchJson(rows) !== prepared.batch
      ) {
        await garbage(tx, operation.store_id, operation.object_key);
        await tx
          .deleteFrom("document_history_archive_operations")
          .where("resource_id", "=", resourceId)
          .execute();
        return false;
      }
      const snapshot = prepared.snapshot;
      const isAI =
        snapshot.recovery_json !== null &&
        JSON.parse(snapshot.recovery_json).origin === "ai";
      await tx
        .insertInto("document_version_archives")
        .values({
          id: snapshot.id,
          resource_id: resourceId,
          seq: snapshot.seq,
          title: snapshot.title,
          author_id: snapshot.author_id,
          created_at: snapshot.created_at,
          is_ai: isAI ? 1 : 0,
          store_id: uploaded.storeId,
          object_key: uploaded.key,
          size: uploaded.size,
          sha256: uploaded.sha256,
          archive_version: 1,
          archived_at: new Date().toISOString(),
        })
        .execute();
      const deleted = await tx
        .deleteFrom("document_versions")
        .where("resource_id", "=", resourceId)
        .where(
          "id",
          "in",
          rows.map((r) => r.id),
        )
        .executeTakeFirst();
      if (Number(deleted.numDeletedRows) !== HISTORY_SAMPLE_INTERVAL)
        throw new Error("History group changed during sampling");
      await tx
        .deleteFrom("document_history_archive_operations")
        .where("resource_id", "=", resourceId)
        .execute();
      await tx
        .deleteFrom("document_history_garbage")
        .where("store_id", "=", uploaded.storeId)
        .where("object_key", "=", uploaded.key)
        .execute();
      return true;
    });
    if (!committed) break;
    sampled++;
  }
  // Preserve a new durable occurrence when a very large backlog needs another pump.
  if (sampled === 25)
    await transact(db, (tx) => queueHistoryRetention(tx, resourceId));
  return sampled;
}

/** Purge removes archive references in the same transaction, never files belonging to live copies. */
export async function purgeHistoryArchives(db: DB, resourceIds: string[]) {
  for (const table of [
    "document_version_archives",
    "document_history_archive_operations",
  ] as const) {
    const objects = await db
      .selectFrom(table)
      .select(["store_id", "object_key"])
      .where("resource_id", "in", resourceIds)
      .execute();
    for (const object of objects)
      await garbage(db, object.store_id, object.object_key);
    await db
      .deleteFrom(table)
      .where("resource_id", "in", resourceIds)
      .execute();
  }
  await db
    .deleteFrom("projection_jobs")
    .where("kind", "=", "history-retention")
    .where(
      "id",
      "in",
      resourceIds.map((id) => `history-retention:${id}`),
    )
    .execute();
}
export async function cleanupHistoryGarbage(db: DB, now = Date.now()) {
  const store = fileStore(db);
  const pending = await db
    .selectFrom("document_history_garbage")
    .selectAll()
    .where("created_at", "<=", new Date(now - 3600_000).toISOString())
    .limit(20)
    .execute();
  for (const object of pending) {
    const referenced = await readSnapshot(db, async (tx) => {
      const archive = await tx
        .selectFrom("document_version_archives")
        .select("id")
        .where("store_id", "=", object.store_id)
        .where("object_key", "=", object.object_key)
        .executeTakeFirst();
      const operation = await tx
        .selectFrom("document_history_archive_operations")
        .select("resource_id")
        .where("store_id", "=", object.store_id)
        .where("object_key", "=", object.object_key)
        .executeTakeFirst();
      return !!(archive || operation);
    });
    if (referenced) continue;
    try {
      await store.remove(object.store_id, object.object_key);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await db
      .deleteFrom("document_history_garbage")
      .where("store_id", "=", object.store_id)
      .where("object_key", "=", object.object_key)
      .where("created_at", "=", object.created_at)
      .execute();
  }
}
