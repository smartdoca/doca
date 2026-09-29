import Sqlite from "better-sqlite3";
import { Kysely, PostgresDialect, SqliteDialect, sql, type Transaction } from "kysely";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Pool } from "pg";
import type { DatabaseConfig } from "./connection.js";

/** Subscriptions and delivery attempts. Isolated so retries do not lock the business database. */
const BASELINE = "webhooks-2026-09-29";

export interface WebhookSchema {
  webhook_meta: { id: string; value: string };
  webhook_cursor: { id: string; seq: number };
  webhook_endpoints: {
    id: string;
    name: string;
    url: string;
    headers: string;
    events: string;
    enabled: number;
    since_seq: number;
    created_at: string;
    updated_at: string;
  };
  webhook_deliveries: {
    id: string;
    endpoint_id: string;
    event_id: string;
    event_seq: number;
    event_type: string;
    body: string;
    status: string;
    attempts: number;
    available_at: string;
    lease_token?: string | null;
    lease_until?: string | null;
    last_status?: number | null;
    last_error?: string | null;
    created_at: string;
    delivered_at?: string | null;
  };
}

export type WebhookDB = Kysely<WebhookSchema>;

const statements = [
  `CREATE TABLE IF NOT EXISTS "webhook_meta" ("id" varchar(32) primary key, "value" varchar(80) not null)`,
  `CREATE TABLE IF NOT EXISTS "webhook_cursor" ("id" varchar(32) primary key, "seq" integer not null)`,
  `CREATE TABLE IF NOT EXISTS "webhook_endpoints" ("id" varchar(36) primary key, "name" varchar(80) not null, "url" text not null, "headers" text not null, "events" text not null, "enabled" integer not null, "since_seq" integer not null, "created_at" varchar(32) not null, "updated_at" varchar(32) not null)`,
  `CREATE TABLE IF NOT EXISTS "webhook_deliveries" ("id" varchar(36) primary key, "endpoint_id" varchar(36) not null references "webhook_endpoints" ("id") on delete cascade, "event_id" varchar(36) not null, "event_seq" integer not null, "event_type" varchar(80) not null, "body" text not null, "status" varchar(16) not null, "attempts" integer not null, "available_at" varchar(32) not null, "lease_token" varchar(36), "lease_until" varchar(32), "last_status" integer, "last_error" varchar(300), "created_at" varchar(32) not null, "delivered_at" varchar(32), constraint "webhook_delivery_once" unique ("endpoint_id", "event_id"))`,
  `CREATE INDEX IF NOT EXISTS "webhook_deliveries_due" on "webhook_deliveries" ("status", "available_at", "id")`,
];

/** Sibling database. There is no migration from an older webhook schema. */
export function webhookDatabaseConfig(main: DatabaseConfig): DatabaseConfig {
  if (main.driver === "sqlite") {
    if (main.path === ":memory:") return { driver: "sqlite", path: ":memory:" };
    return {
      driver: "sqlite",
      path: join(dirname(resolve(main.path)), "webhooks.db"),
    };
  }
  const url = new URL(main.url);
  const name = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
    throw new Error("Invalid database name for the webhook database");
  url.pathname = `/${name}_webhooks`;
  return {
    driver: "postgres",
    url: url.href,
    poolMax: Math.max(1, Math.min(4, main.poolMax ?? 4)),
  };
}

async function ensurePostgresDatabase(url: string) {
  const target = new URL(url);
  const name = decodeURIComponent(target.pathname.replace(/^\//, ""));
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
    throw new Error("Invalid webhook database name");
  const maintenance = new URL(url);
  maintenance.pathname = "/postgres";
  const pool = new Pool({ connectionString: maintenance.href, max: 1 });
  try {
    const existing = await pool.query(
      "select 1 from pg_database where datname = $1",
      [name],
    );
    if (!existing.rowCount) await pool.query(`create database ${name}`);
  } finally {
    await pool.end();
  }
}

async function postgresPool(url: string, poolMax: number) {
  const open = () => new Pool({ connectionString: url, max: poolMax });
  const pool = open();
  try {
    await pool.query("select 1");
    return pool;
  } catch (error) {
    await pool.end();
    if ((error as { code?: string }).code !== "3D000") throw error;
    await ensurePostgresDatabase(url);
    const retry = open();
    try {
      await retry.query("select 1");
      return retry;
    } catch (retryError) {
      await retry.end();
      throw retryError;
    }
  }
}

export async function openWebhookDatabase(config: DatabaseConfig) {
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
      pool: await postgresPool(config.url, config.poolMax ?? 4),
    });
  const db = new Kysely<WebhookSchema>({ dialect });
  try {
    await ensureWebhookSchema(db);
    return db;
  } catch (error) {
    await db.destroy();
    throw error;
  }
}

async function ensureWebhookSchema(db: WebhookDB) {
  const tables = await db.introspection.getTables();
  if (tables.length) {
    const baseline = await db
      .selectFrom("webhook_meta")
      .select("value")
      .where("id", "=", "baseline")
      .executeTakeFirst();
    if (baseline?.value !== BASELINE)
      throw new Error(
        "Webhook database baseline is not supported; create a new database",
      );
    return;
  }
  await db.transaction().execute(async (tx) => {
    for (const statement of statements) await sql.raw(statement).execute(tx);
    await tx
      .insertInto("webhook_meta")
      .values({ id: "baseline", value: BASELINE })
      .execute();
    await tx
      .insertInto("webhook_cursor")
      .values({ id: "events", seq: 0 })
      .execute();
  });
}

export async function webhookTransact<T>(
  db: WebhookDB,
  fn: (tx: Transaction<WebhookSchema>) => Promise<T>,
): Promise<T> {
  if (db.isTransaction) return fn(db as Transaction<WebhookSchema>);
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.transaction().execute(fn);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (
        attempt >= 4 ||
        !["40001", "40P01", "SQLITE_BUSY", "SQLITE_BUSY_SNAPSHOT"].includes(
          code ?? "",
        )
      )
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 5 * 2 ** attempt));
    }
  }
}
