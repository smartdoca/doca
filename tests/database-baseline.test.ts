import Sqlite from "better-sqlite3";
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

describe("database baseline", () => {
  it("creates the current schema once and reopens it without mutation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "doca-schema-"));
    directories.push(directory);
    const config = {
      driver: "sqlite" as const,
      path: join(directory, "doca.db"),
    };

    const first = await openDatabase(config);
    await first.destroy();

    const reopened = await openDatabase(config);
    await expect(
      reopened.selectFrom("settings").select("id").executeTakeFirst(),
    ).resolves.toBeTruthy();
    await reopened.destroy();
  });

  it("rejects any non-Doca database instead of altering it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "doca-schema-"));
    directories.push(directory);
    const path = join(directory, "doca.db");
    const foreign = new Sqlite(path);
    foreign.exec("create table old_data (id text primary key)");
    foreign.close();

    await expect(openDatabase({ driver: "sqlite", path })).rejects.toThrow(
      "create a new database",
    );
  });
});
