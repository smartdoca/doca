import type { Transaction } from "kysely";
import { inheritDatabaseRuntimeScope } from "./runtime-scope.js";
import type { DB, Schema } from "./schema.js";

const drivers = new WeakMap<object, "sqlite" | "postgres">();
export function registerDriver(db: DB, driver: "sqlite" | "postgres") {
  drivers.set(db, driver);
}

/** Retry only database transactions. External side effects belong after commit. */
export async function transact<T>(
  db: DB,
  fn: (tx: Transaction<Schema>) => Promise<T>,
): Promise<T> {
  if (db.isTransaction) return fn(db as Transaction<Schema>);
  for (let attempt = 0; ; attempt++) {
    try {
      const builder = db.transaction();
      return await (
        drivers.get(db) === "postgres"
          ? builder.setIsolationLevel("serializable")
          : builder
      ).execute(tx => {
        inheritDatabaseRuntimeScope(db, tx);
        return fn(tx);
      });
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

/** A consistent read without a write lock; SQLite's driver serializes its connection. */
export async function readSnapshot<T>(
  db: DB,
  fn: (tx: Transaction<Schema>) => Promise<T>,
): Promise<T> {
  const run = (tx: Transaction<Schema>) => {
    inheritDatabaseRuntimeScope(db, tx);
    return fn(tx);
  };
  return drivers.get(db) === "postgres"
    ? db.transaction().setIsolationLevel("repeatable read").execute(run)
    : db.transaction().execute(run);
}
