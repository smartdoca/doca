import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { sql } from "kysely";
import { openTestDatabase } from "./database.js";
import { openDatabase } from "@db/connection.js";
import type { DB } from "@db/index.js";
import { createSchema, CURRENT_SCHEMA_BASELINE } from "@db/create-schema.js";
import { currentSchemaTables } from "@db/introspection.js";
import {
  createCredentialCipher,
  type CredentialCipher,
} from "@server/services/credential-cipher.js";
import {
  bindPluginStorage,
  installPluginStorage,
  removePluginStorage,
} from "@server/services/plugin-storage.js";
import { verifyCredentialKey } from "@server/services/plugin-credentials.js";
import { createHostFileStore } from "@server/services/host-file-store.js";
import { storageRuntime } from "@server/adapters/storage.js";
import { scopeInstalledPlugin } from "@server/plugins/scope.js";
import { definePlugin } from "@smartdoca/plugin-sdk";
import { pluginCredentialToken } from "@smartdoca/plugin-sdk/storage";
import { runPluginContractHarness } from "@smartdoca/plugin-sdk/testing";

const dbs: DB[] = [],
  dirs: string[] = [],
  ciphers: CredentialCipher[] = [];
afterEach(async () => {
  ciphers.splice(0).forEach((c) => c.dispose());
  // Independent connections must close before the PostgreSQL fixture drops its schema.
  for (const db of dbs.splice(0).reverse()) await db.destroy();
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});
function cipher(key = randomBytes(32).toString("hex")) {
  const result = createCredentialCipher(key);
  ciphers.push(result);
  return result;
}
async function fixture() {
  const db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  dbs.push(db);
  const root = await mkdtemp(join(tmpdir(), "doca-credentials-"));
  dirs.push(root);
  const files = createHostFileStore({ ...storageRuntime(), root });
  const key = randomBytes(32).toString("hex"),
    encryption = cipher(key);
  for (const id of ["example.a-b", "example.a.b"])
    await db.transaction().execute((tx) => installPluginStorage(tx, id, "1"));
  const a = await bindPluginStorage(db, files, "example.a-b", "1", encryption);
  const b = await bindPluginStorage(db, files, "example.a.b", "1", encryption);
  return {
    db,
    root,
    files,
    key,
    encryption,
    a: a.credentials!,
    b: b.credentials!,
    storage: a,
  };
}

it("encrypts secrets at rest, exposes only metadata and isolates plugin identities", async () => {
  const { db, a, b } = await fixture();
  const value = '{"password":"never-log-secret","refreshToken":"秘密"}';
  const created = await a.create({ value });
  expect(Object.keys(created).sort()).toEqual([
    "createdAt",
    "id",
    "revision",
    "updatedAt",
  ]);
  expect(created.revision).toBe(1);
  expect(await a.inspect(created.id)).toEqual(created);
  expect(await a.get(created.id)).toEqual({ credential: created, value });
  const row = await db
    .selectFrom("plugin_credentials")
    .selectAll()
    .executeTakeFirstOrThrow();
  expect(row.namespace).toBe("plugin:example.a-b");
  expect(row.sealed).not.toContain("never-log-secret");
  expect(row.sealed).not.toContain("秘密");
  expect(await b.get(created.id)).toBeNull();
  expect(await b.inspect(created.id)).toBeNull();
  await expect(
    b.update({ id: created.id, value: "other", expectedRevision: 1 }),
  ).rejects.toMatchObject({ code: "unavailable" });
  await b.remove({ id: created.id, expectedRevision: 1 });
  expect((await a.get(created.id))?.value).toBe(value);
});

it("refreshes with compare-and-swap and refuses stale deletion", async () => {
  const { a } = await fixture();
  const original = await a.create({ value: "old" });
  const results = await Promise.allSettled(
    ["refresh-a", "refresh-b"].map((value) =>
      a.update({ id: original.id, value, expectedRevision: 1 }),
    ),
  );
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(results.find((r) => r.status === "rejected")).toMatchObject({
    reason: { code: "conflict" },
  });
  const current = (await a.get(original.id))!;
  expect(current.credential.revision).toBe(2);
  expect(current.credential.createdAt).toBe(original.createdAt);
  await expect(
    a.remove({ id: original.id, expectedRevision: 1 }),
  ).rejects.toMatchObject({ code: "conflict" });
  await a.remove({ id: original.id, expectedRevision: 2 });
  await a.remove({ id: original.id, expectedRevision: 2 });
  expect(await a.get(original.id)).toBeNull();
});

