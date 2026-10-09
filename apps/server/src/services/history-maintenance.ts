import { sql } from "kysely";
import type { DB } from "@db/index.js";
import { transact } from "@db/transactions.js";
import {
  HISTORY_SCHEMA_BASELINE,
  HISTORY_ROLLBACK_BASELINE,
  PRE_HISTORY_SCHEMA_BASELINE,
  validateHistorySchema,
} from "@db/history-schema.js";
import { readArchiveSnapshot } from "@core/modules/history/archive.js";

/** Offline rollback imports retained points only; the nine sampled-away points cannot be reconstructed. */
export async function rollbackHistoryStorage(db: DB) {
  const baseline = await db
    .selectFrom("schema_baseline")
    .select("id")
    .execute();
  if (
    baseline.length !== 1 ||
    ![HISTORY_SCHEMA_BASELINE, HISTORY_ROLLBACK_BASELINE].includes(
      baseline[0]!.id,
    )
  )
    throw new Error(
      "History rollback accepts only the history-storage-v1 database",
    );
  await validateHistorySchema(db);
  // An interrupted conversion must not be sampled again by a restarted host.
  // Only this explicit maintenance command accepts the resumable marker.
  await transact(db, async (tx) => {
    await tx
      .updateTable("schema_baseline")
      .set({ id: HISTORY_ROLLBACK_BASELINE })
      .where("id", "=", HISTORY_SCHEMA_BASELINE)
      .execute();
  });
  let restored = 0;
  for (;;) {
    const indexes = await db
      .selectFrom("document_version_archives")
      .selectAll()
      .orderBy("id")
      .limit(100)
      .execute();
    if (!indexes.length) break;
    for (const index of indexes) {
      const snapshot = await readArchiveSnapshot(db, index);
      await transact(db, async (tx) => {
        const current = await tx
          .selectFrom("document_version_archives")
          .selectAll()
          .where("id", "=", index.id)
          .executeTakeFirstOrThrow();
        if (
          current.sha256 !== index.sha256 ||
          current.store_id !== index.store_id ||
          current.object_key !== index.object_key
        )
          throw new Error("History changed during offline rollback");
        await tx.insertInto("document_versions").values(snapshot).execute();
        await tx
          .deleteFrom("document_version_archives")
          .where("id", "=", index.id)
          .execute();
      });
      restored++;
    }
  }
  await transact(db, async (tx) => {
    if (
      await tx
        .selectFrom("document_version_archives")
        .select("id")
        .limit(1)
        .executeTakeFirst()
    )
      throw new Error(
        "History archival is still running; stop every host before rollback",
      );
    await tx
      .deleteFrom("projection_jobs")
      .where("kind", "=", "history-retention")
      .execute();
    for (const table of [
      "document_history_archive_operations",
      "document_history_garbage",
      "document_version_archives",
    ])
      await sql.raw(`DROP TABLE ${table}`).execute(tx);
    await tx
      .updateTable("schema_baseline")
      .set({ id: PRE_HISTORY_SCHEMA_BASELINE })
      .where("id", "=", HISTORY_ROLLBACK_BASELINE)
      .execute();
  });
  return restored;
}
