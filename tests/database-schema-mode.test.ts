import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../packages/db/src/index.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("database schema startup modes", () => {
  it("migrates once and lets application replicas validate", async () => {
    const directory = await mkdtemp(join(tmpdir(), "doca-schema-"));
    directories.push(directory);
    const config = {
      driver: "sqlite" as const,
      path: join(directory, "doca.db"),
    };

    const migration = await openDatabase(config, { schema: "migrate" });
    await migration.destroy();

    const replica = await openDatabase(config, { schema: "validate" });
    await expect(
      replica.selectFrom("settings").select("id").executeTakeFirst(),
    ).resolves.toBeTruthy();
    await replica.destroy();
  });

  it("rejects a replica before the migration job has run", async () => {
    const directory = await mkdtemp(join(tmpdir(), "doca-schema-"));
    directories.push(directory);
    const config = {
      driver: "sqlite" as const,
      path: join(directory, "doca.db"),
    };

    await expect(openDatabase(config, { schema: "validate" })).rejects.toThrow(
      "run pnpm migrate",
    );
  });
});
