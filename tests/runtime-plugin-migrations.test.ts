import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createPluginMigrationStore,
  openDatabase,
} from "../packages/db/src/index.js";

describe("durable plugin migrations", () => {
  it("persists versions across database restarts and updates in place", async () => {
    const directory = await mkdtemp(join(tmpdir(), "doca-plugin-migrations-"));
    const path = join(directory, "runtime.sqlite");
    try {
      const first = await openDatabase({ driver: "sqlite", path });
      const migrations = createPluginMigrationStore(first);
      await migrations.set("doca.documents", "1.0.0");
      await migrations.set("doca.files", "2.0.0");
      await first.destroy();

      const reopened = await openDatabase({ driver: "sqlite", path });
      const persisted = createPluginMigrationStore(reopened);
      expect(await persisted.get("doca.documents")).toBe("1.0.0");
      await persisted.set("doca.documents", "1.1.0");
      expect(await persisted.list()).toMatchObject([
        { pluginId: "doca.documents", version: "1.1.0" },
        { pluginId: "doca.files", version: "2.0.0" },
      ]);
      await reopened.destroy();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
