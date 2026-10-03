import { currentSchemaTables } from "@db/introspection.js";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Kysely } from "kysely";
import type { DB } from "@db/index.js";
import { transact } from "@db/transactions.js";
import type {
  PluginDatabaseSchema,
  PluginDatabaseServiceV1,
  PluginDatabaseTransaction,
  PluginDataFilter,
  PluginDataRow,
  PluginDataQuery,
  PluginStoredObject,
  PluginObjectStorageServiceV1,
} from "@smartdoca/plugin-sdk/storage";
import { createPluginStorageNamespace } from "./plugin-storage-namespaces.js";
import type { HostFileStore } from "./host-file-store.js";

const identifier = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,47}$/)
  .refine((v) => !Object.hasOwn(Object.prototype, v));
const column = z
  .object({ type: z.enum(["text", "integer", "real"]), nullable: z.boolean() })
  .strict();
const schemaParser = z
  .object({
    version: z.literal(1),
    tables: z.record(
      identifier,
      z
        .object({
          columns: z.record(identifier, column),
          primaryKey: z.array(identifier).min(1).max(16),
          unique: z.array(z.array(identifier).min(1).max(16)).max(16),
        })
        .strict(),
    ),
  })
  .strict();
const valueParser = z.union([
  z.string().max(2_000_000),
  z.number().finite(),
  z.null(),
]);
const filtersParser = z
  .array(
    z
      .object({
        column: identifier,
        operator: z.enum(["=", "!=", "<", "<=", ">", ">="]),
        value: valueParser,
      })
      .strict(),
  )
  .max(100);