it("rejects oversized, malformed or unversioned requests without leaking values", async () => {
  const { a } = await fixture();
  for (const value of ["", "汉".repeat(32768), "a".repeat(65537), "\ud800"])
    await expect(a.create({ value })).rejects.toMatchObject({
      code: "invalid-input",
      message: "Invalid plugin credential input",
    });
  for (const input of [{ value: "secret", pluginId: "host" }, { value: null }])
    await expect(a.create(input as any)).rejects.toMatchObject({
      code: "invalid-input",
    });
  for (const id of ["../host", "plugin:example.a.b", "password-secret"])
    await expect(a.get(id)).rejects.toMatchObject({ code: "invalid-input" });
  const max = await a.create({ value: "a".repeat(65536) });
  expect((await a.get(max.id))?.value).toHaveLength(65536);
  await expect(
    a.update({ id: max.id, value: "secret" } as any),
  ).rejects.toMatchObject({ code: "invalid-input" });
  await expect(
    a.remove({ id: max.id, expectedRevision: 0 }),
  ).rejects.toMatchObject({ code: "invalid-input" });
  expect(await a.get(randomUUID())).toBeNull();
});

it.each(["id", "revision", "plugin", "ciphertext"])(
  "authenticates %s and refuses to overwrite a corrupted credential",
  async (field) => {
    const { db, a, b } = await fixture();
    const left = await a.create({ value: "protected-secret" });
    const right = await a.create({ value: "other" });
    const foreign = await b.create({ value: "foreign" });
    const original = await db
      .selectFrom("plugin_credentials")
      .selectAll()
      .where("id", "=", left.id)
      .executeTakeFirstOrThrow();
    if (field === "revision")
      await db
        .updateTable("plugin_credentials")
        .set({ revision: 2 })
        .where("id", "=", left.id)
        .execute();
    else if (field === "ciphertext")
      await db
        .updateTable("plugin_credentials")
        .set({ sealed: "invalid-secret-json" })
        .where("id", "=", left.id)
        .execute();
    else
      await db
        .updateTable("plugin_credentials")
        .set({ sealed: original.sealed })
        .where("id", "=", field === "id" ? right.id : foreign.id)
        .execute();
    const service = field === "plugin" ? b : a;
    const id =
      field === "plugin" ? foreign.id : field === "id" ? right.id : left.id;
    await expect(service.get(id)).rejects.toMatchObject({
      code: "unavailable",
      message: "Plugin credential storage is unavailable",
    });
    await expect(
      service.update({
        id,
        value: "replacement",
        expectedRevision: field === "revision" ? 2 : 1,
      }),
    ).rejects.toMatchObject({ code: "unavailable" });
  },
);

it("rolls back failed uninstall, then deletes only the removed generation and fences all old handles", async () => {
  const { db, files, encryption, a, b } = await fixture();
  const left = await a.create({ value: "left" }),
    right = await b.create({ value: "right" });
  await expect(
    db.transaction().execute(async (tx) => {
      await removePluginStorage(tx, "example.a-b");
      throw Error("registry failure");
    }),
  ).rejects.toThrow("registry failure");
  expect((await a.get(left.id))?.value).toBe("left");
  await db
    .transaction()
    .execute((tx) => removePluginStorage(tx, "example.a-b"));
  for (const operation of [
    () => a.get(left.id),
    () => a.inspect(left.id),
    () => a.create({ value: "late" }),
    () => a.update({ id: left.id, value: "late", expectedRevision: 1 }),
    () => a.remove({ id: left.id, expectedRevision: 1 }),
  ])
    await expect(operation()).rejects.toMatchObject({ code: "unavailable" });
  expect((await b.get(right.id))?.value).toBe("right");
  expect(
    await db.selectFrom("plugin_credentials").selectAll().execute(),
  ).toHaveLength(1);
  expect(
    await db.selectFrom("plugin_credential_keys").selectAll().execute(),
  ).toHaveLength(1);
  await db
    .transaction()
    .execute((tx) => installPluginStorage(tx, "example.a-b", "1"));
  const reinstalled = (
    await bindPluginStorage(db, files, "example.a-b", "1", encryption)
  ).credentials!;
  expect(await reinstalled.get(left.id)).toBeNull();
  // A ciphertext copied into the new installation cannot be read there.
  const row = await db
    .selectFrom("plugin_credentials")
    .selectAll()
    .where("id", "=", right.id)
    .executeTakeFirstOrThrow();
  await db
    .insertInto("plugin_credentials")
    .values({
      ...row,
      plugin_id: "example.a-b",
      namespace: "plugin:example.a-b",
      generation: 2,
    })
    .execute();
  await expect(reinstalled.get(right.id)).rejects.toMatchObject({
    code: "unavailable",
  });
});

