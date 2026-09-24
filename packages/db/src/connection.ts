import Sqlite from "better-sqlite3";
import { Kysely, PostgresDialect, SqliteDialect } from "kysely";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Pool } from "pg";
import { createSchema } from "./create-schema.js";
import type { Schema } from "./schema.js";
import { registerDriver } from "./transactions.js";

export type DatabaseConfig =
  | { driver: "sqlite"; path: string }
  | { driver: "postgres"; url: string; schema?: string };
export async function openDatabase(config: DatabaseConfig) {
  let dialect;
  if (config.driver === "sqlite") {
    if (config.path !== ":memory:")
      mkdirSync(dirname(resolve(config.path)), { recursive: true });
    const sqlite = new Sqlite(config.path);
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");
    sqlite.pragma("busy_timeout = 5000");
    sqlite.pragma("synchronous = FULL");
    dialect = new SqliteDialect({ database: sqlite });
  } else
    dialect = new PostgresDialect({
      pool: new Pool({ connectionString: config.url, max: 10 }),
    });
  const db = new Kysely<Schema>({ dialect });
  registerDriver(db, config.driver);
  try {
    await createSchema(db);
  } catch (error) {
    await db.destroy();
    throw error;
  }
  return db;
}