const queryParser = z
  .object({
    where: filtersParser.optional(),
    orderBy: z
      .array(
        z
          .object({ column: identifier, direction: z.enum(["asc", "desc"]) })
          .strict(),
      )
      .max(16)
      .optional(),
    limit: z.number().int().min(1).max(1000).optional(),
  })
  .strict();
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const physicalTable = (id: string, generation: number, table: string) =>
  "plugin_" + hash(JSON.stringify([id, generation, table])).slice(0, 56);
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
      .join(",")}}`;
  return JSON.stringify(value);
};
export class PluginStorageError extends Error {
  constructor(
    readonly code: "invalid-input" | "conflict" | "unavailable",
    message: string,
  ) {
    super(message);
    this.name = "PluginStorageError";
  }
}
const invalid = () =>
  new PluginStorageError("invalid-input", "Invalid plugin storage input");
function parse<T>(parser: z.ZodType<T>, value: unknown): T {
  const result = parser.safeParse(value);
  if (!result.success) throw invalid();
  return result.data;
}
async function safe<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof PluginStorageError) throw error;
    const code = (error as { code?: string }).code;
    throw new PluginStorageError(
      [
        "23505",
        "SQLITE_CONSTRAINT_PRIMARYKEY",
        "SQLITE_CONSTRAINT_UNIQUE",
        "40001",
        "40P01",
        "SQLITE_BUSY",
        "SQLITE_BUSY_SNAPSHOT",
      ].includes(code ?? "")
        ? "conflict"
        : "unavailable",
      "Plugin storage operation failed",
    );
  }
}
/** Called only as part of the registry transaction for an explicit new installation. */
export async function installPluginStorage(
  db: DB,
  id: string,
  dataVersion: string,
) {
  const namespace = createPluginStorageNamespace(id);
  const row = await db
    .selectFrom("plugin_storage_namespaces")
    .selectAll()
    .where("plugin_id", "=", id)
    .executeTakeFirst();
  if (row?.state === "active") {
    if (
      row.data_version !== dataVersion ||
      row.namespace !== namespace.database
    )
      throw new Error("Plugin data structure differs from installation");
    return;
  }
  if (!row)
    await db
      .insertInto("plugin_storage_namespaces")
      .values({
        plugin_id: id,
        namespace: namespace.database,
        data_version: dataVersion,
        generation: 1,
        state: "active",
        definition: null,
        created_at: new Date().toISOString(),
      })
      .execute();
  else
    await db
      .updateTable("plugin_storage_namespaces")
      .set({
        generation: row.generation + 1,
        data_version: dataVersion,
        state: "active",
        definition: null,
      })
      .where("plugin_id", "=", id)
      .where("generation", "=", row.generation)
      .execute();
}
/** Fence earlier instance handles and clear only this generation's private business data. Normal user files are retained. */
export async function removePluginStorage(db: DB, id: string) {
  const namespace = createPluginStorageNamespace(id);
  const row = await db
    .updateTable("plugin_storage_namespaces")
    .set({ state: "removed" })
    .where("plugin_id", "=", id)
    .where("state", "=", "active")
    .returningAll()
    .executeTakeFirstOrThrow();
  if (row.namespace !== namespace.database)
    throw new Error("Plugin storage installation is unavailable");
  if (row.definition) {
    const definition = parse(schemaParser, JSON.parse(row.definition));
    for (const name of Object.keys(definition.tables))
      await db.schema
        .dropTable(physicalTable(id, row.generation, name))
        .execute();
  }
  const objects = await db
    .selectFrom("plugin_private_objects")
    .selectAll()
    .where("plugin_id", "=", id)
    .where("generation", "=", row.generation)
    .execute();
  for (const object of objects) {
    namespace.assertObjectKey(object.object_key, row.generation);
    await db
      .insertInto("plugin_object_garbage")
      .values({
        id: randomUUID(),
        store_id: object.store_id,
        object_key: object.object_key,
        created_at: new Date().toISOString(),
      })
      .execute();
  }
  await db
    .deleteFrom("plugin_private_objects")
    .where("plugin_id", "=", id)
    .where("generation", "=", row.generation)
    .execute();
}
/** Durable garbage intents survive process crashes and storage outages. Archives never enter this collector. */
export async function cleanupPluginObjects(db: DB, files: HostFileStore) {
  const pending = await db
    .selectFrom("plugin_object_garbage")
    .selectAll()
    .orderBy("created_at")
    .limit(100)
    .execute();
  let failed = 0;
  for (const row of pending) {
    try {
      if (
        !row.object_key.startsWith("plugins/") ||
        !row.object_key.includes("/objects/")
      )
        throw new Error("Invalid plugin garbage key");
      try {
        await files.remove(row.store_id, row.object_key);
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !== "ENOENT" &&
          (error as { name?: string }).name !== "NoSuchKey"
        )
          throw error;
      }
      await db
        .deleteFrom("plugin_object_garbage")
        .where("id", "=", row.id)
        .execute();
    } catch {
      failed++;
    }
  }
  return { processed: pending.length - failed, failed };
}
export interface PluginStorageServices {
  readonly database: PluginDatabaseServiceV1;
  readonly objects: PluginObjectStorageServiceV1;
}

/** Internal factory: the SDK receives only these already-bound services. */
export async function bindPluginStorage(
  db: DB,
  files: HostFileStore,
  id: string,
  dataVersion: string,
): Promise<PluginStorageServices> {
  const namespace = createPluginStorageNamespace(id);
  const installed = await db
    .selectFrom("plugin_storage_namespaces")
    .selectAll()
    .where("plugin_id", "=", id)
    .executeTakeFirstOrThrow();
  if (
    installed.state !== "active" ||
    installed.data_version !== dataVersion ||
    installed.namespace !== namespace.database
  )
    throw new Error("Plugin storage installation is unavailable");
  const generation = installed.generation;
  async function current(tx: DB, lock = false) {
    // UPDATE locks the namespace for writes and schema declarations on every backend.
    if (lock) {
      const locked = await tx
        .updateTable("plugin_storage_namespaces")
        .set({ generation })
        .where("plugin_id", "=", id)
        .where("generation", "=", generation)
        .where("state", "=", "active")
        .executeTakeFirst();
      if (!Number(locked.numUpdatedRows))
        throw new PluginStorageError(
          "unavailable",
          "Plugin storage installation is no longer active",
        );
    }
    const row = await tx
      .selectFrom("plugin_storage_namespaces")
      .selectAll()
      .where("plugin_id", "=", id)
      .where("generation", "=", generation)
      .where("state", "=", "active")
      .executeTakeFirst();
    if (!row || row.data_version !== dataVersion)
      throw new PluginStorageError(
        "unavailable",
        "Plugin storage installation is no longer active",
      );
    return row;
  }
  async function structure(tx: DB) {
    const row = await current(tx);
    if (!row.definition)
      throw new PluginStorageError(
        "unavailable",
        "Declare the plugin database schema first",
      );
    return parse(schemaParser, JSON.parse(row.definition));
  }
  const validateSchema = (input: PluginDatabaseSchema) => {
    const schema = parse(schemaParser, input);
    if (
      !Object.keys(schema.tables).length ||
      Object.keys(schema.tables).length > 100
    )
      throw invalid();
    for (const table of Object.values(schema.tables)) {
      if (
        !Object.keys(table.columns).length ||
        Object.keys(table.columns).length > 100
      )
        throw invalid();
      for (const columns of [table.primaryKey, ...table.unique]) {
        if (
          new Set(columns).size !== columns.length ||
          columns.some((c) => !Object.hasOwn(table.columns, c))
        )
          throw invalid();
      }
      if (table.primaryKey.some((c) => table.columns[c]!.nullable))
        throw invalid();
    }
    return schema;
  };
  function transactionService(
    tx: DB,
    active: () => boolean,
  ): PluginDatabaseTransaction {
    async function table(name: string) {
      if (!active())
        throw new PluginStorageError(
          "unavailable",
          "Plugin transaction has ended",
        );
      parse(identifier, name);
      const schema = await structure(tx);
      const definition = schema.tables[name];
      if (!definition) throw invalid();
      return {
        definition,
        name: physicalTable(id, generation, name),
        query: tx as Kysely<any>,
      };
    }
    const cell = (
      columns: PluginDatabaseSchema["tables"][string]["columns"],
      name: string,
      value: unknown,
    ) => {
      if (!Object.hasOwn(columns, name)) throw invalid();
      const c = columns[name]!;
      const v = parse(valueParser, value);
      if (
        v === null
          ? !c.nullable
          : c.type === "text"
            ? typeof v !== "string"
            : typeof v !== "number" ||
              (c.type === "integer" &&
                (!Number.isSafeInteger(v) || v < -2147483648 || v > 2147483647))
      )
        throw invalid();
      return v;
    };
    const values = (
      columns: PluginDatabaseSchema["tables"][string]["columns"],
      input: PluginDataRow,
      full: boolean,
    ) => {
      const v = parse(z.record(identifier, valueParser), input);
      if (
        !Object.keys(v).length ||
        (full && Object.keys(columns).some((c) => !Object.hasOwn(v, c)))
      )
        throw invalid();
      for (const [name, value] of Object.entries(v)) cell(columns, name, value);
      return v;
    };
    const where = (
      query: any,
      columns: PluginDatabaseSchema["tables"][string]["columns"],
      input: readonly PluginDataFilter[],
      required: boolean,
    ) => {
      const clauses = parse(filtersParser, input);
      if (required && !clauses.length) throw invalid();
      for (const filter of clauses) {
        cell(columns, filter.column, filter.value);
        if (filter.value === null && !["=", "!="].includes(filter.operator))
          throw invalid();
        query = query.where(
          filter.column,
          filter.value === null
            ? filter.operator === "="
              ? "is"
              : "is not"
            : filter.operator,
          filter.value,
        );
      }
      return query;
    };
    return Object.freeze({
      select: (name: string, input: PluginDataQuery = {}) =>
        safe(async () => {
          const t = await table(name),
            q = parse(queryParser, input);
          let query = where(
            t.query.selectFrom(t.name).selectAll(),
            t.definition.columns,
            q.where ?? [],
            false,
          );
          for (const order of q.orderBy ?? []) {
            if (!Object.hasOwn(t.definition.columns, order.column))
              throw invalid();
            query = query.orderBy(order.column, order.direction);
          }
          return query.limit(q.limit ?? 100).execute() as Promise<
            PluginDataRow[]
          >;
        }),
      insert: (name: string, rows: readonly PluginDataRow[]) =>
        safe(async () => {
          const t = await table(name);
          if (!Array.isArray(rows) || !rows.length || rows.length > 1000)
            throw invalid();
          await t.query
            .insertInto(t.name)
            .values(rows.map((v) => values(t.definition.columns, v, true)))
            .execute();
        }),
      update: (
        name: string,
        input: PluginDataRow,
        filters: readonly PluginDataFilter[],
      ) =>
        safe(async () => {
          const t = await table(name);
          const result = await where(
            t.query
              .updateTable(t.name)
              .set(values(t.definition.columns, input, false)),
            t.definition.columns,
            filters,
            true,
          ).executeTakeFirst();
          return Number(result.numUpdatedRows);
        }),
      remove: (name: string, filters: readonly PluginDataFilter[]) =>
        safe(async () => {
          const t = await table(name);
          const result = await where(
            t.query.deleteFrom(t.name),
            t.definition.columns,
            filters,
            true,
          ).executeTakeFirst();
          return Number(result.numDeletedRows);
        }),
    });
  }
  async function transaction<T>(
    run: (service: PluginDatabaseTransaction) => Promise<T>,
  ) {
    // User callback is never automatically retried. A retained transaction handle expires at completion.
    return safe(() =>
      db.transaction().execute(async (tx) => {
        await current(tx, true);
        let active = true;
        try {
          return await run(transactionService(tx, () => active));
        } finally {
          active = false;
        }
      }),
    );
  }
  const database: PluginDatabaseServiceV1 =
    Object.freeze<PluginDatabaseServiceV1>({
      defineSchema: (input: PluginDatabaseSchema) =>
        safe(async () => {
          const definition = canonical(validateSchema(input));
          await transact(db, async (tx) => {
            const row = await current(tx, true);
            if (row.definition) {
              if (row.definition !== definition)
                throw new PluginStorageError(
                  "conflict",
                  "Plugin database schema differs from its declaration",
                );
              // Verify persisted physical tables as well; never recreate a missing table over lost business data.
              const tables = await currentSchemaTables(tx);
              for (const [name, t] of Object.entries(
                JSON.parse(definition).tables,
              ) as [string, PluginDatabaseSchema["tables"][string]][]) {
                const physical = tables.find(
                  (v) => v.name === physicalTable(id, generation, name),
                );
                if (
                  !physical ||
                  physical.columns.length !== Object.keys(t.columns).length ||
                  Object.keys(t.columns).some(
                    (c) =>
                      !physical.columns.some((v) => {
                        const column = t.columns[c]!;
                        const type = v.dataType.toLowerCase();
                        const expectedTypes =
                          column.type === "integer"
                            ? ["integer", "int4"]
                            : column.type === "real"
                              ? ["double precision", "float8"]
                              : ["text"];
                        return (
                          v.name === c &&
                          v.isNullable === column.nullable &&
                          expectedTypes.includes(type)
                        );
                      }),
                  )
                )
                  throw new PluginStorageError(
                    "unavailable",
                    "Plugin database structure is incomplete",
                  );
              }
              return;
            }
            const schema = JSON.parse(definition) as PluginDatabaseSchema;
            for (const [name, t] of Object.entries(schema.tables)) {
              let builder: any = tx.schema.createTable(
                physicalTable(id, generation, name),
              );
              for (const [column, c] of Object.entries(t.columns))
                builder = builder.addColumn(
                  column,
                  c.type === "real" ? "double precision" : c.type,
                  (b: any) => (c.nullable ? b : b.notNull()),
                );
              builder = builder.addPrimaryKeyConstraint(
                physicalTable(id, generation, name).slice(0, 52) + "_pk",
                [...t.primaryKey],
              );
              for (let i = 0; i < t.unique.length; i++)
                builder = builder.addUniqueConstraint(
                  physicalTable(id, generation, name).slice(0, 50) + "_u" + i,
                  [...t.unique[i]!],
                );
              await builder.execute();
            }
            await tx
              .updateTable("plugin_storage_namespaces")
              .set({ definition })
              .where("plugin_id", "=", id)
              .where("generation", "=", generation)
              .execute();
          });
        }),
      transaction,
      select: (name, query) => transaction((t) => t.select(name, query)),
      insert: (name, rows) => transaction((t) => t.insert(name, rows)),
      update: (name, values, where) =>
        transaction((t) => t.update(name, values, where)),
      remove: (name, where) => transaction((t) => t.remove(name, where)),
    });
  const metadata = (row: {
    id: string;
    mime: string;
    size: number;
    sha256: string;
    created_at: string;
  }): PluginStoredObject =>
    Object.freeze({
      id: row.id,
      mime: row.mime,
      size: row.size,
      sha256: row.sha256,
      createdAt: row.created_at,
    });
  const objects: PluginObjectStorageServiceV1 =
    Object.freeze<PluginObjectStorageServiceV1>({
      put: (input) =>
        safe(async () => {
          if (
            !(input?.data instanceof Uint8Array) ||
            input.data.length > 32 * 1024 ** 2 ||
            !/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(
              input.mime,
            ) ||
            input.mime.length > 160
          )
            throw invalid();
          await current(db);
          const objectId = randomUUID(),
            key = namespace.objectKey(generation, objectId, randomUUID());
          const stored = await files.putImmutable(key, input.data, input.mime);
          const row = {
            plugin_id: id,
            generation,
            id: objectId,
            store_id: stored.storeId,
            object_key: key,
            mime: input.mime,
            size: stored.size,
            sha256: stored.sha256,
            created_at: new Date().toISOString(),
          };
          // Upload precedes the transaction. A rejected/stale commit can leave an unreferenced immutable object, never partial data.
          await transact(db, async (tx) => {
            await current(tx, true);
            await tx.insertInto("plugin_private_objects").values(row).execute();
          });
          return metadata(row);
        }),
      get: (objectId) =>
        safe(async () => {
          parse(z.string().uuid(), objectId);
          await current(db);
          const row = await db
            .selectFrom("plugin_private_objects")
            .selectAll()
            .where("plugin_id", "=", id)
            .where("generation", "=", generation)
            .where("id", "=", objectId)
            .executeTakeFirst();
          if (!row) return null;
          namespace.assertObjectKey(row.object_key, generation);
          const data = await files.read(
            row.store_id,
            row.object_key,
            row.size,
            row.sha256,
          );
          await current(db);
          return { object: metadata(row), data: new Uint8Array(data) };
        }),
      remove: (objectId) =>
        safe(async () => {
          parse(z.string().uuid(), objectId);
          const row = await transact(db, async (tx) => {
            await current(tx, true);
            const row = await tx
              .selectFrom("plugin_private_objects")
              .selectAll()
              .where("plugin_id", "=", id)
              .where("generation", "=", generation)
              .where("id", "=", objectId)
              .executeTakeFirst();
            if (!row) return null;
            namespace.assertObjectKey(row.object_key, generation);
            await tx
              .insertInto("plugin_object_garbage")
              .values({
                id: randomUUID(),
                store_id: row.store_id,
                object_key: row.object_key,
                created_at: new Date().toISOString(),
              })
              .execute();
            await tx
              .deleteFrom("plugin_private_objects")
              .where("plugin_id", "=", id)
              .where("generation", "=", generation)
              .where("id", "=", objectId)
              .execute();
            return row;
          });
          if (row) await cleanupPluginObjects(db, files);
        }),
    });
  return Object.freeze({ database, objects });
}