it("rejects a replacement host key even after the last plugin is removed", async () => {
  const { db, files, a } = await fixture();
  await a.create({ value: "retained" });
  const wrong = cipher();
  await expect(
    bindPluginStorage(db, files, "example.a-b", "1", wrong),
  ).rejects.toThrow("does not match credential storage");
  await db
    .transaction()
    .execute((tx) => removePluginStorage(tx, "example.a-b"));
  await db
    .transaction()
    .execute((tx) => removePluginStorage(tx, "example.a.b"));
  await expect(verifyCredentialKey(db, wrong)).rejects.toThrow(
    "retain the original key",
  );
});

it("binds credentials through child contexts and exposes missing-key status without a fake service", async () => {
  const { storage } = await fixture();
  const plugin = definePlugin({
    manifest: {
      schemaVersion: 1,
      id: "example.a-b",
      version: "1.0.0",
      displayName: "Credentials",
    },
    initialize(ctx) {
      expect(ctx.has(pluginCredentialToken)).toBe(true);
      expect(ctx.child().inject(pluginCredentialToken)).toBe(
        storage.credentials,
      );
    },
  });
  await runPluginContractHarness(scopeInstalledPlugin(plugin, storage));
  await runPluginContractHarness(
    scopeInstalledPlugin(
      definePlugin({
        ...plugin,
        initialize(ctx) {
          expect(ctx.has(pluginCredentialToken)).toBe(false);
          expect(
            ctx.child().injectOptional(pluginCredentialToken),
          ).toBeUndefined();
          expect(() => ctx.inject(pluginCredentialToken)).toThrow(
            "DOCA_CREDENTIAL_MASTER_KEY",
          );
        },
      }),
      { database: storage.database, objects: storage.objects },
    ),
  );
});

it("uses the configured database across independent host connections and cipher lifetimes", async () => {
  const { db, files, root, key } = await fixture();
  let first: DB, second: DB;
  if (process.env.DOCA_TEST_POSTGRES) {
    first = db;
    const current = await sql<{
      name: string;
    }>`select current_schema() as name`.execute(db);
    const url = new URL(process.env.DOCA_TEST_POSTGRES);
    url.searchParams.set("options", "-csearch_path=" + current.rows[0]!.name);
    second = await openDatabase({ driver: "postgres", url: url.href });
    dbs.push(second);
  } else {
    first = await openDatabase({
      driver: "sqlite",
      path: join(root, "shared.db"),
    });
    dbs.push(first);
    second = await openDatabase({
      driver: "sqlite",
      path: join(root, "shared.db"),
    });
    dbs.push(second);
  }
  await first
    .transaction()
    .execute((tx) => installPluginStorage(tx, "example.shared", "1"));
  const encryption = cipher(key);
  const a = (
    await bindPluginStorage(first, files, "example.shared", "1", encryption)
  ).credentials!;
  const b = (
    await bindPluginStorage(second, files, "example.shared", "1", cipher(key))
  ).credentials!;
  const created = await a.create({ value: "shared-secret" });
  encryption.dispose();
  expect((await b.get(created.id))?.value).toBe("shared-secret");
  expect(
    (
      await b.update({
        id: created.id,
        value: "refreshed",
        expectedRevision: 1,
      })
    ).revision,
  ).toBe(2);
});

it("rejects the 0.1.9 baseline and missing credential tables without repairing or deleting data", async () => {
  const { db, a } = await fixture();
  const created = await a.create({ value: "preserve" });
  await db
    .updateTable("schema_baseline")
    .set({ id: "doca-2026-10-03-storage-v1" })
    .where("id", "=", CURRENT_SCHEMA_BASELINE)
    .execute();
  await expect(createSchema(db)).rejects.toThrow("baseline is not supported");
  expect((await a.get(created.id))?.value).toBe("preserve");
  await db
    .updateTable("schema_baseline")
    .set({ id: CURRENT_SCHEMA_BASELINE })
    .where("id", "=", "doca-2026-10-03-storage-v1")
    .execute();
  await db.schema.dropTable("plugin_credentials").execute();
  await expect(createSchema(db)).rejects.toThrow("incomplete or unsupported");
  expect(
    (await currentSchemaTables(db)).some(
      (t) => t.name === "plugin_credentials",
    ),
  ).toBe(false);
});
