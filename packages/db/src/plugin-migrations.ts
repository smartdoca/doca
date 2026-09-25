import type { DB } from "./schema.js";

export interface PluginMigrationRecord {
  readonly pluginId: string;
  readonly version: string;
  readonly appliedAt: string;
}

/**
 * Durable migration state for the plugin host.
 *
 * The return value is intentionally structural so the database package does
 * not depend on the plugin runtime package.
 */
export function createPluginMigrationStore(db: DB) {
  return {
    async get(pluginId: string) {
      const row = await db
        .selectFrom("plugin_migrations")
        .select("version")
        .where("plugin_id", "=", pluginId)
        .executeTakeFirst();
      return row?.version;
    },

    async set(pluginId: string, version: string) {
      const row = {
        plugin_id: pluginId,
        version,
        applied_at: new Date().toISOString(),
      };
      await db
        .insertInto("plugin_migrations")
        .values(row)
        .onConflict((conflict) =>
          conflict.column("plugin_id").doUpdateSet({
            version: row.version,
            applied_at: row.applied_at,
          }),
        )
        .execute();
    },

    async list(): Promise<readonly PluginMigrationRecord[]> {
      const rows = await db
        .selectFrom("plugin_migrations")
        .selectAll()
        .orderBy("plugin_id")
        .execute();
      return rows.map((row) => ({
        pluginId: row.plugin_id,
        version: row.version,
        appliedAt: row.applied_at,
      }));
    },
  };
}
