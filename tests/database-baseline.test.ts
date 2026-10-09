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

  it("rejects the 0.1.12 baseline while preserving its tables and records", async () => {
    const directory = await mkdtemp(join(tmpdir(), "doca-old-baseline-"));
    directories.push(directory);
    const path = join(directory, "doca.db");
    const original = new Sqlite(path);
    original.pragma("journal_mode = WAL");
    original.exec(
      "create table schema_baseline (id text primary key, created_at text not null); create table retained_records (id text primary key, content text not null)",
    );
    const oldBaseline = "doca-2026-10-03-credentials-v2";
    original
      .prepare("insert into schema_baseline values (?, ?)")
      .run(oldBaseline, "2026-10-03T00:00:00.000Z");
    original
      .prepare("insert into retained_records values (?, ?)")
      .run("original", "Keep the original data unchanged");
    const tables = original
      .prepare(
        "select name, sql from sqlite_master where type = 'table' order by name",
      )
      .all();
    original.close();

    await expect(openDatabase({ driver: "sqlite", path })).rejects.toThrow(
      "Database baseline is not supported",
    );
    const retained = new Sqlite(path, { readonly: true });
    try {
      expect(
        retained
          .prepare(
            "select name, sql from sqlite_master where type = 'table' order by name",
          )
          .all(),
      ).toEqual(tables);
      expect(retained.prepare("select id from schema_baseline").get()).toEqual({
        id: oldBaseline,
      });
      expect(retained.prepare("select * from retained_records").all()).toEqual([
        { id: "original", content: "Keep the original data unchanged" },
      ]);
    } finally {
      retained.close();
    }
  });
});
