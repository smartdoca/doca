import { currentSchemaTables } from "@db/introspection.js";
import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  Context,
  definePlugin,
  PluginContext,
  ContributionStore,
} from "@smartdoca/plugin-sdk";
import {
  pluginDatabaseToken,
  pluginObjectStorageToken,
  type PluginDatabaseSchema,
  type PluginDatabaseTransaction,
} from "@smartdoca/plugin-sdk/storage";
import { openTestDatabase } from "./database.js";
import type { DB } from "@db/index.js";
import {
  bindPluginStorage,
  installPluginStorage,
  removePluginStorage,
  cleanupPluginObjects,
} from "@server/services/plugin-storage.js";
import { createHostFileStore } from "@server/services/host-file-store.js";
import { storageRuntime } from "@server/adapters/storage.js";
import { scopeInstalledPlugin } from "@server/plugins/scope.js";
import { createSchema, CURRENT_SCHEMA_BASELINE } from "@db/create-schema.js";
import { openDatabase } from "@db/connection.js";
const dbs: DB[] = [],
  dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dbs.splice(0).map((d) => d.destroy()));
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});
async function fixture() {
  const db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  dbs.push(db);
  const root = await mkdtemp(join(tmpdir(), "doca-managed-storage-"));
  dirs.push(root);
  const files = createHostFileStore({ ...storageRuntime(), root });
  await db
    .transaction()
    .execute((tx) => installPluginStorage(tx, "example.a-b", "1"));
  await db
    .transaction()
    .execute((tx) => installPluginStorage(tx, "example.a.b", "1"));
  return {
    db,
    files,
    root,
    a: await bindPluginStorage(db, files, "example.a-b", "1"),
    b: await bindPluginStorage(db, files, "example.a.b", "1"),
  };
}
const schema: PluginDatabaseSchema = {
  version: 1,
  tables: {
    notes: {
      columns: {
        id: { type: "text", nullable: false },
        text: { type: "text", nullable: false },
        score: { type: "integer", nullable: true },
      },
      primaryKey: ["id"],
      unique: [],
    },
  },
};
it("isolates relational data for colliding-looking IDs and another instance verifies the same schema", async () => {
  const { db, files, a, b } = await fixture();
  await a.database.defineSchema(schema);
  await b.database.defineSchema(schema);
  await a.database.insert("notes", [{ id: "same", text: "A", score: null }]);
  await b.database.insert("notes", [{ id: "same", text: "B", score: 7 }]);
  const second = await bindPluginStorage(db, files, "example.a-b", "1");
  await second.database.defineSchema(schema);
  expect(await second.database.select("notes")).toEqual([
    { id: "same", text: "A", score: null },
  ]);
  expect(await b.database.select("notes")).toEqual([
    { id: "same", text: "B", score: 7 },
  ]);
  expect(
    await a.database.update("notes", { text: "changed" }, [
      { column: "id", operator: "=", value: "same" },
    ]),
  ).toBe(1);
  expect(
    await a.database.remove("notes", [
      { column: "id", operator: "=", value: "same" },
    ]),
  ).toBe(1);
  expect(await b.database.select("notes")).toHaveLength(1);
});
it("rejects undeclared tables, schema changes, host SQL inputs and invalid values without leaking host query text", async () => {
  const { a } = await fixture();
  await a.database.defineSchema(schema);
  await expect(a.database.select("users")).rejects.toMatchObject({
    code: "invalid-input",
  });
  await expect(
    a.database.select("notes; drop table users"),
  ).rejects.toMatchObject({ code: "invalid-input" });
  await expect(
    a.database.insert("notes", [{ id: "one", text: "A", score: 2147483648 }]),
  ).rejects.toMatchObject({ code: "invalid-input" });
  await expect(
    a.database.insert("notes", [
      { id: "one", text: "A", score: null, unknown: "extra" },
    ]),
  ).rejects.toMatchObject({ code: "invalid-input" });
  await expect(
    a.database.update("notes", { text: "all" }, []),
  ).rejects.toMatchObject({ code: "invalid-input" });
  await expect(
    a.database.defineSchema({ ...schema, version: 2 } as any),
  ).rejects.toMatchObject({ code: "invalid-input" });
  const changed = structuredClone(schema) as any;
  changed.tables.notes.columns.extra = { type: "text", nullable: true };
  await expect(a.database.defineSchema(changed)).rejects.toMatchObject({
    code: "conflict",
  });
  await a.database.insert("notes", [{ id: "one", text: "A", score: null }]);
  await expect(
    a.database.insert("notes", [{ id: "one", text: "B", score: null }]),
  ).rejects.toMatchObject({
    code: "conflict",
    message: "Plugin storage operation failed",
  });
});
it("rolls transactions back, invokes user callbacks once and expires retained handles", async () => {
  const { a } = await fixture();
  await a.database.defineSchema(schema);
  let retained!: PluginDatabaseTransaction,
    calls = 0;
  await expect(
    a.database.transaction(async (tx) => {
      calls++;
      retained = tx;
      await tx.insert("notes", [{ id: "one", text: "A", score: null }]);
      throw new Error("business failure");
    }),
  ).rejects.toMatchObject({ code: "unavailable" });
  expect(calls).toBe(1);
  expect(await a.database.select("notes")).toEqual([]);
  await expect(retained.select("notes")).rejects.toMatchObject({
    code: "unavailable",
  });
});
it("refuses implicit empty schema repair after business tables are lost", async () => {
  const { db, files, a } = await fixture();
  await a.database.defineSchema(schema);
  const table = (await currentSchemaTables(db)).find(
    (t) =>
      /^plugin_[a-f0-9]{56}$/.test(t.name) && t.columns.some((c) => c.name === "score"),
  )!;
  await db.schema.dropTable(table.name).execute();
  const restarted = await bindPluginStorage(db, files, "example.a-b", "1");
  await expect(restarted.database.defineSchema(schema)).rejects.toMatchObject({
    code: "unavailable",
    message: "Plugin database structure is incomplete",
  });
});
it("stores opaque private objects under plugin prefixes, verifies bytes and forbids cross-plugin reads", async () => {
  const { db, files, root, a, b } = await fixture();
  const obj = await a.objects.put({
    data: new TextEncoder().encode("private"),
    mime: "application/octet-stream",
  });
  expect((await a.objects.get(obj.id))?.data).toEqual(
    new TextEncoder().encode("private"),
  );
  expect(await b.objects.get(obj.id)).toBeNull();
  const row = await db
    .selectFrom("plugin_private_objects")
    .selectAll()
    .executeTakeFirstOrThrow();
  expect(row.object_key).toMatch(/^plugins\/example.a-b\/objects\/1\//);
  expect(row.object_key).not.toContain("private");
  expect((await readFile(join(root, row.object_key))).toString()).toBe(
    "private",
  );
  await expect(a.objects.get("../example.a.b/object")).rejects.toMatchObject({
    code: "invalid-input",
  });
  await a.objects.remove(obj.id);
  expect(await a.objects.get(obj.id)).toBeNull();
  expect(
    await db.selectFrom("plugin_object_garbage").selectAll().execute(),
  ).toEqual([]);
  expect(await cleanupPluginObjects(db, files)).toEqual({
    processed: 0,
    failed: 0,
  });
});
it("fences stale handles on uninstall and creates a distinct generation on explicit reinstall", async () => {
  const { db, files, a } = await fixture();
  await a.database.defineSchema(schema);
  await a.database.insert("notes", [{ id: "one", text: "A", score: null }]);
  const obj = await a.objects.put({
    data: new Uint8Array([1]),
    mime: "application/octet-stream",
  });
  await db
    .transaction()
    .execute((tx) => removePluginStorage(tx, "example.a-b"));
  await expect(
    a.database.insert("notes", [{ id: "late", text: "late", score: null }]),
  ).rejects.toMatchObject({ code: "unavailable" });
  await expect(a.objects.get(obj.id)).rejects.toMatchObject({
    code: "unavailable",
  });
  await expect(
    a.objects.put({
      data: new Uint8Array([2]),
      mime: "application/octet-stream",
    }),
  ).rejects.toMatchObject({ code: "unavailable" });
  expect(await cleanupPluginObjects(db, files)).toEqual({
    processed: 1,
    failed: 0,
  });
  await db
    .transaction()
    .execute((tx) => installPluginStorage(tx, "example.a-b", "2"));
  const newServices = await bindPluginStorage(db, files, "example.a-b", "2");
  await newServices.database.defineSchema(schema);
  expect(await newServices.database.select("notes")).toEqual([]);
  await expect(a.database.select("notes")).rejects.toMatchObject({
    code: "unavailable",
  });
});
it("binds scoped tokens through child contexts and rejects a spoofed host service", async () => {
  const { a } = await fixture(),
    root = new Context("test");
  const plugin = scopeInstalledPlugin(
    definePlugin({
      manifest: {
        schemaVersion: 1,
        id: "example.a-b",
        version: "1.0.0",
        displayName: "A",
      },
      async initialize(ctx) {
        expect(ctx.inject(pluginDatabaseToken)).toBe(a.database);
        expect(ctx.child().inject(pluginObjectStorageToken)).toBe(a.objects);
        expect(() => ctx.child().inject({ id: "doca.server.runtime" })).toThrow(
          "Private host service",
        );
      },
    }),
    a,
  );
  const scope = new PluginContext(
    root,
    plugin.manifest,
    {},
    new ContributionStore().forContext(root, plugin.manifest.id),
  );
  try {
    await plugin.initialize!(scope);
  } finally {
    await root.dispose();
  }
});
it("uses conditional S3 archive writes and reads back the checksum before publishing", async () => {
  const content = Buffer.from("complete bytes"),
    objects = new Map<string, Buffer>(),
    commands: any[] = [];
  const runtime = storageRuntime({
    DOCA_FILE_STORE_ID: "cloud",
    DOCA_FILE_STORES_JSON: JSON.stringify({
      version: 1,
      stores: {
        cloud: {
          provider: "s3",
          bucket: "test-doca",
          region: "us-east-1",
          forcePathStyle: false,
          credentials: { accessKeyId: "test", secretAccessKey: "secret" },
        },
      },
    }),
  });
  vi.spyOn(S3Client.prototype, "send").mockImplementation((async (
    command: any,
  ) => {
    commands.push(command);
    if (command instanceof PutObjectCommand) {
      if (objects.has(command.input.Key!))
        throw { $metadata: { httpStatusCode: 412 } };
      objects.set(
        command.input.Key!,
        Buffer.from(command.input.Body as Uint8Array),
      );
      return {};
    }
    if (command instanceof GetObjectCommand) {
      const { Readable } = await import("node:stream");
      return { Body: Readable.from([objects.get(command.input.Key!)!]) };
    }
    return {};
  }) as any);
  const files = createHostFileStore(runtime),
    hash = createHash("sha256").update(content).digest("hex"),
    key = `host/plugin-releases/${hash}.zip`;
  await files.putImmutable(key, content, "application/zip");
  await files.putImmutable(key, content, "application/zip");
  expect(commands[0].input.IfNoneMatch).toBe("*");
  expect(objects.size).toBe(1);
  objects.set(key, Buffer.from("corrupt"));
  await expect(
    files.putImmutable(key, content, "application/zip"),
  ).rejects.toThrow();
});
it("rejects earlier baselines and partial new storage schemas without modifying data", async () => {
  const { db } = await fixture();
  await db
    .updateTable("schema_baseline")
    .set({ id: "doca-2026-09-27" })
    .where("id", "=", CURRENT_SCHEMA_BASELINE)
    .execute();
  await expect(createSchema(db)).rejects.toThrow("baseline is not supported");
  expect(
    await db.selectFrom("plugin_storage_namespaces").selectAll().execute(),
  ).toHaveLength(2);
  await db
    .updateTable("schema_baseline")
    .set({ id: CURRENT_SCHEMA_BASELINE })
    .where("id", "=", "doca-2026-09-27")
    .execute();
  await db.schema.dropTable("plugin_private_objects").execute();
  await expect(createSchema(db)).rejects.toThrow("incomplete or unsupported");
  expect(
    (await currentSchemaTables(db)).some(
      (t) => t.name === "plugin_private_objects",
    ),
  ).toBe(false);
});
it("shares relational data between independent database connections", async () => {
  const { db, files, a, root } = await fixture();
  const path = join(root, "separate.db");
  let first: DB, second: DB;
  if (process.env.DOCA_TEST_POSTGRES) {
    first = db;
    const { sql } = await import("kysely");
    const current = await sql<{
      name: string;
    }>`select current_schema() as name`.execute(db);
    const url = new URL(process.env.DOCA_TEST_POSTGRES);
    url.searchParams.set("options", "-csearch_path=" + current.rows[0]!.name);
    second = await openDatabase({ driver: "postgres", url: url.href });
    dbs.push(second);
  } else {
    first = await openDatabase({ driver: "sqlite", path });
    dbs.push(first);
    second = await openDatabase({ driver: "sqlite", path });
    dbs.push(second);
  }
  await first
    .transaction()
    .execute((tx) => installPluginStorage(tx, "example.shared", "1"));
  const left = await bindPluginStorage(first, files, "example.shared", "1"),
    right = await bindPluginStorage(second, files, "example.shared", "1");
  await left.database.defineSchema(schema);
  await right.database.defineSchema(schema);
  await left.database.insert("notes", [
    { id: "one", text: "shared", score: 1 },
  ]);
  expect(await right.database.select("notes")).toEqual([
    { id: "one", text: "shared", score: 1 },
  ]);
});

it("rejects altered physical column types and nullability without recreating data", async () => {
  const { db, a } = await fixture();
  await a.database.defineSchema(schema);
  const table = (await currentSchemaTables(db)).find((t) =>
    /^plugin_[a-f0-9]{56}$/.test(t.name),
  )!;
  await db.schema.dropTable(table.name).execute();
  await db.schema
    .createTable(table.name)
    .addColumn("id", "text", (c) => c.notNull())
    .addColumn("text", "text", (c) => c.notNull())
    .addColumn("score", "text", (c) => c.notNull())
    .addPrimaryKeyConstraint("altered_pk", ["id"])
    .execute();
  await expect(a.database.defineSchema(schema)).rejects.toThrow(
    "structure is incomplete",
  );
  const changed = (await currentSchemaTables(db)).find(
    (t) => t.name === table.name,
  )!;
  expect(
    changed.columns.find((c) => c.name === "score")!.dataType.toLowerCase(),
  ).toBe("text");
});
