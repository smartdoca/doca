import { sql, type Kysely } from "kysely";
import { currentSchemaTables } from "./introspection.js";
import { databaseDriver, registerDriver } from "./transactions.js";
import type { DB } from "./schema.js";

export const PRE_HISTORY_SCHEMA_BASELINE = "doca-2026-10-08-knowledge-books-v2";
export const HISTORY_SCHEMA_BASELINE = "doca-2026-10-09-history-storage-v1";
export const HISTORY_ROLLBACK_BASELINE =
  "doca-2026-10-09-history-rollback-in-progress-v1";
export const historyTables = {
  document_version_archives: [
    "id",
    "resource_id",
    "seq",
    "title",
    "author_id",
    "created_at",
    "is_ai",
    "store_id",
    "object_key",
    "size",
    "sha256",
    "archive_version",
    "archived_at",
  ],
  document_history_archive_operations: [
    "resource_id",
    "snapshot_id",
    "store_id",
    "object_key",
    "size",
    "sha256",
    "batch_json",
    "created_at",
  ],
  document_history_garbage: ["store_id", "object_key", "created_at"],
} as const;

export async function createHistorySchema(db: Kysely<any>) {
  for (const statement of [
    `CREATE TABLE document_version_archives (id varchar(36) primary key, resource_id varchar(36) not null references resources(id) on delete cascade, seq integer not null, title varchar(160) not null, author_id varchar(36) not null references users(id), created_at varchar(32) not null, is_ai integer not null check (is_ai in (0,1)), store_id varchar(64) not null, object_key text not null unique, size integer not null check (size > 0), sha256 varchar(64) not null, archive_version integer not null check (archive_version = 1), archived_at varchar(32) not null)`,
    `CREATE INDEX document_version_archives_page ON document_version_archives(resource_id, created_at desc, id desc)`,
    `CREATE TABLE document_history_archive_operations (resource_id varchar(36) primary key references resources(id) on delete cascade, snapshot_id varchar(36) not null unique, store_id varchar(64) not null, object_key text not null unique, size integer not null, sha256 varchar(64) not null, batch_json text not null, created_at varchar(32) not null)`,
    `CREATE TABLE document_history_garbage (store_id varchar(64) not null, object_key text not null, created_at varchar(32) not null, primary key (store_id, object_key))`,
  ])
    await sql.raw(statement).execute(db);
}

export async function validateHistorySchema(db: Kysely<any>) {
  const tables = await currentSchemaTables(db);
  for (const [name, columns] of Object.entries(historyTables)) {
    const table = tables.find((t) => t.name === name);
    if (
      !table ||
      table.columns.length !== columns.length ||
      columns.some((c) => !table.columns.some((v) => v.name === c))
    )
      throw new Error("History storage schema is incomplete or unsupported");
  }
}

/** Explicit offline upgrade only; starting the host never invokes this function. */
export async function upgradeHistorySchema(db: DB) {
  return db.transaction().execute(async (tx) => {
    registerDriver(tx, databaseDriver(db));
    const baselines = await tx
      .selectFrom("schema_baseline")
      .select("id")
      .execute();
    if (
      baselines.length !== 1 ||
      baselines[0]?.id !== PRE_HISTORY_SCHEMA_BASELINE
    )
      throw new Error(
        "History upgrade accepts only doca-2026-10-08-knowledge-books-v2",
      );
    const tables = await currentSchemaTables(tx);
    if (
      Object.keys(historyTables).some((name) =>
        tables.some((t) => t.name === name),
      )
    )
      throw new Error(
        "Partial history storage structure exists; restore the backup before upgrading",
      );
    const versions = tables.find((t) => t.name === "document_versions");
    const columns = [
      "id",
      "resource_id",
      "seq",
      "checkpoint",
      "title",
      "author_id",
      "created_at",
      "recovery_json",
    ];
    if (
      !versions ||
      versions.columns.length !== columns.length ||
      columns.some((c) => !versions.columns.some((v) => v.name === c))
    )
      throw new Error(
        "Existing history structure is unsupported; no data was changed",
      );
    await createHistorySchema(tx);
    await tx
      .updateTable("schema_baseline")
      .set({ id: HISTORY_SCHEMA_BASELINE })
      .where("id", "=", PRE_HISTORY_SCHEMA_BASELINE)
      .execute();
    // Existing versions retain every byte. Queue sampling without running external I/O in this transaction.
    await sql`insert into projection_jobs (id,kind,payload,revision,attempts,available_at,status,plugin_id,max_attempts)
      select ${"history-retention:"} || resource_id, ${"history-retention"}, ${'{"resourceId":"'} || resource_id || ${'"}'}, 1, 0, ${new Date().toISOString()}, ${"queued"}, null, 5
      from document_versions group by resource_id having count(*) >= 30
      on conflict (id) do nothing`.execute(tx);
  });
}
