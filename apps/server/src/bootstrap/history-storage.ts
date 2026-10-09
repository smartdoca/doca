import Sqlite from "better-sqlite3";
import { Kysely, PostgresDialect, SqliteDialect } from "kysely";
import { Pool } from "pg";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Schema } from "@db/index.js";
import { registerDriver } from "@db/transactions.js";
import {
  upgradeHistorySchema,
  PRE_HISTORY_SCHEMA_BASELINE,
} from "@db/history-schema.js";
import { bindHistoryFileStore } from "@core/modules/history/archive.js";
import { createHostFileStore } from "../services/host-file-store.js";
import { storageRuntime } from "../adapters/storage.js";
import { rollbackHistoryStorage } from "../services/history-maintenance.js";
import { config } from "./config.js";

const [action, ...args] = process.argv.slice(2);
if (!["upgrade", "rollback"].includes(action ?? ""))
  throw new Error("Use history:upgrade or history:rollback");
if (!args.includes("--apply")) {
  console.log(
    `Offline ${action}: stop every Doca host and back up both the database and file store first. Re-run with --apply. Upgrade accepts only ${PRE_HISTORY_SCHEMA_BASELINE}; rollback restores retained points, not sampled-away history.`,
  );
  process.exit(0);
}
const cfg = config().database;
function sqliteDialect(path: string) {
  const database = new Sqlite(path, { fileMustExist: true });
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 5000");
  database.pragma("synchronous = FULL");
  return new SqliteDialect({ database });
}
// Dedicated maintenance connection: no schema creation, baseline fallback or automatic upgrade.
const dialect =
  cfg.driver === "sqlite"
    ? sqliteDialect(cfg.path)
    : new PostgresDialect({
        pool: new Pool({ connectionString: cfg.url, max: 1 }),
      });
const db = new Kysely<Schema>({ dialect });
registerDriver(db, cfg.driver);
let unbind: (() => void) | undefined;
try {
  if (action === "upgrade") {
    await upgradeHistorySchema(db);
    console.log(
      "History storage upgrade committed; all existing snapshot bytes remain in the database. Start the new host to begin sampling.",
    );
  } else {
    const manifestAt = args.indexOf("--manifest");
    const manifestPath = manifestAt >= 0 ? args[manifestAt + 1] : undefined;
    if (!manifestPath || manifestPath.startsWith("--"))
      throw new Error(
        "Rollback requires --manifest <new-file-path> to preserve cloud backup references",
      );
    unbind = bindHistoryFileStore(db, createHostFileStore(storageRuntime()));
    await writeFile(
      resolve(manifestPath),
      JSON.stringify(
        {
          version: 1,
          archived: await db
            .selectFrom("document_version_archives")
            .selectAll()
            .execute(),
          pending: await db
            .selectFrom("document_history_archive_operations")
            .selectAll()
            .execute(),
          garbage: await db
            .selectFrom("document_history_garbage")
            .selectAll()
            .execute(),
        },
        null,
        2,
      ),
      { flag: "wx", mode: 0o600 },
    );
    const count = await rollbackHistoryStorage(db);
    console.log(
      `Restored ${count} retained cloud snapshots to the database; cloud files remain preserved. Start the previous host.`,
    );
  }
} finally {
  unbind?.();
  await db.destroy();
}
