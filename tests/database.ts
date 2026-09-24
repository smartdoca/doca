import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import {
  openDatabase,
  type DatabaseConfig,
} from "@db/connection.js";
/** Each PostgreSQL fixture owns an isolated schema; never run tests in user data. */
export async function openTestDatabase(config: DatabaseConfig) {
  const testUrl = process.env.DOCA_TEST_POSTGRES;
  if (!testUrl || config.driver !== "sqlite" || config.path !== ":memory:")
    return openDatabase(config);
  const schema = "doca_test_" + randomUUID().replaceAll("-", "");
  const control = new Pool({ connectionString: testUrl, max: 1 });
  // Serialize fixture DDL so another fixture cannot drop a catalog object while
  // a new schema is being created.
  await control.query("select pg_advisory_lock(741093215)");
  await control.query(`create schema ${schema}`);
  const url = new URL(testUrl);
  url.searchParams.set("options", "-csearch_path=" + schema);
  try {
    const db = await openDatabase({
      driver: "postgres",
      url: url.href,
      schema,
    });
    await control.query("select pg_advisory_unlock(741093215)");
    const destroy = db.destroy.bind(db);
    let closing: Promise<void> | undefined;
    db.destroy = () =>
      (closing ??= (async () => {
        try {
          await destroy();
          await control.query("select pg_advisory_lock(741093215)");
          await control.query(`drop schema if exists ${schema} cascade`);
        } finally {
          await control.end();
        }
      })());
    return db;
  } catch (error) {
    await control.query(`drop schema if exists ${schema} cascade`);
    await control.end();
    throw error;
  }
}
