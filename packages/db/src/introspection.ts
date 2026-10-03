import { sql, type Kysely, type TableMetadata } from "kysely";
import { databaseDriver } from "./transactions.js";
/** Scope catalog reads before introspection, so unrelated schemas cannot affect validation. */
export async function currentSchemaTables(
  db: Kysely<any>,
): Promise<TableMetadata[]> {
  if (databaseDriver(db) === "sqlite") return db.introspection.getTables();
  const result = await sql<{
    table_name: string;
    schema_name: string;
    column_name: string;
    data_type: string;
    nullable: boolean;
    has_default: boolean;
    is_view: boolean;
  }>`select c.relname as table_name, n.nspname as schema_name,
      a.attname as column_name, typ.typname as data_type,
      not a.attnotnull as nullable, a.atthasdef as has_default,
      c.relkind = 'v' as is_view
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    join pg_catalog.pg_attribute a on a.attrelid = c.oid
    join pg_catalog.pg_type typ on typ.oid = a.atttypid
    where n.nspname = current_schema() and c.relkind in ('r', 'v', 'p')
      and a.attnum > 0 and not a.attisdropped
    order by c.relname, a.attnum`.execute(db);
  const tables = new Map<string, TableMetadata>();
  for (const row of result.rows) {
    let table = tables.get(row.table_name);
    if (!table) {
      table = {
        name: row.table_name,
        schema: row.schema_name,
        isView: row.is_view,
        isForeign: false,
        columns: [],
      };
      tables.set(row.table_name, table);
    }
    (table.columns as Array<TableMetadata["columns"][number]>).push({
      name: row.column_name,
      dataType: row.data_type,
      isNullable: row.nullable,
      hasDefaultValue: row.has_default,
      // This helper validates column structure, not serial/default expressions.
      isAutoIncrementing: false,
    });
  }
  return [...tables.values()];
}
